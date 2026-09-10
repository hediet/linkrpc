import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LinkRpcInterfaceSchema } from "@hediet/linkrpc";
import {
    DEFAULT_WALK_DEPTH,
    HubDirectoryExplorer,
    fetchSchema,
    type DiscoveredListing,
    type HubDirectoryGraphEvent,
    type HubDirectoryGraphSnapshot,
    type HubDirectoryNodeReport,
    type HubDirectoryGraphTarget,
    type InaccessibleDirectory,
    type ServiceListing,
    type WalkHubOptions,
} from "@hediet/linkrpc/hub/common";
import type { CliChannel } from "@hediet/linkrpc-client";
import { formatJson } from "../output";
import { createDisplayForest, type DisplayForestNode } from "./displayForest";
import { createJsonPatch, type JsonValue } from "./jsonPatch";
import { StateJsonlWriter } from "./stateJsonl";

export type LsFormat = "pretty" | "json" | "jsonl";

export interface LsOptions {
    readonly interfaceId?: string;
    readonly interfacePrefix?: string;
    readonly serviceId?: string;
    readonly servicePrefix?: string;
    readonly search?: string;
    readonly json?: boolean;
    readonly format?: LsFormat;
    readonly withMembers?: boolean;
    /** Write a complete topology and schema fixture instead of rendering the listing. */
    readonly dumpPath?: string;
    /** Write one RFC 6902 operation per line as exploration progresses. `-` writes to stdout. */
    readonly dumpPatchesPath?: string;
    /** Emit an initial value and subsequent RFC 6902 patches as a patch-log JSONL stream. */
    readonly stream?: boolean;
    /** Keep the explorer watches active until `stop` resolves. Implies `stream`. */
    readonly watch?: boolean;
    /** Destination for stdout-oriented streaming modes. */
    readonly emitLine?: (line: string) => void | Promise<void>;
    /** Destination for a complete repainting terminal frame. */
    readonly emitFrame?: (frame: string) => void | Promise<void>;
    /** Receives each reconstructable state before it is rendered or serialized. */
    readonly onState?: (state: LsState) => void;
    /** Resolves when a watched stream should stop. */
    readonly stop?: Promise<void>;
    /**
     * When listing the whole bus, how many `hubrpc.directory` follow-ups
     * to perform. Defaults to 5. Ignored when `serviceId` is set (then we
     * just list that one service).
     */
    readonly maxDepth?: number;
    /** Hard deadline for each directory request. Defaults to 5 seconds. */
    readonly timeoutMs?: number;
}

export interface LsState {
    readonly kind: "directory";
    readonly revision: number;
    readonly complete: boolean;
    readonly root: HubDirectoryNodeReport;
    readonly directories: readonly HubDirectoryNodeReport[];
    readonly listings: readonly DiscoveredListing[];
    readonly inaccessible: readonly InaccessibleDirectory[];
}

/**
 * Recursive bus walk: list the connection's directory, then for each
 * `hubrpc.directory` entry it surfaces on a service we haven't queried
 * yet, recurse. Bounded by `maxDepth`. Duplicates (same
 * `serviceId+interfaceId+hash`) are dropped.
 */
export async function lsCommand(channel: CliChannel, opts: LsOptions = {}): Promise<string> {
    validateLsOptions(opts);
    const legacyOutput = opts.format === undefined;
    if (opts.dumpPath !== undefined) {
        const dump = await createHubDump(channel, { maxDepth: opts.maxDepth });
        const dumpPath = path.resolve(opts.dumpPath);
        await mkdir(path.dirname(dumpPath), { recursive: true });
        await writeFile(dumpPath, `${formatJson(dump)}\n`, "utf8");
        return dumpSummary("Wrote", dumpPath, dump);
    }
    if (opts.dumpPatchesPath !== undefined) {
        return runStreamingLs(channel, opts);
    }
    if (legacyOutput && (opts.stream === true || opts.watch === true)) {
        return runStreamingLs(channel, opts);
    }
    const format = resolveLsFormat(opts);
    if (opts.format !== undefined || opts.watch === true) {
        return runStateLs(channel, opts, format);
    }

    const explorer = new HubDirectoryExplorer(channel, explorerOptions(opts));
    await explorer.explore();
    const state = createLsState(explorer.graphSnapshot, opts);
    explorer.dispose();
    const all = state.listings;
    const output = opts.withMembers
        ? await addMembers(channel, all, (listing) => listing.discoveredFrom)
        : all;
    if (format === "json") return formatJson(legacyOutput ? output : state);
    return renderTree(output, opts.interfaceId);
}

