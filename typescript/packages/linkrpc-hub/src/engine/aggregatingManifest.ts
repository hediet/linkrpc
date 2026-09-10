/**
 * `AggregatingHubAccessManifest` — a `manifest* → manifest` combinator.
 *
 * It implements the same {@link IHubAccessManifest} surface the approver/UI
 * consumes, but backs it by **many** source manifests: a trusted *local* source
 * (the participant's own {@link HubAccessManifestHost}, reached over an in-memory
 * loopback) plus zero or more *remote* sources it discovers by scanning the hub
 * directory for `hubAccessManifest` interfaces. So the pipeline composes:
 *
 *   hubAccess ─(HubAccessManifestHost)→ manifest_local ─┐
 *   discovered ───────────────────────→ manifest_remote*┤─(aggregator)→ manifest → UI
 *
 * Two invariants make aggregation safe:
 *
 *  1. **Namespaced entry ids.** Each source's entryIds are prefixed with the
 *     source's `tag`, so the merged id space has no collisions and a `setCurrent`
 *     decision can be routed back to exactly the source that parked it.
 *
 *  2. **Origin is preserved only for trusted-local sources.** An entry's
 *     host-authored `origin` bag (e.g. `{ sourceTransportId }`) routes a *local*
 *     consent UI. A remote source's `origin` refers to a transport on *another*
 *     hub — passing it through as-if-local would let a remote address a local
 *     iframe. So `preserveOrigin` is opt-in per source (true for the local
 *     loopback, false for everything discovered); a stripped entry has no
 *     `sourceTransportId`, so the UI falls back to its panel — correct by
 *     construction.
 *
 * Discovery + reads happen over the caller-supplied connection; reaching a
 * remote `hubAccessManifest::{getDesired,setCurrent}` is a forwarded (form-3)
 * call, so that connection must carry an admin-rooted **capability** for
 * `*::hubAccessManifest::*` (and the directory) — without it the gate rejects the
 * scan. This is the aggregator's whole reason to hold the approver's identity.
 */
import {
    DEFAULT_RPC_TIMEOUT_MS,
    type LinkRpcConnection,
    withRpcTimeout,
} from '@hediet/linkrpc';
import { hubAccessManifestInterface, type IHubAccessManifest } from '@hediet/linkrpc/hub/common';
import { safeParse } from 'zod/v4/core';

/** The declared result schema for `hubAccessManifest::getDesired` — used to validate each source. */
const GET_DESIRED_RESULT_SCHEMA = hubAccessManifestInterface.members.getDesired.resultSchema;

/** The `{ requested, revision }` document `hubAccessManifest::getDesired` returns. */
type GetDesiredResult = Awaited<ReturnType<IHubAccessManifest['getDesired']>>;
/** One desired entry (a `discover | direct` manifest request). Treated opaquely except `origin`. */
type ManifestEntry = GetDesiredResult['requested'][string];
/** A single `hubAccessManifest::setCurrent` patch. */
type ManifestPatch = Parameters<IHubAccessManifest['setCurrent']>[0]['patches'][number];

/** A manifest the aggregator merges, tagged and origin-policied. */
export interface AggregatorSource {
    /**
     * Stable id that namespaces this source's entryIds in the merged document
     * (and routes `setCurrent` back). For a discovered source, its serviceId.
     */
    readonly tag: string;
    /** The source manifest client. */
    readonly manifest: IHubAccessManifest;
    /**
     * Pass each entry's `origin` bag through verbatim (true) or strip it
     * (false, default). Set true ONLY for a trusted-local source whose
     * `sourceTransportId` addresses a local UI; a remote source's origin must be
     * stripped so it can never address a local iframe.
     */
    readonly preserveOrigin?: boolean;
}

export interface AggregatingManifestOptions {
    /**
     * Resolve the current set of source manifests (the local loopback plus
     * whatever the caller discovers by scanning the hub). Re-invoked on every
     * {@link AggregatingHubAccessManifest.getDesired}, so newly-appeared sources
     * are picked up.
     */
    readonly resolveSources: () => Promise<readonly AggregatorSource[]> | readonly AggregatorSource[];
    /**
     * Optional: subscribe to "the *set* of sources may have changed" — e.g. the
     * hub's `hubrpc.directory::watch`, which ticks when a service appears or
     * disappears. Each tick re-emits a change (so a watching approver re-`getDesired`,
     * which re-runs {@link resolveSources} and discovers the new/removed source).
     * Without it, a brand-new manifest is only noticed when some *already-known*
     * source ticks or the approver polls. Returns a teardown.
     */
    readonly watchSources?: (onChange: () => void) => () => void;
    /** Human log sink. */
    readonly log?: (line: string) => void;
    /** Hard deadline for each source request. Defaults to 5 seconds. */
    readonly timeoutMs?: number;
}

