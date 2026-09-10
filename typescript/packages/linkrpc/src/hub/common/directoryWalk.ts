import type { IRequestSender, RawStreamingCall } from '../../connection/channel';
import { DEFAULT_RPC_TIMEOUT_MS, withRpcTimeout } from '../../connection/requestTimeout';
import type { SigningCallCtx } from '../../identity/signingSender';
import type { JsonValue } from '../../protocol/jsonValue';
import type { LinkRpcInterfaceSchema, MethodSchema } from '../../schema/linkRpcInterfaceSchema';
import {
    directoryInterface,
    type RootPrincipalSet,
    type ServiceIdPattern,
} from './reflection.interfaces';

/**
 * Portable reflection walk over the `hubrpc.directory` referral tree.
 *
 * A directory may explicitly list other `hubrpc.directory` services as
 * referrals. Flattening that graph into an interface inventory is the
 * consumer's job. Routing state is deliberately not part of this contract.
 */

/**
 * The sender reflection helpers speak over: the signing decorator that wraps
 * the live channel. Decoupled from the concrete `JsonRpcChannel` so reconnect
 * can swap the underlying channel transparently.
 */
export type ReflectionChannel = IRequestSender<SigningCallCtx>;

export interface ServiceListing {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash: string;
    readonly path?: string;
    /** Optional non-normative description of the owning service. */
    readonly serviceDescription?: string;
    /**
     * Root node ids required to access the owning service, in CNF. Surfaced by
     * the directory; {@link walkHubDetailed} additionally folds transitive
     * requirements from ancestor directories onto descendants.
     */
    readonly rootPrincipalSets?: readonly RootPrincipalSet[];
    /** Scope carried by a directory referral; omitted means its service-id subtree. */
    readonly reachableServiceIds?: readonly ServiceIdPattern[];
}

/**
 * A {@link ServiceListing} enriched with the service id of the directory that
 * reported it. This is provenance only: every listing is asserted reachable by
 * sending to the endpoint that answered the directory.
 */
export interface DiscoveredListing extends ServiceListing {
    readonly discoveredFrom: string;
}

export interface ListOptions {
    readonly interfaceId?: string;
    readonly interfaceIdPrefix?: string;
    readonly serviceId?: string;
    readonly serviceIdScopes?: readonly ServiceIdPattern[];
    readonly limit?: number;
    readonly timeoutMs?: number;
    /**
     * When set, send the reflection call to that service via form-3
     * (`<target>::hubrpc.directory::list`) instead of the implicit root
     * directory. Used when talking to a hub: the root directory is the hub
     * itself, but per-service reflection lives on each participant.
     */
    readonly target?: string;
}

