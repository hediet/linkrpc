import type { IRequestSender, SigningCallCtx, HubRpcInterfaceSchema } from '@vscode/hubrpc';
import { generateTsInterface } from '@vscode/hubrpc';
import { type DiscoveredListing, fetchSchema, walkHubDetailed } from '@vscode/hubrpc-client';

export interface ExploreArgs {
    readonly interfaceId?: string;
    readonly serviceId?: string;
    readonly includeSchema?: boolean;
    /**
     * Also emit a self-contained TypeScript module that re-creates the
     * interface via `defineInterface` (zod + hubrpc). Implies fetching
     * the schema, but you don't need to also set `includeSchema` unless
     * you want the raw JSON alongside. For LLM-facing calls, prefer returning
     * `result.entries[0].typeScript` directly so the surrounding response does
     * not consume the output budget.
     */
    readonly includeTypeScript?: boolean;
    /** Defaults to 10. Pass `0` for "no limit" (still capped by walk depth). */
    readonly maxResults?: number;
    /**
     * 0-based index into the filtered result set to start this page at. Combine
     * with `maxResults` (the page size) to page through a large hub: pass the
     * `nextOffset` from the previous result to fetch the following page.
     * Defaults to 0.
     */
    readonly offset?: number;
    /**
     * Include the reflection plumbing interfaces (`hubrpc.*` — e.g.
     * `hubrpc.directory`, `hubrpc.schemas`, `hubrpc.defaults`) in the results.
     * They exist on every service and rarely matter to a caller, so they are
     * hidden by default. Filtering by an exact `hubrpc.*` {@link interfaceId}
     * still shows it, regardless of this flag.
     */
    readonly showHubrpcInternalInterfaces?: boolean;
    /**
     * Case-insensitive substring filter over each listing's metadata —
     * `serviceId`, `interfaceId`, and the directory-provided `serviceDescription`.
     * Applied after the `serviceId` / `interfaceId` filters and before paging.
     * Cheap: uses only what the directory walk already returned (no schema
     * fetch). For a deeper search into method/param names use
     * {@link grepAllSchemas}.
     */
    readonly grep?: string;
    /**
     * Like {@link grep}, but also searches each interface's full JSON schema
     * (method names, param/result field names, descriptions). This requires
     * fetching the schema for every candidate interface, so it is markedly more
     * expensive than {@link grep} — prefer `grep` unless you specifically need
     * to match on schema internals. The fetched schemas are reused for
     * `includeSchema` / `includeTypeScript` output.
     */
    readonly grepAllSchemas?: string;
    /**
     * When `true`, gated sub-directories the walk hits (e.g. the `hub`
     * directory) are unlocked in-line: `explore` requests the minimal
     * `hubrpc.directory::list` capability for each and continues into it,
     * repeating for any newly-revealed gated branch. May trigger consent.
     * Default `false` — gated directories are instead reported under
     * {@link ExploreResult.inaccessible}.
     */
    readonly requestPermission?: boolean;
}

/**
 * Side-channel `explore` needs to honor {@link ExploreArgs.requestPermission}
 * without coupling the reflection layer to the hub's consent/session API.
 */
export interface ExploreDeps {
    /**
     * Request a capability for the reflection interfaces (`hubrpc.*`) across
     * all service ids — one grant that unlocks enumeration of every gated
     * directory. Returns `true` when granted (so the walk re-lists). Invoked
     * at most once per `explore` call.
     */
    requestReflectionAccess(): Promise<boolean>;
}

export interface ExploreEntry {
    readonly serviceId: string;
    readonly interfaceId: string;
    /** Present when {@link ExploreArgs.includeSchema} is true and the lookup succeeded. */
    readonly schema?: unknown;
    /** Set when `includeSchema` was requested but the lookup failed. */
    readonly schemaError?: string;
    /** Present when {@link ExploreArgs.includeTypeScript} is true and codegen succeeded. */
    readonly typeScript?: string;
    /** Set when `includeTypeScript` was requested but codegen failed. */
    readonly typeScriptError?: string;
}