function validateLsOptions(opts: LsOptions): void {
    validateSearchExpression(opts.search, "ls");
    if (opts.format !== undefined && opts.withMembers === true) {
        throw new Error("--format cannot be combined with --with-members");
    }
    if (opts.dumpPath !== undefined) {
        if (
            opts.interfaceId !== undefined
            || opts.interfacePrefix !== undefined
            || opts.serviceId !== undefined
            || opts.servicePrefix !== undefined
            || opts.search !== undefined
            || opts.json === true
            || opts.format !== undefined
            || opts.withMembers === true
            || opts.stream === true
            || opts.watch === true
            || opts.dumpPatchesPath !== undefined
        ) {
            throw new Error(
                "--dump cannot be combined with filters, --with-members, --json, --format, "
                + "--stream, --watch, or --dump-patches",
            );
        }

    }
    if (opts.dumpPatchesPath !== undefined && (
        opts.interfaceId !== undefined
        || opts.interfacePrefix !== undefined
        || opts.serviceId !== undefined
        || opts.servicePrefix !== undefined
        || opts.search !== undefined
        || opts.json === true
        || opts.format !== undefined
        || opts.withMembers === true
        || opts.stream === true
    )) {
        throw new Error(
            "--dump-patches cannot be combined with filters, --with-members, --json, "
            + "--format, or --stream",
        );
    }
    if (
        opts.format === undefined
        && (opts.stream === true || opts.watch === true)
        && opts.withMembers === true
    ) {
        throw new Error("--stream/--watch already emit JSON and cannot include schema members");
    }
    if (opts.format === "jsonl" && opts.dumpPatchesPath === undefined) {
        if (opts.emitLine === undefined) {
            throw new Error("JSONL ls output requires an output sink");
        }
    }
    if (
        opts.watch === true
        && opts.format === "pretty"
        && opts.emitFrame === undefined
    ) {
        throw new Error("pretty ls watch requires a frame output sink");
    }
    if (opts.watch === true && opts.stop === undefined) {
        throw new Error("--watch requires a stop signal");
    }
}