export async function fetchDirectory(
    channel: ReflectionChannel,
    opts: ListOptions = {},
): Promise<ServiceListing[]> {
    const method = opts.target
        ? `${opts.target}::hubrpc.directory::list`
        : 'hubrpc.directory::list';
    const all: ServiceListing[] = [];
    let cursor: string | undefined;
    while (true) {
        const params: Record<string, JsonValue | undefined> = {};
        if (opts.interfaceId !== undefined) params.interfaceId = opts.interfaceId;
        if (opts.interfaceIdPrefix !== undefined) params.interfaceIdPrefix = opts.interfaceIdPrefix;
        if (opts.serviceId !== undefined) params.serviceId = opts.serviceId;
        if (opts.serviceIdScopes !== undefined) params.serviceIdScopes = [...opts.serviceIdScopes];
        if (opts.limit !== undefined) params.limit = opts.limit;
        if (opts.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs;
        if (cursor !== undefined) params.cursor = cursor;

        const call = channel.sendRequestWithStream(method, params, {
            interfaceHash: directoryInterface.schemaHash,
        });
        const target = opts.target ?? '<root>';
        const raw = await withRpcTimeout(
            Object.assign(call.result, {
                cancel: (reason?: string) => call.cancel(reason),
                dispose: (reason?: string) => call.dispose?.(reason),
            }),
            `hub directory service '${target}'`,
            opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
        );
        const page = raw as unknown as {
            items: {
                serviceId: string;
                interfaceId: string;
                interfaceHash: string;
                path?: string;
                serviceDescription?: string;
                rootPrincipalSets?: readonly RootPrincipalSet[];
                reachableServiceIds?: readonly ServiceIdPattern[];
            }[];
            nextCursor?: string;
        };
        for (const it of page.items) {
            all.push({
                serviceId: it.serviceId,
                interfaceId: it.interfaceId,
                hash: it.interfaceHash,
                ...(it.path !== undefined ? { path: it.path } : {}),
                ...(it.serviceDescription !== undefined
                    ? { serviceDescription: it.serviceDescription }
                    : {}),
                ...(Array.isArray(it.rootPrincipalSets)
                    ? { rootPrincipalSets: it.rootPrincipalSets }
                    : {}),
                ...(Array.isArray(it.reachableServiceIds)
                    ? { reachableServiceIds: it.reachableServiceIds }
                    : {}),
            });
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
    }
    return all;
}

export async function fetchSchema(
    channel: ReflectionChannel,
    interfaceId: string,
    hash: string | undefined,
    /**
     * Optional routing target. When set, the schema request is addressed to
     * `<target>::hubrpc.schemas::get` (form-3) so it reaches the service that
     * actually hosts this interface — needed when talking to a hub and the
     * interface lives behind a participant.
     */
    target?: string,
): Promise<LinkRpcInterfaceSchema> {
    const method = target
        ? `${target}::hubrpc.schemas::get`
        : 'hubrpc.schemas::get';
    const params: Record<string, JsonValue | undefined> = { interfaceId };
    if (hash !== undefined) params.hash = hash;
    const raw = await channel.sendRequest(method, params);
    const wrap = raw as unknown as { schema: LinkRpcInterfaceSchema; };
    return wrap.schema;
}

export function findMethodInSchema(
    schema: LinkRpcInterfaceSchema,
    methodName: string,
): MethodSchema | undefined {
    return schema.methods[methodName];
}

/** Default recursion depth when walking the bus. */
export const DEFAULT_WALK_DEPTH = 5;
const DIRECTORY_INTERFACE_ID = 'hubrpc.directory';
const ROOT_NODE_KEY = '\u0000root';

/** Segment-aware service-id pattern matching (`foo` includes `foo/bar`, not `foobar`). */
export function serviceIdMatchesPattern(serviceId: string, pattern: ServiceIdPattern): boolean {
    if ('exact' in pattern) return serviceId === pattern.exact;
    return pattern.prefix === ''
        || serviceId === pattern.prefix
        || serviceId.startsWith(`${pattern.prefix}/`);
}

/** Whether a service id is included by a union of patterns. `undefined` means unfiltered. */
export function serviceIdMatchesScopes(
    serviceId: string,
    scopes: readonly ServiceIdPattern[] | undefined,
): boolean {
    return scopes === undefined || scopes.some((pattern) => serviceIdMatchesPattern(serviceId, pattern));
}

/** Canonicalize a pattern union by removing duplicates and contained patterns. */
export function normalizeServiceIdScopes(
    scopes: readonly ServiceIdPattern[],
): ServiceIdPattern[] {
    const unique = new Map<string, ServiceIdPattern>();
    for (const pattern of scopes) {
        unique.set(patternKey(pattern), pattern);
    }
    const patterns = [...unique.values()];
    return patterns
        .filter((candidate, index) => !patterns.some((other, otherIndex) =>
            index !== otherIndex && patternContains(other, candidate)))
        .sort((a, b) => patternKey(a).localeCompare(patternKey(b)));
}

/** Pairwise intersection of two pattern unions. */
export function intersectServiceIdScopes(
    left: readonly ServiceIdPattern[],
    right: readonly ServiceIdPattern[],
): ServiceIdPattern[] {
    const intersections: ServiceIdPattern[] = [];
    for (const a of left) {
        for (const b of right) {
            const intersection = intersectPattern(a, b);
            if (intersection !== undefined) intersections.push(intersection);
        }
    }
    return normalizeServiceIdScopes(intersections);
}

function intersectPattern(
    left: ServiceIdPattern,
    right: ServiceIdPattern,
): ServiceIdPattern | undefined {
    if ('exact' in left) {
        if ('exact' in right) return left.exact === right.exact ? left : undefined;
        return serviceIdMatchesPattern(left.exact, right) ? left : undefined;
    }
    if ('exact' in right) {
        return serviceIdMatchesPattern(right.exact, left) ? right : undefined;
    }
    if (serviceIdMatchesPattern(left.prefix, right)) return left;
    if (serviceIdMatchesPattern(right.prefix, left)) return right;
    return undefined;
}

function patternContains(container: ServiceIdPattern, candidate: ServiceIdPattern): boolean {
    if ('exact' in container) {
        return 'exact' in candidate && container.exact === candidate.exact;
    }
    if ('exact' in candidate) return serviceIdMatchesPattern(candidate.exact, container);
    return serviceIdMatchesPattern(candidate.prefix, container);
}

function patternKey(pattern: ServiceIdPattern): string {
    return 'exact' in pattern ? `e:${pattern.exact}` : `p:${pattern.prefix}`;
}

function scopesKey(scopes: readonly ServiceIdPattern[]): string {
    return normalizeServiceIdScopes(scopes).map(patternKey).join('\u0000');
}

/**
 * A sub-directory the walk surfaced but could not enumerate — typically because
 * it is capability-gated (e.g. the `hub` directory, reachable only once the
 * connection holds a capability for it). The services it would have listed are
 * therefore absent from the walk; callers can surface `reason` to explain the
 * gap rather than silently dropping the branch.
 */
export interface InaccessibleDirectory {
    /** The directory target (serviceId) that could not be enumerated. */
    readonly serviceId: string;
    /** The error message from the denied directory lookup. */
    readonly reason: string;
}

export interface WalkHubResult {
    /** Every interface reachable from the directories the walk could read. */
    readonly listings: DiscoveredListing[];
    /**
     * Sub-directories that were referenced but could not be enumerated (e.g.
     * capability-gated). Their services are not present in `listings`.
     */
    readonly inaccessible: InaccessibleDirectory[];
}

/**
 * Recursive graph walk: list a directory, intersect the accumulated service-id
 * scope with every explicit `hubrpc.directory` referral, and recurse. Bounded
 * by `maxDepth`.
 *
 * Every listing is tagged with `discoveredFrom` — the serviceId of the
 * directory that produced it. When the same `(serviceId, interfaceId, hash)`
 * shows up via several directories (e.g. once forwarded by the hub, once
 * directly from the participant), we keep the one whose `discoveredFrom`
 * matches the item's `serviceId`, since that's the directory that
 * authoritatively knows about it.
 *
 * Transitive root-node-id requirements flow down the tree: when the walk
 * recurses into a directory whose own `rootPrincipalSets` include `transitive`
 * reqs, every interface discovered at or below that directory inherits them (as
 * singleton AND-sets, kept transitive so they keep flowing further down). This
 * replaces the hub-side `applyTransitiveReqs` fold that the v1 aggregating
 * directory performed.
 *
 * A sub-directory the walk cannot read is recorded in
 * {@link WalkHubResult.inaccessible} rather than silently dropped. A failure to
 * read the *root* directory is left silent — there is no sub-tree to explain —
 * and simply yields empty results.
 *
 * When {@link WalkHubOptions.unlockGatedDirectory} is supplied, each gated
 * sub-directory is offered to the hook; if it returns `true` (a capability was
 * granted), that directory is re-queued and the walk continues into it — a
 * fixpoint that keeps unlocking newly-revealed gated branches until nothing
 * more can be opened (still bounded by `maxDepth`).
 */
export interface WalkHubOptions {
    readonly maxDepth?: number;
    /** Hard deadline for each directory page request. Defaults to 5 seconds. */
    readonly timeoutMs?: number;
    /** Return only listings for this exact interface id after traversing directories. */
    readonly interfaceId?: string;
    /** Return only listings whose interface id starts with this prefix after traversal. */
    readonly interfaceIdPrefix?: string;
    /** Return only listings for this exact service id after traversal. */
    readonly serviceId?: string;
    /** Initial service-id scope. Defaults to the universal `{ prefix: "" }`. */
    readonly serviceIdScopes?: readonly ServiceIdPattern[];
    /**
     * The directory the walk starts from. Defaults to the implicit root
     * directory (form-2 `hubrpc.directory::list`). Pass a serviceId to start at
     * `<rootTarget>::hubrpc.directory::list` — e.g. the hub's own global
     * directory (`'hub'`) when walking from the hub's in-process connection.
     */
    readonly rootTarget?: string;
    /**
     * Invoked once per gated sub-directory the walk encounters. Return `true`
     * if a capability for its `hubrpc.directory::list` was granted and the
     * directory should be re-listed; `false` (or omitted hook) leaves it in
     * {@link WalkHubResult.inaccessible}. Called at most once per `serviceId`.
     */
    unlockGatedDirectory?: (serviceId: string) => Promise<boolean>;
    /** Optional diagnostic sink for inaccessible lists and ended watches. */
    readonly log?: (message: string) => void;
}

export async function walkHubDetailed(
    channel: ReflectionChannel,
    opts: WalkHubOptions = {},
): Promise<WalkHubResult> {
    return new HubDirectoryExplorer(channel, opts).explore();
}

/**
 * Backward-compatible wrapper over {@link walkHubDetailed} that returns only the
 * reachable listings, dropping the inaccessible-directory report.
 */
export async function walkHub(
    channel: ReflectionChannel,
    opts: WalkHubOptions = {},
): Promise<DiscoveredListing[]> {
    return (await walkHubDetailed(channel, opts)).listings;
}

export interface HubDirectoryChange {
    /** Directory that emitted the tick. `undefined` denotes the connection root. */
    readonly target: string | undefined;
    readonly result: WalkHubResult;
}

export type HubDirectoryGraphTarget =
    | { readonly kind: 'root'; readonly serviceId?: string; }
    | { readonly kind: 'addressed'; readonly serviceId: string; };

export type HubDirectoryNodeState =
    | 'unexplored'
    | 'loading'
    | 'loaded'
    | 'inaccessible';

export interface HubDirectoryParentReport {
    readonly target: HubDirectoryGraphTarget;
    readonly scopes: readonly ServiceIdPattern[];
    /** Resulting depth for this incoming parent path. */
    readonly depth: number;
}

/** Stable public report for one native directory response. */
export interface HubDirectoryNodeReport {
    readonly target: HubDirectoryGraphTarget;
    readonly state: HubDirectoryNodeState;
    readonly effectiveScopes: readonly ServiceIdPattern[];
    readonly depth: number;
    readonly parents: readonly HubDirectoryParentReport[];
    /** Per-directory listings, normalized to `ServiceListing`, before inherited metadata is folded. */
    readonly nativeListings: readonly ServiceListing[];
    readonly inaccessibleReason?: string;
    readonly watching: boolean;
}

/**
 * Complete point-in-time graph document. `root` exists from construction in
 * the `unexplored` state, so consumers can render before exploration starts.
 */
export interface HubDirectoryGraphSnapshot {
    readonly revision: number;
    readonly complete: boolean;
    readonly root: HubDirectoryNodeReport;
    readonly directories: readonly HubDirectoryNodeReport[];
    readonly result: WalkHubResult;
}

export type HubDirectoryGraphEvent =
    | {
        readonly type: 'snapshot';
        readonly reason: 'subscribed' | 'reconciliation-started' | 'reset';
        readonly snapshot: HubDirectoryGraphSnapshot;
    }
    | {
        readonly type: 'node-added';
        readonly reason: 'referral';
        readonly node: HubDirectoryNodeReport;
        readonly snapshot: HubDirectoryGraphSnapshot;
    }
    | {
        readonly type: 'node-updated';
        readonly reason:
            | 'loading'
            | 'loaded'
            | 'inaccessible'
            | 'referral'
            | 'watch-started'
            | 'watch-stopped'
            | 'watch-ended'
            | 'reset';
        readonly previous: HubDirectoryNodeReport;
        readonly node: HubDirectoryNodeReport;
        readonly snapshot: HubDirectoryGraphSnapshot;
    }
    | {
        readonly type: 'node-removed';
        readonly reason: 'unreachable' | 'reset';
        readonly previous: HubDirectoryNodeReport;
        readonly snapshot: HubDirectoryGraphSnapshot;
    }
    | {
        readonly type: 'settled';
        readonly snapshot: HubDirectoryGraphSnapshot;
    };

/**
 * Reusable directory graph explorer and watcher.
 *
 * The class keeps one native snapshot per directory target. A watch tick
 * re-lists only its source target; outgoing referral changes then propagate
 * through affected descendants. Unchanged siblings retain both their snapshot
 * and watch. Multi-parent targets are queried with the normalized union of all
 * incoming path scopes.
 */
export class HubDirectoryExplorer {
    private readonly _maxDepth: number;
    private readonly _initialScopes: ServiceIdPattern[];
    private readonly _nodes = new Map<string, DirectoryNode>();
    private readonly _unlockAttempted = new Set<string>();
    private readonly _listeners = new Set<(change: HubDirectoryChange) => void>();
    private readonly _graphListeners = new Set<(event: HubDirectoryGraphEvent) => void>();
    private readonly _pendingTicks = new Set<string>();
    private readonly _watchRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly _watchRetryDelays = new Map<string, number>();
    private _initialized = false;
    private _disposed = false;
    private _watching = false;
    private _complete = false;
    private _revision = 0;
    private _work: Promise<void> = Promise.resolve();
    private _explorePromise: Promise<WalkHubResult> | undefined;

    public constructor(
        private readonly _channel: ReflectionChannel,
        private readonly _options: WalkHubOptions = {},
    ) {
        this._maxDepth = _options.maxDepth ?? DEFAULT_WALK_DEPTH;
        this._initialScopes = normalizeServiceIdScopes(
            _options.serviceIdScopes ?? [{ prefix: '' }],
        );
        this._nodes.set(ROOT_NODE_KEY, this._createRootNode());
    }

    /** Perform a fresh bounded exploration without starting watches. */
    public explore(): Promise<WalkHubResult> {
        this._throwIfDisposed();
        if (this._explorePromise !== undefined) return this._explorePromise;
        const promise = this._explore();
        this._explorePromise = promise;
        const clear = () => {
            if (this._explorePromise === promise) this._explorePromise = undefined;
        };
        void promise.then(clear, clear);
        return promise;
    }

    private async _explore(): Promise<WalkHubResult> {
        if (this._initialized || this._nodes.get(ROOT_NODE_KEY)?.state !== 'unexplored') {
            this._resetForExplore();
        }
        const root = this._nodes.get(ROOT_NODE_KEY)!;
        await this._loadNode(root);
        if (this._disposed) return { listings: [], inaccessible: [] };
        await this._reconcileScopesFromRoot();
        await this._pruneUnreachable();
        this._initialized = true;
        if (this._watching) await this._synchronizeWatches();
        this._settle();
        return this.result;
    }

    /** Current deduplicated graph snapshot. */
    public get result(): WalkHubResult {
        const best = new Map<string, DiscoveredListing>();
        for (const node of this._nodes.values()) {
            if (!node.loaded) continue;
            for (const item of node.listings) {
                const effective = mergePrincipalSets(item.rootPrincipalSets, node.inherited);
                const tagged: DiscoveredListing = {
                    ...item,
                    ...(effective.length > 0 ? { rootPrincipalSets: effective } : {}),
                    discoveredFrom: node.target ?? '',
                };
                const key = listingKey(item);
                const existing = best.get(key);
                if (!existing || _isAuthoritative(tagged, existing)) best.set(key, tagged);
            }
        }
        const listings = [...best.values()]
            .filter((item) => this._options.interfaceId === undefined
                || item.interfaceId === this._options.interfaceId)
            .filter((item) => this._options.interfaceIdPrefix === undefined
                || item.interfaceId.startsWith(this._options.interfaceIdPrefix))
            .filter((item) => this._options.serviceId === undefined
                || item.serviceId === this._options.serviceId);
        const inaccessible = [...this._nodes.values()]
            .filter((node) => node.key !== ROOT_NODE_KEY && node.inaccessibleReason !== undefined)
            .map((node) => ({
                serviceId: node.target!,
                reason: node.inaccessibleReason!,
            }));
        return { listings, inaccessible };
    }

    /** Current complete-or-progressive directory graph report. */
    public get graphSnapshot(): HubDirectoryGraphSnapshot {
        const root = this._nodes.get(ROOT_NODE_KEY) ?? this._createRootNode();
        const directories = [...this._nodes.values()]
            .filter((node) => node.key !== ROOT_NODE_KEY)
            .sort((a, b) => (a.target ?? '').localeCompare(b.target ?? ''))
            .map((node) => this._nodeReport(node));
        return {
            revision: this._revision,
            complete: this._complete,
            root: this._nodeReport(root),
            directories,
            result: this.result,
        };
    }

    /**
     * Subscribe to progressive graph reports. The listener is registered before
     * receiving a synchronous current snapshot, avoiding the subscribe/explore
     * race for both idle and already-running explorers.
     */
    public subscribe(listener: (event: HubDirectoryGraphEvent) => void): () => void {
        this._throwIfDisposed();
        this._graphListeners.add(listener);
        this._deliverGraphEvent(listener, {
            type: 'snapshot',
            reason: 'subscribed',
            snapshot: this.graphSnapshot,
        });
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this._graphListeners.delete(listener);
        };
    }

    /**
     * Explore once, then watch every reachable directory. Resolves after the
     * initial graph and watches are established.
     */
    public async watch(
        listener: (change: HubDirectoryChange) => void,
    ): Promise<() => void> {
        this._throwIfDisposed();
        this._listeners.add(listener);
        this._watching = true;
        if (!this._initialized) {
            await this.explore();
        } else {
            this._startReconciliation();
            await this._synchronizeWatches();
            this._settle();
        }
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this._listeners.delete(listener);
            if (this._listeners.size === 0) {
                this._watching = false;
                this._stopAllWatches();
            }
        };
    }

    /** Wait until all currently queued watch reconciliation has settled. */
    public async whenIdle(): Promise<void> {
        await this._work;
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._listeners.clear();
        this._pendingTicks.clear();
        this._stopAllWatches(false);
        this._graphListeners.clear();
        this._clearNodes();
    }

    private async _loadNode(node: DirectoryNode, reconcileOutgoing = true): Promise<void> {
        if (node.loading) {
            node.reloadRequested = true;
            return;
        }
        node.loading = true;
        this._updateNode(node, 'loading', () => {
            node.state = 'loading';
        });
        try {
            do {
                node.reloadRequested = false;
                const scopesAtRequest = node.scopes;
                let listings: ServiceListing[];
                try {
                    listings = await fetchDirectory(this._channel, {
                        target: node.target,
                        serviceIdScopes: scopesAtRequest,
                        timeoutMs: this._options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
                    });
                    if (this._disposed) break;
                } catch (error) {
                    if (this._disposed) break;
                    if (await this._tryUnlock(node)) {
                        node.reloadRequested = true;
                        continue;
                    }
                    const previous = this._nodeReport(node);
                    node.inaccessibleReason = errorMessage(error);
                    this._options.log?.(
                        `hub directory list(${node.target ?? '<root>'}) failed: ${node.inaccessibleReason}`,
                    );
                    // A watcher retains the last good branch while it is
                    // temporarily inaccessible. A never-loaded node contributes
                    // no entries but remains in the inaccessible report.
                    if (node.loaded) {
                        node.listings = node.listings.filter((item) =>
                            serviceIdMatchesScopes(item.serviceId, node.scopes));
                    }
                    node.state = 'inaccessible';
                    this._emitNodeUpdated(node, previous, 'inaccessible');
                    if (node.loaded && reconcileOutgoing) await this._reconcileOutgoing(node);
                    break;
                }
                if (scopesKey(scopesAtRequest) !== scopesKey(node.scopes)) {
                    node.reloadRequested = true;
                    continue;
                }
                const previous = this._nodeReport(node);
                node.inaccessibleReason = undefined;
                node.loaded = true;
                node.listings = listings.filter((item) =>
                    serviceIdMatchesScopes(item.serviceId, node.scopes));
                node.state = 'loaded';
                this._emitNodeUpdated(node, previous, 'loaded');
                if (reconcileOutgoing) await this._reconcileOutgoing(node);
            } while (node.reloadRequested && !this._disposed);
        } finally {
            node.loading = false;
        }
    }

    private async _tryUnlock(node: DirectoryNode): Promise<boolean> {
        if (
            node.target === undefined
            || this._options.unlockGatedDirectory === undefined
            || this._unlockAttempted.has(node.target)
        ) {
            return false;
        }
        this._unlockAttempted.add(node.target);
        try {
            return await this._options.unlockGatedDirectory(node.target);
        } catch {
            return false;
        }
    }

    private async _reconcileOutgoing(node: DirectoryNode): Promise<void> {
        const next = this._outgoingFor(node.scopes, node.inherited, node.depth, node.listings);

        const affected = new Set<string>([...node.outgoing.keys(), ...next.keys()]);
        node.outgoing = next;
        for (const childKey of affected) {
            if (this._disposed) return;
            const contribution = next.get(childKey);
            let child = this._nodes.get(childKey);
            let previous: HubDirectoryNodeReport | undefined;
            if (contribution === undefined) {
                if (child === undefined) continue;
                previous = this._nodeReport(child);
                child.parents.delete(node.key);
            } else {
                if (child === undefined) {
                    child = this._createNode(childKey);
                    child.parents.set(node.key, contribution);
                    this._deriveNodeFromParents(child);
                    this._nodes.set(childKey, child);
                    this._emitNodeAdded(child);
                    await this._loadNode(child);
                    continue;
                }
                previous = this._nodeReport(child);
                child.parents.set(node.key, contribution);
            }
            await this._updateNodeFromParents(child, previous);
        }
    }

    private _outgoingFor(
        scopes: readonly ServiceIdPattern[],
        inherited: readonly RootPrincipalSet[],
        depth: number,
        listings: readonly ServiceListing[],
    ): Map<string, ParentContribution> {
        const outgoing = new Map<string, ParentContribution>();
        if (depth >= this._maxDepth) return outgoing;
        for (const item of listings) {
            if (
                item.interfaceId !== DIRECTORY_INTERFACE_ID
                || !serviceIdMatchesScopes(item.serviceId, scopes)
            ) {
                continue;
            }
            const referralScopes = item.reachableServiceIds
                ?? [{ prefix: item.serviceId }];
            const childScopes = intersectServiceIdScopes(scopes, referralScopes);
            if (childScopes.length === 0) continue;
            const childKey = this._nodeKeyForTarget(item.serviceId);
            if (childKey === ROOT_NODE_KEY) continue;
            const contribution: ParentContribution = {
                scopes: childScopes,
                inherited: mergePrincipalSets(
                    inherited,
                    transitiveReqsOf(item.rootPrincipalSets),
                ),
                depth: depth + 1,
            };
            const previous = outgoing.get(childKey);
            outgoing.set(childKey, previous === undefined
                ? contribution
                : mergeContributions(previous, contribution));
        }
        return outgoing;
    }

    private _createRootNode(): DirectoryNode {
        return {
            key: ROOT_NODE_KEY,
            target: this._options.rootTarget,
            parents: new Map(),
            scopes: [...this._initialScopes],
            inherited: [],
            depth: 0,
            listings: [],
            outgoing: new Map(),
            loaded: false,
            loading: false,
            reloadRequested: false,
            state: 'unexplored',
        };
    }

    private _createNode(key: string): DirectoryNode {
        return {
            key,
            target: key.slice(2),
            parents: new Map(),
            scopes: [],
            inherited: [],
            depth: Number.POSITIVE_INFINITY,
            listings: [],
            outgoing: new Map(),
            loaded: false,
            loading: false,
            reloadRequested: false,
            state: 'unexplored',
        };
    }

    private async _updateNodeFromParents(
        node: DirectoryNode,
        previous = this._nodeReport(node),
    ): Promise<void> {
        if (node.key === ROOT_NODE_KEY || node.parents.size === 0) return;
        const { scopes, inherited, depth } = this._derivedNodeState(node);
        const changed = scopesKey(scopes) !== scopesKey(node.scopes)
            || principalSetsKey(inherited) !== principalSetsKey(node.inherited)
            || depth !== node.depth;
        if (!changed) return;
        node.scopes = scopes;
        node.inherited = inherited;
        node.depth = depth;
        this._emitNodeUpdated(node, previous, 'referral');
        await this._loadNode(node);
    }

    private _deriveNodeFromParents(node: DirectoryNode): void {
        const derived = this._derivedNodeState(node);
        node.scopes = derived.scopes;
        node.inherited = derived.inherited;
        node.depth = derived.depth;
    }

    private _derivedNodeState(node: DirectoryNode): {
        scopes: ServiceIdPattern[];
        inherited: RootPrincipalSet[];
        depth: number;
    } {
        const contributions = [...node.parents.values()];
        return {
            scopes: normalizeServiceIdScopes(contributions.flatMap((value) => value.scopes)),
            inherited: mergePrincipalSets(
                ...contributions.map((value) => value.inherited),
            ),
            depth: Math.min(...contributions.map((value) => value.depth)),
        };
    }

    /**
     * Rebuild incoming contributions from the root seed. Starting with no
     * non-root contributions computes the least fixed point, so a disconnected
     * or narrowed cycle cannot keep scopes contributed by its previous state.
     */
    private async _reconcileScopesFromRoot(): Promise<void> {
        const maxRounds = Math.max(
            16,
            (this._nodes.size + (Number.isFinite(this._maxDepth) ? this._maxDepth : 256)) * 4,
        );
        for (let round = 0; round < maxRounds; round++) {
            const computed = this._computeScopeFixedPoint();
            let relisted = false;
            const ordered = [...computed.states.entries()]
                .sort(([, left], [, right]) => left.depth - right.depth);

            for (const [key, state] of ordered) {
                if (key === ROOT_NODE_KEY) {
                    const root = this._nodes.get(ROOT_NODE_KEY)!;
                    root.outgoing = computed.outgoing.get(key) ?? new Map();
                    continue;
                }
                let node = this._nodes.get(key);
                if (node === undefined) {
                    node = this._createNode(key);
                    node.parents = computed.parents.get(key) ?? new Map();
                    node.scopes = state.scopes;
                    node.inherited = state.inherited;
                    node.depth = state.depth;
                    node.outgoing = computed.outgoing.get(key) ?? new Map();
                    this._nodes.set(key, node);
                    this._emitNodeAdded(node);
                    await this._loadNode(node, false);
                    relisted = true;
                    continue;
                }

                const parents = computed.parents.get(key) ?? new Map();
                const scopesChanged = scopesKey(node.scopes) !== scopesKey(state.scopes);
                const inheritedChanged =
                    principalSetsKey(node.inherited) !== principalSetsKey(state.inherited);
                const depthChanged = node.depth !== state.depth;
                const parentsChanged =
                    parentContributionsKey(node.parents) !== parentContributionsKey(parents);
                const previous = scopesChanged || inheritedChanged || depthChanged || parentsChanged
                    ? this._nodeReport(node)
                    : undefined;
                node.parents = parents;
                node.scopes = state.scopes;
                node.inherited = state.inherited;
                node.depth = state.depth;
                node.outgoing = computed.outgoing.get(key) ?? new Map();
                if (previous !== undefined) this._emitNodeUpdated(node, previous, 'referral');
                if (scopesChanged) {
                    await this._loadNode(node, false);
                    relisted = true;
                }
            }

            const unreachable = [...this._nodes.values()]
                .filter((node) => !computed.states.has(node.key))
                .sort((a, b) => b.depth - a.depth || a.key.localeCompare(b.key));
            for (const node of unreachable) {
                const previous = this._nodeReport(node);
                this._stopWatch(node, false);
                this._nodes.delete(node.key);
                this._emitNodeRemoved(previous);
            }

            if (!relisted) return;
        }
        throw new Error('Hub directory scope reconciliation did not converge');
    }

    private _computeScopeFixedPoint(): ComputedDirectoryGraph {
        const states = new Map<string, DerivedNodeState>();
        const parents = new Map<string, Map<string, ParentContribution>>();
        const outgoing = new Map<string, Map<string, ParentContribution>>();
        states.set(ROOT_NODE_KEY, {
            scopes: [...this._initialScopes],
            inherited: [],
            depth: 0,
        });
        parents.set(ROOT_NODE_KEY, new Map());
        const queue = [ROOT_NODE_KEY];
        const processed = new Map<string, string>();

        while (queue.length > 0) {
            const key = queue.shift()!;
            const state = states.get(key);
            if (state === undefined) continue;
            const stateKey = derivedStateKey(state);
            if (processed.get(key) === stateKey) continue;
            processed.set(key, stateKey);

            const node = this._nodes.get(key);
            const next = node === undefined
                ? new Map<string, ParentContribution>()
                : this._outgoingFor(
                    state.scopes,
                    state.inherited,
                    state.depth,
                    node.listings,
                );
            outgoing.set(key, next);
            for (const [childKey, contribution] of next) {
                const childParents = parents.get(childKey) ?? new Map<string, ParentContribution>();
                childParents.set(key, contribution);
                parents.set(childKey, childParents);
                const childState = derivedStateFromParents(childParents);
                const oldState = states.get(childKey);
                if (oldState === undefined || derivedStateKey(oldState) !== derivedStateKey(childState)) {
                    states.set(childKey, childState);
                    queue.push(childKey);
                }
            }
        }
        return { states, parents, outgoing };
    }

    private async _pruneUnreachable(): Promise<void> {
        const reachable = new Set<string>();
        const queue = [ROOT_NODE_KEY];
        while (queue.length > 0) {
            const key = queue.shift()!;
            if (reachable.has(key)) continue;
            reachable.add(key);
            const node = this._nodes.get(key);
            if (node === undefined) continue;
            for (const childKey of node.outgoing.keys()) queue.push(childKey);
        }
        const removedNodes = [...this._nodes.values()]
            .filter((node) => !reachable.has(node.key))
            .sort((a, b) => b.depth - a.depth || a.key.localeCompare(b.key));
        if (removedNodes.length === 0) return;
        const removed = new Set(removedNodes.map((node) => node.key));
        for (const node of removedNodes) {
            const previous = this._nodeReport(node);
            this._stopWatch(node, false);
            this._nodes.delete(node.key);
            this._emitNodeRemoved(previous);
        }
        for (const node of this._nodes.values()) {
            const previous = this._nodeReport(node);
            let changed = false;
            for (const parentKey of removed) changed = node.parents.delete(parentKey) || changed;
            if (changed) await this._updateNodeFromParents(node, previous);
        }
    }

    /**
     * Every changed watch scope uses list/watch/list: callers reach this method
     * only after a list under the current scope, then the replacement watch is
     * installed before a verification list. Either the verification sees a
     * handoff mutation or the new watch ticks for it.
     */
    private async _synchronizeWatches(): Promise<void> {
        const maxPasses = Math.max(8, this._nodes.size * 4);
        for (let pass = 0; pass < maxPasses && !this._disposed; pass++) {
            const pending = [...this._nodes.values()]
                .filter((node) =>
                    node.watch === undefined || node.watchScopesKey !== scopesKey(node.scopes))
                .sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
            if (pending.length === 0) return;
            let installed = false;
            for (const node of pending) {
                if (this._nodes.get(node.key) !== node) continue;
                installed = this._replaceWatch(node) || installed;
                if (node.watchScopesKey === scopesKey(node.scopes)) {
                    await this._loadNode(node);
                    await this._reconcileScopesFromRoot();
                    await this._pruneUnreachable();
                }
            }
            if (!installed) return;
        }
        throw new Error('Hub directory watch synchronization did not converge');
    }

    private _replaceWatch(node: DirectoryNode): boolean {
        if (!this._watching || this._disposed) return false;
        const method = node.target === undefined
            ? 'hubrpc.directory::watch'
            : `${node.target}::hubrpc.directory::watch`;
        const params: Record<string, JsonValue | undefined> = {
            serviceIdScopes: [...node.scopes],
        };
        let call: RawStreamingCall;
        try {
            call = this._channel.sendRequestWithStream(method, params, {
                onStreamMessage: () => this._queueTick(node.key),
            });
        } catch (error) {
            this._options.log?.(
                `hub directory watch(${node.target ?? '<root>'}) failed: ${errorMessage(error)}`,
            );
            this._scheduleWatchRetry(node);
            return false;
        }
        const previous = this._nodeReport(node);
        const oldWatch = node.watch;
        node.watch = call;
        node.watchScopesKey = scopesKey(node.scopes);
        this._emitNodeUpdated(node, previous, 'watch-started');
        if (oldWatch !== undefined) {
            try {
                oldWatch.cancel('directory explorer watch scope replaced');
            } catch {
                // Best-effort replacement.
            }
        }
        void call.result.then(() => {
            if (this._disposed || node.watch !== call) return;
            const previous = this._nodeReport(node);
            node.watch = undefined;
            node.watchScopesKey = undefined;
            this._emitNodeUpdated(node, previous, 'watch-ended');
            this._scheduleWatchRetry(node);
        }, (error) => {
            if (this._disposed || node.watch !== call) return;
            const previous = this._nodeReport(node);
            node.watch = undefined;
            node.watchScopesKey = undefined;
            this._options.log?.(
                `hub directory watch(${node.target ?? '<root>'}) ended: ${errorMessage(error)}`,
            );
            this._emitNodeUpdated(node, previous, 'watch-ended');
            this._scheduleWatchRetry(node);
        });
        return true;
    }

    private _queueTick(key: string): void {
        if (this._disposed || !this._nodes.has(key)) return;
        this._watchRetryDelays.delete(key);
        this._pendingTicks.add(key);
        this._startReconciliation();
        this._work = this._work.then(async () => {
            while (this._pendingTicks.size > 0 && !this._disposed) {
                const nextKey = this._pendingTicks.values().next().value as string;
                this._pendingTicks.delete(nextKey);
                const node = this._nodes.get(nextKey);
                if (node === undefined) continue;
                await this._loadNode(node);
                await this._reconcileScopesFromRoot();
                await this._pruneUnreachable();
                await this._synchronizeWatches();
                const change = { target: node.target, result: this.result };
                for (const listener of [...this._listeners]) {
                    try {
                        listener(change);
                    } catch (error) {
                        this._options.log?.(
                            `hub directory change listener failed: ${errorMessage(error)}`,
                        );
                    }
                }
            }
            this._settle();
        }).catch((error) => {
            this._options.log?.(`hub directory reconciliation failed: ${errorMessage(error)}`);
            this._settle();
        });
    }

    private _stopWatch(node: DirectoryNode, emit = true): void {
        this._clearWatchRetry(node.key);
        const watch = node.watch;
        if (watch === undefined) return;
        const previous = emit ? this._nodeReport(node) : undefined;
        node.watch = undefined;
        node.watchScopesKey = undefined;
        try {
            watch.cancel('directory explorer watch stopped');
        } catch {
            // Best-effort teardown.
        }
        if (previous !== undefined) this._emitNodeUpdated(node, previous, 'watch-stopped');
    }

    private _stopAllWatches(emit = true): void {
        for (const node of this._nodes.values()) this._stopWatch(node, emit);
        for (const key of [...this._watchRetryTimers.keys()]) this._clearWatchRetry(key);
    }

    private _scheduleWatchRetry(node: DirectoryNode): void {
        if (
            !this._watching
            || this._disposed
            || this._nodes.get(node.key) !== node
            || this._watchRetryTimers.has(node.key)
        ) {
            return;
        }
        const delay = this._watchRetryDelays.get(node.key) ?? 200;
        this._watchRetryDelays.set(node.key, Math.min(5_000, delay * 2));
        const timer = setTimeout(() => {
            this._watchRetryTimers.delete(node.key);
            if (
                !this._watching
                || this._disposed
                || this._nodes.get(node.key) !== node
                || node.watch !== undefined
            ) {
                return;
            }
            this._startReconciliation();
            this._work = this._work.then(async () => {
                await this._synchronizeWatches();
                this._settle();
            }).catch((error) => {
                this._options.log?.(
                    `hub directory watch retry failed: ${errorMessage(error)}`,
                );
                this._settle();
                this._scheduleWatchRetry(node);
            });
        }, delay);
        this._watchRetryTimers.set(node.key, timer);
    }

    private _clearWatchRetry(key: string): void {
        const timer = this._watchRetryTimers.get(key);
        if (timer !== undefined) clearTimeout(timer);
        this._watchRetryTimers.delete(key);
        this._watchRetryDelays.delete(key);
    }

    private _clearNodes(): void {
        this._stopAllWatches(false);
        this._nodes.clear();
        this._unlockAttempted.clear();
        this._pendingTicks.clear();
        this._initialized = false;
    }

    private _resetForExplore(): void {
        this._complete = false;
        this._emitSnapshot('reset');
        this._stopAllWatches(false);
        const addressed = [...this._nodes.values()]
            .filter((node) => node.key !== ROOT_NODE_KEY)
            .sort((a, b) => b.depth - a.depth || a.key.localeCompare(b.key));
        for (const node of addressed) {
            const previous = this._nodeReport(node);
            this._nodes.delete(node.key);
            this._emitNodeRemoved(previous, 'reset');
        }
        const previousRoot = this._nodes.get(ROOT_NODE_KEY);
        const root = this._createRootNode();
        this._nodes.set(ROOT_NODE_KEY, root);
        if (previousRoot !== undefined) {
            this._emitNodeUpdated(root, this._nodeReport(previousRoot), 'reset');
        }
        this._unlockAttempted.clear();
        this._pendingTicks.clear();
        this._initialized = false;
    }

    private _updateNode(
        node: DirectoryNode,
        reason: Extract<HubDirectoryGraphEvent, { type: 'node-updated' }>['reason'],
        update: () => void,
    ): void {
        const previous = this._nodeReport(node);
        update();
        this._emitNodeUpdated(node, previous, reason);
    }

    private _nodeReport(node: DirectoryNode): HubDirectoryNodeReport {
        const parents = [...node.parents.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([parentKey, contribution]) => ({
                target: this._targetForKey(parentKey),
                scopes: cloneScopes(contribution.scopes),
                depth: contribution.depth,
            }));
        return {
            target: this._targetForKey(node.key),
            state: node.state,
            effectiveScopes: cloneScopes(node.scopes),
            depth: node.depth,
            parents,
            nativeListings: node.listings.map(cloneListing),
            ...(node.inaccessibleReason === undefined
                ? {}
                : { inaccessibleReason: node.inaccessibleReason }),
            watching: node.watch !== undefined,
        };
    }

    private _targetForKey(key: string): HubDirectoryGraphTarget {
        if (key === ROOT_NODE_KEY) {
            return this._options.rootTarget === undefined
                ? { kind: 'root' }
                : { kind: 'root', serviceId: this._options.rootTarget };
        }
        return { kind: 'addressed', serviceId: key.slice(2) };
    }

    private _emitNodeAdded(node: DirectoryNode): void {
        this._revision++;
        this._emitGraphEvent({
            type: 'node-added',
            reason: 'referral',
            node: this._nodeReport(node),
            snapshot: this.graphSnapshot,
        });
    }

    private _emitNodeUpdated(
        node: DirectoryNode,
        previous: HubDirectoryNodeReport,
        reason: Extract<HubDirectoryGraphEvent, { type: 'node-updated' }>['reason'],
    ): void {
        this._revision++;
        this._emitGraphEvent({
            type: 'node-updated',
            reason,
            previous,
            node: this._nodeReport(node),
            snapshot: this.graphSnapshot,
        });
    }

    private _emitNodeRemoved(
        previous: HubDirectoryNodeReport,
        reason: Extract<HubDirectoryGraphEvent, { type: 'node-removed' }>['reason'] = 'unreachable',
    ): void {
        this._revision++;
        this._emitGraphEvent({
            type: 'node-removed',
            reason,
            previous,
            snapshot: this.graphSnapshot,
        });
    }

    private _startReconciliation(): void {
        if (!this._complete) return;
        this._complete = false;
        this._emitSnapshot('reconciliation-started');
    }

    private _settle(): void {
        if (this._complete || this._disposed) return;
        this._complete = true;
        this._revision++;
        this._emitGraphEvent({ type: 'settled', snapshot: this.graphSnapshot });
    }

    private _emitSnapshot(
        reason: Extract<HubDirectoryGraphEvent, { type: 'snapshot' }>['reason'],
    ): void {
        this._revision++;
        this._emitGraphEvent({ type: 'snapshot', reason, snapshot: this.graphSnapshot });
    }

    private _emitGraphEvent(event: HubDirectoryGraphEvent): void {
        for (const listener of this._graphListeners) this._deliverGraphEvent(listener, event);
    }

    private _deliverGraphEvent(
        listener: (event: HubDirectoryGraphEvent) => void,
        event: HubDirectoryGraphEvent,
    ): void {
        try {
            listener(event);
        } catch (error) {
            this._options.log?.(`hub directory graph listener failed: ${errorMessage(error)}`);
        }
    }

    private _nodeKeyForTarget(target: string): string {
        const isImplicitRoot = this._options.rootTarget === undefined && target === '';
        return target === this._options.rootTarget || isImplicitRoot
            ? ROOT_NODE_KEY
            : `s:${target}`;
    }

    private _throwIfDisposed(): void {
        if (this._disposed) throw new Error('HubDirectoryExplorer is disposed');
    }
}