export interface ExploreResult {
    readonly totalMatched: number;
    /** Up to `maxResults` entries, starting at `offset`. */
    readonly entries: readonly ExploreEntry[];
    /** 0-based index this page starts at (echoes the requested `offset`). */
    readonly offset: number;
    /**
     * Index to pass as `offset` to fetch the next page. Present only when more
     * matches remain beyond this page.
     */
    readonly nextOffset?: number;
    /**
     * Directories that exist but could not be enumerated without an additional
     * capability (e.g. the gated `hub` directory). Their services are absent
     * from `entries`. Present only when at least one directory was gated.
     */
    readonly inaccessible?: readonly ExploreInaccessible[];
}

export interface ExploreInaccessible {
    /** The directory target (serviceId) that could not be enumerated. */
    readonly serviceId: string;
    /** The error message from the denied directory lookup. */
    readonly reason: string;
    /** Actionable next step to gain visibility into this directory. */
    readonly hint: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K]; };

const DEFAULT_MAX_RESULTS = 10;

/**
 * Walk the hub, optionally filter, optionally enrich with per-interface JSON
 * schemas. Used by both the `runHubRpcScript` host function (`con.explore(...)`)
 * and exposed indirectly through the MCP server's connection-API resource.
 *
 * Pass `deps` to honor {@link ExploreArgs.requestPermission}: gated directories
 * are unlocked via `deps.requestDirectoryListAccess` and folded into the walk.
 * Without `deps`, `requestPermission` is a no-op and gated directories are
 * reported under {@link ExploreResult.inaccessible}.
 */