function validateSearchExpression(search: string | undefined, command: string): void {
    if (search === undefined) return;
    try {
        new RegExp(search, "i");
    } catch (error) {
        throw new Error(
            `Invalid ${command} search regexp: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}

function explorerOptions(opts: LsOptions): WalkHubOptions {
    return {
        maxDepth: opts.serviceId === undefined
            ? opts.maxDepth ?? DEFAULT_WALK_DEPTH
            : 0,
        ...(opts.interfaceId !== undefined ? { interfaceId: opts.interfaceId } : {}),
        ...(opts.interfacePrefix !== undefined
            ? { interfaceIdPrefix: opts.interfacePrefix }
            : {}),
        ...(opts.serviceId !== undefined
            ? { rootTarget: opts.serviceId, serviceId: opts.serviceId }
            : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
}

function resolveLsFormat(opts: LsOptions): LsFormat {
    if (opts.format !== undefined) return opts.format;
    if (opts.stream === true) return "jsonl";
    if (opts.json === true) return "json";
    return "pretty";
}

async function runStateLs(
    channel: CliChannel,
    opts: LsOptions,
    format: LsFormat,
): Promise<string> {
    const explorer = new HubDirectoryExplorer(channel, explorerOptions(opts));
    const writer = format === "jsonl" ? new StateJsonlWriter(opts.emitLine!) : undefined;
    let state = createLsState(explorer.graphSnapshot, opts);
    let outputQueue = Promise.resolve();
    const emitState = (snapshot: HubDirectoryGraphSnapshot): void => {
        state = createLsState(snapshot, opts);
        opts.onState?.(state);
        if (writer !== undefined) {
            writer.write(state, state.revision);
        } else if (opts.watch === true && format === "pretty") {
            const frame = renderLsState(state, opts);
            outputQueue = outputQueue.then(() => opts.emitFrame!(frame));
        }
    };
    const unsubscribe = explorer.subscribe((event) => emitState(event.snapshot));
    let stopWatch: (() => void) | undefined;
    try {
        if (opts.watch === true) {
            stopWatch = await explorer.watch(() => {});
            await opts.stop;
            stopWatch();
            stopWatch = undefined;
            await explorer.whenIdle();
            emitState(explorer.graphSnapshot);
        } else {
            await explorer.explore();
            emitState(explorer.graphSnapshot);
        }
        await outputQueue;
        await writer?.whenIdle();
        if (format === "json") return formatJson(state);
        if (format === "pretty") return opts.watch === true ? "" : renderLsState(state, opts);
        return "";
    } finally {
        stopWatch?.();
        unsubscribe();
        explorer.dispose();
        await outputQueue;
        await writer?.whenIdle();
    }
}

export function createLsState(
    snapshot: HubDirectoryGraphSnapshot,
    opts: Pick<
        LsOptions,
        "interfaceId" | "interfacePrefix" | "serviceId" | "servicePrefix" | "search"
    > = {},
): LsState {
    const matches = createListingFilter(opts);
    const mapNode = (node: HubDirectoryNodeReport): HubDirectoryNodeReport => ({
        ...node,
        nativeListings: node.nativeListings.filter(matches),
    });
    return {
        kind: "directory",
        revision: snapshot.revision,
        complete: snapshot.complete,
        root: mapNode(snapshot.root),
        directories: snapshot.directories.map(mapNode),
        listings: snapshot.result.listings.filter(matches),
        inaccessible: snapshot.result.inaccessible,
    };
}

function createListingFilter(
    opts: Pick<
        LsOptions,
        "interfaceId" | "interfacePrefix" | "serviceId" | "servicePrefix" | "search"
    >,
): (listing: ServiceListing) => boolean {
    let search: RegExp | undefined;
    if (opts.search !== undefined) {
        try {
            search = new RegExp(opts.search, "i");
        } catch (error) {
            throw new Error(
                `Invalid ls search regexp: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    return (listing) =>
        (opts.interfaceId === undefined || listing.interfaceId === opts.interfaceId)
        && (opts.interfacePrefix === undefined
            || listing.interfaceId.startsWith(opts.interfacePrefix))
        && (opts.serviceId === undefined || listing.serviceId === opts.serviceId)
        && (opts.servicePrefix === undefined
            || listing.serviceId.startsWith(opts.servicePrefix))
        && (search === undefined || search.test(JSON.stringify(listing)));
}

function renderLsState(state: LsState, opts: Pick<LsOptions, "interfaceId">): string {
    const status = state.complete ? "complete" : "loading";
    const nodes = [state.root, ...state.directories];
    const edges: DirectoryDisplayEdge[] = [];
    for (const node of nodes) {
        for (const parent of node.parents) {
            edges.push({
                from: directoryTargetKey(parent.target),
                to: directoryTargetKey(node.target),
                scopes: parent.scopes.map((scope) =>
                    "exact" in scope ? `=${scope.exact}` : `${scope.prefix}*`),
            });
        }
    }
    const forest = createDisplayForest({
        nodes,
        edges,
        rootIds: [directoryTargetKey(state.root.target)],
        nodeId: (node) => directoryTargetKey(node.target),
        edgeKey: (edge) => `${edge.from}\0${edge.to}\0${edge.scopes.join("\0")}`,
        edgeEndpoints: (edge) => [edge.from, edge.to],
        directed: true,
    });
    const body: string[] = [];
    for (const root of forest.roots) renderDirectoryNode(root, body, "");
    if (forest.crossEdges.length > 0) {
        body.push("", "Additional referrals");
        for (const edge of forest.crossEdges) {
            body.push(`  ${edge.from} → ${edge.to}${formatScopes(edge.scopes)}`);
        }
    }
    if (state.inaccessible.length > 0) {
        body.push("", "Inaccessible");
        for (const item of state.inaccessible) {
            body.push(`  ${item.serviceId}: ${item.reason}`);
        }
    }
    return [
        `LinkRPC directory (${status}, revision ${state.revision})`,
        "",
        ...(body.length > 0 ? body : ["(empty)"]),
    ].join("\n");
}

interface DirectoryDisplayEdge {
    readonly from: string;
    readonly to: string;
    readonly scopes: readonly string[];
}

function renderDirectoryNode(
    item: DisplayForestNode<HubDirectoryNodeReport, DirectoryDisplayEdge>,
    lines: string[],
    prefix: string,
): void {
    const watch = item.node.watching ? ", watching" : "";
    lines.push(
        `${prefix}${directoryTargetLabel(item.node.target)} [${item.node.state}${watch}]`
        + (item.parentEdge === undefined ? "" : formatScopes(item.parentEdge.scopes)),
    );
    for (const listing of item.node.nativeListings) {
        const service = listing.serviceId === "" ? "(root)" : listing.serviceId;
        lines.push(`${prefix}  ${service} → ${listing.interfaceId} @ ${listing.hash}`);
    }
    if (item.node.inaccessibleReason !== undefined) {
        lines.push(`${prefix}  ! ${item.node.inaccessibleReason}`);
    }
    for (let index = 0; index < item.children.length; index++) {
        const child = item.children[index];
        const last = index === item.children.length - 1;
        const childPrefix = prefix + (last ? "   " : "│  ");
        const childLines: string[] = [];
        renderDirectoryNode(child, childLines, childPrefix);
        childLines[0] = `${prefix}${last ? "└─ " : "├─ "}${childLines[0].slice(childPrefix.length)}`;
        lines.push(...childLines);
    }
}

function directoryTargetKey(target: HubDirectoryGraphTarget): string {
    return target.kind === "root"
        ? `root:${target.serviceId ?? ""}`
        : `service:${target.serviceId}`;
}

function directoryTargetLabel(target: HubDirectoryGraphTarget): string {
    if (target.kind === "addressed") return target.serviceId;
    return target.serviceId === undefined || target.serviceId === ""
        ? "(connection root)"
        : `(root listing for ${target.serviceId})`;
}

function formatScopes(scopes: readonly string[]): string {
    return scopes.length === 0 ? "" : ` via ${scopes.join(", ")}`;
}

interface LsMember {
    readonly name: string;
    readonly kind: "request" | "notification";
}

interface LsListing extends ServiceListing {
    readonly members?: readonly LsMember[];
}

async function addMembers<T extends ServiceListing>(
    channel: CliChannel,
    listings: readonly T[],
    getTarget: (listing: T) => string | undefined,
): Promise<LsListing[]> {
    const cache = new Map<string, Promise<readonly LsMember[]>>();
    return Promise.all(listings.map(async (listing) => {
        const target = getTarget(listing);
        const cacheKey = `${target ?? ""}\0${listing.interfaceId}\0${listing.hash}`;
        let members = cache.get(cacheKey);
        if (members === undefined) {
            members = fetchSchema(
                channel,
                listing.interfaceId,
                listing.hash,
                target === "" ? undefined : target,
            ).then((schema) =>
                Object.entries(schema.methods)
                    .map(([name, method]): LsMember => ({
                        name,
                        kind: method.result === undefined ? "notification" : "request",
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name))
            );
            cache.set(cacheKey, members);
        }
        return { ...listing, members: await members };
    }));
}

export interface HubDumpSchemaError {
    readonly interfaceIds: readonly string[];
    readonly attempts: readonly {
        readonly reportedBy: string;
        readonly interfaceId: string;
        readonly error: string;
    }[];
}

export interface HubDump {
    readonly format: "linkrpc-hub-dump";
    readonly version: 2;
    readonly revision: number;
    readonly complete: boolean;
    readonly schemasComplete: boolean;
    readonly root: HubDirectoryNodeReport;
    readonly directories: Readonly<Record<string, HubDirectoryNodeReport>>;
    readonly listings: readonly DiscoveredListing[];
    readonly inaccessible: readonly InaccessibleDirectory[];
    /** Complete reflected interface schemas, deduplicated by interface hash. */
    readonly schemas: Readonly<Record<string, LinkRpcInterfaceSchema>>;
    /** Hashes advertised by a directory but not retrievable from any reporter. */
    readonly schemaErrors: Readonly<Record<string, HubDumpSchemaError>>;
}

export function createInitialHubDump(): HubDump {
    return {
        format: "linkrpc-hub-dump",
        version: 2,
        revision: 0,
        complete: false,
        schemasComplete: false,
        root: {
            target: { kind: "root" },
            state: "unexplored",
            effectiveScopes: [{ prefix: "" }],
            depth: 0,
            parents: [],
            nativeListings: [],
            watching: false,
        },
        directories: {},
        listings: [],
        inaccessible: [],
        schemas: {},
        schemaErrors: {},
    };
}

export async function createHubDump(
    channel: CliChannel,
    opts: Pick<LsOptions, "maxDepth"> = {},
): Promise<HubDump> {
    const explorer = new HubDirectoryExplorer(channel, {
        maxDepth: opts.maxDepth ?? DEFAULT_WALK_DEPTH,
    });
    await explorer.explore();
    const cache = await fetchDumpSchemas(channel, explorer.graphSnapshot);
    const dump = buildHubDump(explorer.graphSnapshot, cache, true);
    explorer.dispose();
    return dump;
}

interface SchemaCandidate {
    readonly reportedBy: string;
    readonly target: string | undefined;
    readonly interfaceId: string;
}

interface DumpSchemaCache {
    readonly schemas: Map<string, LinkRpcInterfaceSchema>;
    readonly errors: Map<string, HubDumpSchemaError>;
}

async function fetchDumpSchemas(
    channel: CliChannel,
    snapshot: HubDirectoryGraphSnapshot,
    cache: DumpSchemaCache = { schemas: new Map(), errors: new Map() },
): Promise<DumpSchemaCache> {
    const candidatesByHash = collectSchemaCandidates(snapshot);
    for (const [hash, candidates] of candidatesByHash) {
        if (cache.schemas.has(hash)) continue;
        cache.errors.delete(hash);
        const attempts: { reportedBy: string; interfaceId: string; error: string; }[] = [];
        for (const candidate of candidates) {
            try {
                const schema = await fetchSchema(
                    channel,
                    candidate.interfaceId,
                    hash,
                    candidate.target,
                );
                cache.schemas.set(hash, schema);
                break;
            } catch (error) {
                attempts.push({
                    reportedBy: candidate.reportedBy,
                    interfaceId: candidate.interfaceId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (!cache.schemas.has(hash)) {
            cache.errors.set(hash, {
                interfaceIds: [...new Set(candidates.map((candidate) => candidate.interfaceId))],
                attempts,
            });
        }
    }
    return cache;
}

function buildHubDump(
    snapshot: HubDirectoryGraphSnapshot,
    cache: DumpSchemaCache,
    schemasComplete: boolean,
): HubDump {
    const directories = Object.fromEntries(snapshot.directories.map((directory) => [
        directory.target.kind === "addressed" ? directory.target.serviceId : "",
        directory,
    ]));
    const activeHashes = new Set(collectSchemaCandidates(snapshot).keys());
    for (const hash of [...cache.schemas.keys()]) {
        if (!activeHashes.has(hash)) cache.schemas.delete(hash);
    }
    for (const hash of [...cache.errors.keys()]) {
        if (!activeHashes.has(hash)) cache.errors.delete(hash);
    }
    return {
        format: "linkrpc-hub-dump",
        version: 2,
        revision: snapshot.revision,
        complete: snapshot.complete,
        schemasComplete,
        root: snapshot.root,
        directories,
        listings: snapshot.result.listings,
        inaccessible: snapshot.result.inaccessible,
        schemas: Object.fromEntries(cache.schemas),
        schemaErrors: Object.fromEntries(cache.errors),
    };
}

function collectSchemaCandidates(
    snapshot: HubDirectoryGraphSnapshot,
): Map<string, SchemaCandidate[]> {
    const result = new Map<string, SchemaCandidate[]>();
    for (const report of [snapshot.root, ...snapshot.directories]) {
        const target = report.target.serviceId;
        const reportedBy = target ?? "";
        for (const listing of report.nativeListings) {
            const candidates = result.get(listing.hash) ?? [];
            if (!candidates.some((candidate) =>
                candidate.reportedBy === reportedBy
                && candidate.interfaceId === listing.interfaceId
            )) {
                candidates.push({ reportedBy, target, interfaceId: listing.interfaceId });
                result.set(listing.hash, candidates);
            }
        }
    }
    return result;
}

async function runStreamingLs(channel: CliChannel, opts: LsOptions): Promise<string> {
    const explorer = new HubDirectoryExplorer(channel, explorerOptions(opts));
    const patchMode = opts.dumpPatchesPath !== undefined;
    const patchPath = patchMode && opts.dumpPatchesPath !== "-"
        ? path.resolve(opts.dumpPatchesPath)
        : undefined;
    if (patchPath !== undefined) await mkdir(path.dirname(patchPath), { recursive: true });
    const file = patchPath !== undefined ? await open(patchPath, "w") : undefined;
    const writeLine = file !== undefined
        ? async (line: string) => { await file.write(`${line}\n`); }
        : opts.emitLine;
    if (writeLine === undefined) {
        explorer.dispose();
        throw new Error("--dump-patches - requires an output sink");
    }

    let currentDump = createInitialHubDump();
    let previousListings: readonly DiscoveredListing[] = [];
    let previousStreamValue: LsStreamEvent | undefined;
    const schemaCache: DumpSchemaCache = { schemas: new Map(), errors: new Map() };
    let queue = Promise.resolve();
    const unsubscribe = explorer.subscribe((event) => {
        queue = queue.then(async () => {
            if (patchMode) {
                if (event.type === "settled") {
                    await fetchDumpSchemas(channel, event.snapshot, schemaCache);
                }
                const schemasComplete = event.snapshot.complete
                    && [...collectSchemaCandidates(event.snapshot).keys()].every((hash) =>
                        schemaCache.schemas.has(hash) || schemaCache.errors.has(hash));
                const next = buildHubDump(event.snapshot, schemaCache, schemasComplete);
                for (const operation of createJsonPatch(
                    toJsonValue(currentDump),
                    toJsonValue(next),
                )) {
                    await writeLine(JSON.stringify(operation));
                }
                currentDump = next;
            } else {
                const nextStreamValue = createLsStreamEvent(event, previousListings);
                await writeLine(JSON.stringify(createPatchLogLine(event, previousStreamValue, nextStreamValue)));
                previousListings = event.snapshot.result.listings;
                previousStreamValue = nextStreamValue;
            }
        });
    });

    let stopWatch: (() => void) | undefined;
    try {
        if (opts.watch === true) {
            stopWatch = await explorer.watch(() => {});
        } else {
            await explorer.explore();
        }
        await queue;
        if (opts.watch === true) {
            await opts.stop;
            stopWatch();
            stopWatch = undefined;
            await explorer.whenIdle();
            await queue;
        }
    } finally {
        stopWatch?.();
        unsubscribe();
        explorer.dispose();
        try {
            await queue;
        } finally {
            await file?.close();
        }
    }

    if (patchPath !== undefined) {
        return dumpSummary("Wrote patches to", patchPath, currentDump);
    }
    return "";
}

interface LsStreamEvent {
    readonly type: HubDirectoryGraphEvent["type"];
    readonly reason?: string;
    readonly revision: number;
    readonly complete: boolean;
    readonly target?: HubDirectoryNodeReport["target"];
    readonly state?: HubDirectoryNodeReport["state"];
    readonly added: readonly DiscoveredListing[];
    readonly removed: readonly DiscoveredListing[];
    readonly listings: readonly DiscoveredListing[];
    readonly inaccessible: readonly InaccessibleDirectory[];
}

type LsPatchLogLine =
    | {
        readonly message: string;
        readonly time: number;
        readonly value: LsStreamEvent;
    }
    | {
        readonly message: string;
        readonly time: number;
        readonly patch: ReturnType<typeof createJsonPatch>;
    };

function createPatchLogLine(
    event: HubDirectoryGraphEvent,
    previous: LsStreamEvent | undefined,
    next: LsStreamEvent,
): LsPatchLogLine {
    const metadata = {
        message: describeLsStreamEvent(event),
        time: Date.now(),
    };
    if (previous === undefined) {
        return { ...metadata, value: next };
    }
    return {
        ...metadata,
        patch: createJsonPatch(toJsonValue(previous), toJsonValue(next)),
    };
}

function describeLsStreamEvent(event: HubDirectoryGraphEvent): string {
    if (event.type === "settled") return "Directory exploration settled";
    const subject = event.type === "snapshot"
        ? "Directory snapshot"
        : event.type === "node-added"
            ? "Directory node added"
            : event.type === "node-updated"
                ? "Directory node updated"
                : "Directory node removed";
    return `${subject}: ${event.reason}`;
}

function createLsStreamEvent(
    event: HubDirectoryGraphEvent,
    previousListings: readonly DiscoveredListing[],
): LsStreamEvent {
    const current = event.snapshot.result.listings;
    const previousByKey = new Map(previousListings.map((listing) => [listingKey(listing), listing]));
    const currentByKey = new Map(current.map((listing) => [listingKey(listing), listing]));
    const node = "node" in event ? event.node : undefined;
    return {
        type: event.type,
        ...("reason" in event ? { reason: event.reason } : {}),
        revision: event.snapshot.revision,
        complete: event.snapshot.complete,
        ...(node !== undefined ? { target: node.target, state: node.state } : {}),
        added: current.filter((listing) => !previousByKey.has(listingKey(listing))),
        removed: previousListings.filter((listing) => !currentByKey.has(listingKey(listing))),
        listings: current,
        inaccessible: event.snapshot.result.inaccessible,
    };
}

function listingKey(listing: ServiceListing): string {
    return `${listing.serviceId}\0${listing.interfaceId}\0${listing.hash}`;
}

function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function dumpSummary(prefix: string, destination: string, dump: HubDump): string {
    return `${prefix} ${destination} (${Object.keys(dump.directories).length + 1} directories, `
        + `${Object.keys(dump.schemas).length} schemas)`;
}

function renderTree(
    listings: readonly LsListing[],
    interfaceFilter: string | undefined,
): string {
    if (listings.length === 0) {
        return interfaceFilter
            ? `(no interfaces matching "${interfaceFilter}")`
            : "(no services)";
    }

    const byService = new Map<string, LsListing[]>();
    for (const l of listings) {
        const bucket = byService.get(l.serviceId) ?? [];
        bucket.push(l);
        byService.set(l.serviceId, bucket);
    }
    const serviceIds = [...byService.keys()].sort((a, b) => {
        // Root first, then lexical.
        if (a === b) return 0;
        if (a === "") return -1;
        if (b === "") return 1;
        return a < b ? -1 : 1;
    });

    const lines: string[] = [];
    for (const sid of serviceIds) {
        lines.push(sid === "" ? "(root)" : sid);
        const ifaces = (byService.get(sid) ?? [])
            .slice()
            .sort((a, b) => (a.interfaceId < b.interfaceId ? -1 : a.interfaceId > b.interfaceId ? 1 : 0));
        for (let i = 0; i < ifaces.length; i++) {
            const isLast = i === ifaces.length - 1;
            const branch = isLast ? "└── " : "├── ";
            const path = ifaces[i].path ? `  [${ifaces[i].path}]` : "";
            lines.push(`${branch}${ifaces[i].interfaceId} @ ${ifaces[i].hash}${path}`);
            const members = ifaces[i].members ?? [];
            for (let j = 0; j < members.length; j++) {
                const memberPrefix = isLast ? "    " : "│   ";
                const memberBranch = j === members.length - 1 ? "└── " : "├── ";
                lines.push(
                    `${memberPrefix}${memberBranch}${members[j].kind.padEnd(12)}  ${members[j].name}`,
                );
            }
        }
    }
    return lines.join("\n");
}