interface ParentContribution {
    readonly scopes: readonly ServiceIdPattern[];
    readonly inherited: readonly RootPrincipalSet[];
    readonly depth: number;
}

interface DirectoryNode {
    readonly key: string;
    readonly target: string | undefined;
    parents: Map<string, ParentContribution>;
    scopes: ServiceIdPattern[];
    inherited: RootPrincipalSet[];
    depth: number;
    listings: ServiceListing[];
    outgoing: Map<string, ParentContribution>;
    loaded: boolean;
    loading: boolean;
    reloadRequested: boolean;
    state: HubDirectoryNodeState;
    inaccessibleReason?: string;
    watch?: RawStreamingCall;
    watchScopesKey?: string;
}

interface DerivedNodeState {
    readonly scopes: ServiceIdPattern[];
    readonly inherited: RootPrincipalSet[];
    readonly depth: number;
}

interface ComputedDirectoryGraph {
    readonly states: Map<string, DerivedNodeState>;
    readonly parents: Map<string, Map<string, ParentContribution>>;
    readonly outgoing: Map<string, Map<string, ParentContribution>>;
}

function mergeContributions(
    left: ParentContribution,
    right: ParentContribution,
): ParentContribution {
    return {
        scopes: normalizeServiceIdScopes([...left.scopes, ...right.scopes]),
        inherited: mergePrincipalSets(left.inherited, right.inherited),
        depth: Math.min(left.depth, right.depth),
    };
}