export async function explore(
    channel: IRequestSender<SigningCallCtx>,
    args: ExploreArgs,
    deps?: ExploreDeps,
): Promise<ExploreResult> {
    const unlockGatedDirectory =
        args.requestPermission === true && deps !== undefined
            ? (_serviceId: string) => deps.requestReflectionAccess()
            : undefined;
    const { listings, inaccessible } = await walkHubDetailed(channel, { unlockGatedDirectory });

    // Reflection plumbing (`hubrpc.*`) exists on every service and clutters the
    // listing, so it is hidden unless explicitly asked for — either via
    // `showHubrpcInternalInterfaces`, or by filtering for that exact interfaceId
    // (hiding a directly-requested interface would surprisingly return nothing).
    const showInternal = args.showHubrpcInternalInterfaces === true
        || (args.interfaceId !== undefined && _isHubrpcInternalInterface(args.interfaceId));

    const filtered = listings.filter((l) => {
        if (args.interfaceId !== undefined && l.interfaceId !== args.interfaceId) return false;
        if (args.serviceId !== undefined && l.serviceId !== args.serviceId) return false;
        if (!showInternal && _isHubrpcInternalInterface(l.interfaceId)) return false;
        return true;
    });

    // Schemas fetched during grepAllSchemas are cached here so the entry-building
    // pass (includeSchema / includeTypeScript) reuses them instead of re-fetching.
    const schemaCache = new Map<DiscoveredListing, FetchedSchema>();

    // `grep` is a cheap metadata search (serviceId / interfaceId /
    // serviceDescription). `grepAllSchemas` additionally searches the fetched
    // JSON schema, so it must pull every candidate's schema first.
    let matched = filtered;
    if (args.grep !== undefined && args.grep !== "") {
        const needle = args.grep.toLowerCase();
        matched = matched.filter((l) => _listingMetadataText(l).includes(needle));
    }
    if (args.grepAllSchemas !== undefined && args.grepAllSchemas !== "") {
        const needle = args.grepAllSchemas.toLowerCase();
        const fetched = await Promise.all(matched.map((l) => _safeFetchSchema(channel, l)));
        const next: DiscoveredListing[] = [];
        for (let i = 0; i < matched.length; i++) {
            const l = matched[i];
            schemaCache.set(l, fetched[i]);
            const schemaText = fetched[i].schema !== undefined
                ? JSON.stringify(fetched[i].schema).toLowerCase()
                : "";
            if (_listingMetadataText(l).includes(needle) || schemaText.includes(needle)) {
                next.push(l);
            }
        }
        matched = next;
    }

    // Page over the matched set: `offset` is where this page starts, `maxResults`
    // is the page size (default 10, `0` = no limit). `nextOffset` is set when more
    // matches remain, so the caller can request the following page.
    const offset = Math.max(0, args.offset ?? 0);
    const pageSize = args.maxResults === 0
        ? matched.length
        : args.maxResults ?? DEFAULT_MAX_RESULTS;
    const head = matched.slice(offset, offset + pageSize);
    const nextOffset = offset + head.length < matched.length
        ? offset + head.length
        : undefined;

    const entries: ExploreEntry[] = [];
    const needsSchema = args.includeSchema === true || args.includeTypeScript === true;
    if (needsSchema) {
        const fetched = await Promise.all(
            head.map((l) => schemaCache.get(l) ?? _safeFetchSchema(channel, l)),
        );
        for (let i = 0; i < head.length; i++) {
            const { schema, schemaError } = fetched[i];
            const entry: Mutable<ExploreEntry> = {
                serviceId: head[i].serviceId,
                interfaceId: head[i].interfaceId,
            };
            if (args.includeSchema) {
                if (schema !== undefined) entry.schema = schema;
                if (schemaError !== undefined) entry.schemaError = schemaError;
            }
            if (args.includeTypeScript) {
                if (schema !== undefined) {
                    try {
                        entry.typeScript = generateTsInterface(schema);
                    } catch (e) {
                        entry.typeScriptError = (e as Error).message;
                    }
                } else if (schemaError !== undefined) {
                    entry.typeScriptError = schemaError;
                }
            }
            entries.push(entry);
        }
    } else {
        for (const l of head) {
            entries.push({ serviceId: l.serviceId, interfaceId: l.interfaceId });
        }
    }

    const result: Mutable<ExploreResult> = { totalMatched: matched.length, entries, offset };
    if (nextOffset !== undefined) result.nextOffset = nextOffset;
    if (inaccessible.length > 0) {
        result.inaccessible = inaccessible.map((d) => ({
            serviceId: d.serviceId,
            reason: d.reason,
            // Lead with the one-shot: re-running explore with
            // `requestPermission: true` requests reflection access (`hubrpc.*`)
            // across EVERY service in a single consent, unlocking all gated
            // directories at once — so the walk costs at most one prompt instead
            // of nagging per directory. The per-directory `requestAccess` is kept
            // as a fallback for when you only want to peek at this one branch.
            hint: `The "${d.serviceId}" directory is gated. To enumerate the whole hub in a `
                + `SINGLE consent prompt, re-run explore with requestPermission, e.g. `
                + `con.explore({ requestPermission: true }) — this unlocks every gated `
                + `directory at once. (To unlock just this one directory instead, request its `
                + `listing interface: con.requestAccess({ permissions: [{ target: { serviceId: `
                + `{ exact: "${d.serviceId}" }, interfaceId: { exact: "hubrpc.directory" }, `
                + `members: [{ exact: "list" }] }, canInvoke: true }], duration: "longLived" }).)`,
        }));
    }
    return result;
}

/**
 * Whether an interface is hub reflection plumbing (`hubrpc.directory`,
 * `hubrpc.schemas`, `hubrpc.defaults`, …). These are present on every service
 * and are hidden from `explore` results by default.
 */
function _isHubrpcInternalInterface(interfaceId: string): boolean {
    return interfaceId.startsWith('hubrpc.');
}

/** Lower-cased metadata blob a `grep` term is matched against. */
function _listingMetadataText(l: DiscoveredListing): string {
    return `${l.serviceId}\u0000${l.interfaceId}\u0000${l.serviceDescription ?? ''}`.toLowerCase();
}

type FetchedSchema = { schema?: HubRpcInterfaceSchema; schemaError?: string; };

async function _safeFetchSchema(
    channel: IRequestSender<SigningCallCtx>,
    l: DiscoveredListing,
): Promise<FetchedSchema> {
    try {
        // Route the lookup to the directory that surfaced the listing — that
        // directory is the one that actually knows about the interface (the
        // hub forwards aggregated entries on behalf of participants).
        const target = l.discoveredFrom || l.serviceId || undefined;
        const schema = await fetchSchema(channel, l.interfaceId, undefined, target);
        return { schema };
    } catch (e) {
        return { schemaError: (e as Error).message };
    }
}