/** Delimiter between a source `tag` and the source-local entryId. Absent from serviceIds/UUIDs. */
const SEP = '\u0000';

export class AggregatingHubAccessManifest {
    private readonly _listeners = new Set<() => void>();
    private _revision = 0;
    /** tag → source, refreshed on every {@link _refresh}. Used to route `setCurrent`. */
    private _byTag = new Map<string, AggregatorSource>();
    /** tag → resilient watch for that exact source incarnation. */
    private readonly _watches = new Map<string, SourceWatch>();
    /** Teardown for the source-set watch (e.g. directory watch), started lazily. */
    private _sourcesWatchOff: (() => void) | undefined;
    private _refreshPromise: Promise<readonly AggregatorSource[]> | undefined;
    private _disposed = false;

    constructor(private readonly _options: AggregatingManifestOptions) { }

    /** Fire whenever any source's desired set may have changed (drives `watchDesired`). */
    public onDidChange(cb: () => void): () => void {
        this._listeners.add(cb);
        // Watch the source *set* (directory) so newly-appeared manifests are
        // discovered, not just changes within already-known sources.
        if (this._options.watchSources !== undefined && this._sourcesWatchOff === undefined) {
            this._sourcesWatchOff = this._options.watchSources(() => {
                if (!this._disposed) this._emit();
            });
        }
        // Ensure per-source watches are live so their ticks propagate to `cb`.
        void this._refresh().catch(() => { /* refresh logs its own errors */ });
        return () => this._listeners.delete(cb);
    }

    private _emit(): void {
        this._revision++;
        for (const l of this._listeners) {
            try { l(); } catch { /* a listener throwing must not break the others */ }
        }
    }

    /** Resolve the source set, (un)subscribing watches to match, and cache it by tag. */
    private _refresh(): Promise<readonly AggregatorSource[]> {
        if (!this._refreshPromise) {
            this._refreshPromise = this._doRefresh().finally(() => {
                this._refreshPromise = undefined;
            });
        }
        return this._refreshPromise;
    }

    private async _doRefresh(): Promise<readonly AggregatorSource[]> {
        const sources = await this._options.resolveSources();
        const next = new Map(sources.map((s) => [s.tag, s] as const));
        for (const [tag, watch] of this._watches) {
            const nextSource = next.get(tag);
            if (!nextSource || nextSource.manifest !== watch.source.manifest) {
                this._closeWatch(watch);
                this._watches.delete(tag);
            }
        }
        this._byTag = next;
        for (const s of sources) {
            if (!this._watches.has(s.tag)) this._openWatch(s);
        }
        return sources;
    }

    private _openWatch(s: AggregatorSource): void {
        const watch: SourceWatch = { source: s };
        this._watches.set(s.tag, watch);
        this._startWatch(watch);
    }

    private _startWatch(watch: SourceWatch): void {
        if (this._disposed || this._watches.get(watch.source.tag) !== watch) return;
        try {
            const call = watch.source.manifest.watchDesired({}, {
                onMessage: () => { if (!this._disposed) this._emit(); },
            });
            watch.call = call;
            call.then(
                () => this._watchEnded(watch),
                () => this._watchEnded(watch),
            );
        } catch {
            // A source that can't be watched still contributes via getDesired.
            this._watchEnded(watch);
        }
    }

    private _watchEnded(watch: SourceWatch): void {
        if (this._disposed || this._watches.get(watch.source.tag) !== watch) return;
        watch.call = undefined;
        if (watch.retryTimer !== undefined) return;
        watch.retryTimer = setTimeout(() => {
            watch.retryTimer = undefined;
            if (this._disposed || this._watches.get(watch.source.tag) !== watch) return;
            this._startWatch(watch);
            this._emit();
        }, 250);
    }

    private _closeWatch(watch: SourceWatch): void {
        if (watch.retryTimer !== undefined) clearTimeout(watch.retryTimer);
        watch.retryTimer = undefined;
        const call = watch.call;
        watch.call = undefined;
        if (call) {
            void Promise.resolve(call.cancel('aggregator source removed')).catch(() => { /* closing */ });
        }
    }