function derivedStateFromParents(
    parents: ReadonlyMap<string, ParentContribution>,
): DerivedNodeState {
    const contributions = [...parents.values()];
    return {
        scopes: normalizeServiceIdScopes(contributions.flatMap((value) => value.scopes)),
        inherited: mergePrincipalSets(
            ...contributions.map((value) => value.inherited),
        ),
        depth: Math.min(...contributions.map((value) => value.depth)),
    };
}

function derivedStateKey(state: {
    readonly scopes: readonly ServiceIdPattern[];
    readonly inherited: readonly RootPrincipalSet[];
    readonly depth: number;
}): string {
    return `${scopesKey(state.scopes)}\u0001${principalSetsKey(state.inherited)}\u0001${state.depth}`;
}

function parentContributionsKey(
    parents: ReadonlyMap<string, ParentContribution>,
): string {
    return [...parents.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, contribution]) =>
            `${key}\u0002${derivedStateKey(contribution)}`)
        .join('\u0003');
}

function mergePrincipalSets(
    ...groups: readonly (readonly RootPrincipalSet[] | undefined)[]
): RootPrincipalSet[] {
    const unique = new Map<string, RootPrincipalSet>();
    for (const group of groups) {
        for (const set of group ?? []) {
            const copy = set.map((requirement) => ({ ...requirement }));
            const key = JSON.stringify(copy);
            if (!unique.has(key)) unique.set(key, copy);
        }
    }
    return [...unique.values()];
}