    /** Merge every source's desired document into one, namespacing ids by source tag. */
    public async getDesired(): Promise<GetDesiredResult> {
        const sources = await this._refresh();
        const requested: Record<string, ManifestEntry> = {};
        for (const s of sources) {
            let doc: GetDesiredResult;
            try {
                doc = await withRpcTimeout(
                    s.manifest.getDesired({}),
                    `hubAccessManifest service '${s.tag || '<root>'}'`,
                    this._options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
                );
            } catch (e) {
                this._options.log?.(`aggregator: getDesired(${s.tag}) failed: ${(e as Error).message}`);
                continue;
            }
            // Result validation at the consumption boundary: `hubAccessManifest`
            // result schemas are compile-time only (the RPC layer validates
            // inbound params + streams, but returns results verbatim), so a
            // source that serves a malformed desired document (e.g. entries
            // missing their required `consumer`) would otherwise blow up deep in
            // the approver with an opaque `undefined` read. Fail loudly here:
            // name the bad source + the first issue, and skip it.
            const parsed = safeParse(GET_DESIRED_RESULT_SCHEMA, doc);
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                const where = issue?.path?.join('.') ?? '';
                this._options.log?.(
                    `aggregator: source '${s.tag}' returned an invalid hubAccessManifest::getDesired document; skipping. `
                    + `${issue?.message ?? 'schema mismatch'}${where ? ` (at ${where})` : ''}`,
                );
                continue;
            }
            for (const [id, entry] of Object.entries(parsed.data.requested)) {
                requested[encodeKey(s.tag, id)] = s.preserveOrigin ? entry : stripOrigin(entry);
            }
        }
        return { requested, revision: ++this._revision };
    }

    /** Route each decision patch back to the source that parked the entry. */
    public async setCurrent(patches: readonly ManifestPatch[]): Promise<void> {
        const bySource = new Map<string, ManifestPatch[]>();
        for (const p of patches) {
            const decoded = decodeCurrentPath(p.path);
            if (!decoded) continue; // whole-doc / malformed patch — nothing to route
            const list = bySource.get(decoded.tag) ?? [];
            list.push({ ...p, path: `/current/${escapePointer(decoded.innerId)}` });
            bySource.set(decoded.tag, list);
        }
        await Promise.all([...bySource].map(async ([tag, ps]) => {
            const src = this._byTag.get(tag);
            if (!src) {
                throw new Error(`aggregator: setCurrent for unknown source '${tag}'`);
            }
            await withRpcTimeout(
                src.manifest.setCurrent({ patches: ps }),
                `hubAccessManifest service '${tag || '<root>'}'`,
                this._options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
            );
        }));
    }

    public dispose(): void {
        this._disposed = true;
        for (const watch of this._watches.values()) this._closeWatch(watch);
        this._watches.clear();
        this._listeners.clear();
    }

}

interface SourceWatch {
    readonly source: AggregatorSource;
    call?: ReturnType<IHubAccessManifest['watchDesired']>;
    retryTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Serve an {@link AggregatingHubAccessManifest} over `connection` as an ordinary
 * `hubAccessManifest` — so an approver consumes it via
 * `connection.service(serviceId).get(hubAccessManifestInterface)` with no idea it
 * is an aggregate. `current` is never read back (decisions flow through
 * `setCurrent` to the sources), so `getCurrent`/`watchCurrent` are served empty.
 */
export function registerAggregatingManifest(
    connection: LinkRpcConnection<unknown>,
    aggregator: AggregatingHubAccessManifest,
    options: { readonly serviceId: string; },
): void {
    connection.register(hubAccessManifestInterface, {
        getDesired: () => aggregator.getDesired(),
        watchDesired: (_params, _ctx, stream) =>
            new Promise<Record<string, never>>((resolve) => {
                if (stream.signal.aborted) { resolve({}); return; }
                const off = aggregator.onDidChange(() => {
                    if (!stream.signal.aborted) stream.send({});
                });
                stream.signal.addEventListener('abort', () => { off(); resolve({}); }, { once: true });
            }),
        getCurrent: () => ({ current: {}, revision: 0 }),
        setCurrent: async (params) => { await aggregator.setCurrent(params.patches); return { revision: 0 }; },
        watchCurrent: (_params, _ctx, stream) =>
            new Promise<Record<string, never>>((resolve) => {
                stream.signal.addEventListener('abort', () => resolve({}), { once: true });
            }),
    }, { serviceId: options.serviceId });
}

function encodeKey(tag: string, innerId: string): string {
    return `${tag}${SEP}${innerId}`;
}

function decodeCurrentPath(path: string): { tag: string; innerId: string; } | undefined {
    const prefix = '/current/';
    if (!path.startsWith(prefix)) return undefined;
    const key = unescapePointer(path.slice(prefix.length));
    const i = key.indexOf(SEP);
    if (i < 0) return undefined;
    return { tag: key.slice(0, i), innerId: key.slice(i + 1) };
}

/** Drop the host-authored `origin` bag from a remote entry (see class docs). */
function stripOrigin(entry: ManifestEntry): ManifestEntry {
    if (entry.origin === undefined) return entry;
    const clone = { ...entry };
    delete clone.origin;
    return clone;
}

function escapePointer(segment: string): string {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointer(segment: string): string {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