function principalSetsKey(sets: readonly RootPrincipalSet[]): string {
    return JSON.stringify(sets);
}

function listingKey(item: ServiceListing): string {
    return `${item.serviceId}\u0000${item.interfaceId}\u0000${item.hash}`;
}

function cloneScopes(scopes: readonly ServiceIdPattern[]): ServiceIdPattern[] {
    return scopes.map((scope) => ({ ...scope }));
}

function cloneListing(item: ServiceListing): ServiceListing {
    return {
        ...item,
        ...(item.rootPrincipalSets === undefined
            ? {}
            : {
                rootPrincipalSets: item.rootPrincipalSets.map((set) =>
                    set.map((requirement) => ({ ...requirement }))),
            }),
        ...(item.reachableServiceIds === undefined
            ? {}
            : { reachableServiceIds: cloneScopes(item.reachableServiceIds) }),
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Extract the `transitive` requirements of a CNF requirement collection as
 * singleton AND-sets (kept transitive), so they keep flowing down further hops.
 */
function transitiveReqsOf(sets: readonly RootPrincipalSet[] | undefined): RootPrincipalSet[] {
    return (sets ?? [])
        .flatMap((set) => set.filter((req) => req.transitive === true))
        .map((req) => [req] as RootPrincipalSet);
}

/**
 * Prefer a listing whose reporter (`discoveredFrom`) equals its own `serviceId`
 * — that's the participant speaking about itself, and is more authoritative
 * than an aggregator forwarding it.
 */
function _isAuthoritative(candidate: DiscoveredListing, current: DiscoveredListing): boolean {
    const candidateDirect = candidate.discoveredFrom === candidate.serviceId;
    const currentDirect = current.discoveredFrom === current.serviceId;
    return candidateDirect && !currentDirect;
}
