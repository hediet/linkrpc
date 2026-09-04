import type { LinkRpcConnection } from '../../connection/linkRpcConnection';
import {
    HubDirectoryExplorer,
    topologyInterface,
    type HubDirectoryGraphSnapshot,
    type TopologyGraph,
} from '../common';
import {
    mergeTopologyGraphs,
    type NetworkTopologyGraph,
} from './networkInspectionClient';
import { TopologyClient, type TopologyWatch } from './topologyClient';

export type TopologySourceState = 'loading' | 'ready' | 'error';

export interface TopologySourceSnapshot {
    readonly serviceId: string;
    readonly state: TopologySourceState;
    readonly graph?: TopologyGraph;
    readonly error?: string;
}

export interface TopologyNetworkSnapshot {
    readonly revision: number;
    readonly complete: boolean;
    readonly directory?: HubDirectoryGraphSnapshot;
    readonly directoryError?: string;
    readonly sources: readonly TopologySourceSnapshot[];
    readonly graph: NetworkTopologyGraph;
}

export interface TopologyNetworkOptions {
    /**
     * Fixed topology providers. When omitted, providers are discovered through
     * the directory graph by their `hubrpc.topology` interface.
     */
    readonly sourceServiceIds?: readonly string[];
    readonly maxDepth?: number;
}

export interface TopologyNetworkQueryCallbacks {
    onSnapshot?(snapshot: TopologyNetworkSnapshot): void;
}

export interface TopologyNetworkWatch {
    readonly snapshot: TopologyNetworkSnapshot;
    readonly ready: Promise<TopologyNetworkSnapshot>;
    readonly done: Promise<void>;
    subscribe(listener: (snapshot: TopologyNetworkSnapshot) => void): () => void;
    cancel(reason?: string): Promise<void>;
}

/**
 * Queries or watches a merged topology graph from one, many, or dynamically
 * discovered topology providers. Query mode never registers directory or
 * topology watches; progress snapshots describe its finite request fan-out.
 */
export class TopologyNetworkClient {
    public constructor(
        private readonly _connection: LinkRpcConnection<unknown, unknown>,
    ) {}

    public async query(
        options: TopologyNetworkOptions = {},
        callbacks: TopologyNetworkQueryCallbacks = {},
    ): Promise<TopologyNetworkSnapshot> {
        const store = new TopologyNetworkStore();
        const unsubscribe = callbacks.onSnapshot === undefined
            ? undefined
            : store.subscribe(callbacks.onSnapshot);
        try {
            if (options.sourceServiceIds !== undefined) {
                const serviceIds = uniqueSorted(options.sourceServiceIds);
                store.reconcileSources(serviceIds);
                await Promise.all(serviceIds.map((serviceId) =>
                    this._querySource(store, serviceId)));
            } else {
                await this._queryDiscovered(store, options);
            }
            store.setComplete();
            return store.snapshot;
        } finally {
            unsubscribe?.();
        }
    }

    public watch(options: TopologyNetworkOptions = {}): TopologyNetworkWatch {
        return new TopologyNetworkWatchImpl(this._connection, options);
    }

    private async _queryDiscovered(
        store: TopologyNetworkStore,
        options: TopologyNetworkOptions,
    ): Promise<void> {
        const explorer = new HubDirectoryExplorer(this._connection.channel, {
            interfaceId: topologyInterface.info.id,
            maxDepth: options.maxDepth,
        });
        const queries = new Map<string, Promise<void>>();
        const reconcile = (snapshot: HubDirectoryGraphSnapshot): void => {
            store.setDirectory(snapshot);
            const serviceIds = topologyServiceIds(snapshot);
            store.reconcileSources(serviceIds);
            for (const serviceId of serviceIds) {
                if (!queries.has(serviceId)) {
                    queries.set(serviceId, this._querySource(store, serviceId));
                }
            }
        };
        const unsubscribe = explorer.subscribe((event) => reconcile(event.snapshot));
        try {
            await explorer.explore();
            reconcile(explorer.graphSnapshot);
        } catch (error) {
            store.setDirectoryError(error);
        } finally {
            unsubscribe();
            explorer.dispose();
        }
        await Promise.all(queries.values());
    }

    private async _querySource(
        store: TopologyNetworkStore,
        serviceId: string,
    ): Promise<void> {
        try {
            const graph = await new TopologyClient(this._connection, serviceId).getGraph();
            if (store.hasSource(serviceId)) store.setSourceGraph(serviceId, graph);
        } catch (error) {
            if (store.hasSource(serviceId)) store.setSourceError(serviceId, error);
        }
    }
}

class TopologyNetworkWatchImpl implements TopologyNetworkWatch {
    private readonly _store = new TopologyNetworkStore();
    private readonly _sourceWatches = new Map<string, TopologyWatch>();
    private readonly _initialSourceReady = new Map<string, Promise<void>>();
    private readonly _explorer: HubDirectoryExplorer | undefined;
    private _stopDirectoryWatch: (() => void) | undefined;
    private _cancelled = false;
    private _resolveDone!: () => void;
    private _resolveReady!: (snapshot: TopologyNetworkSnapshot) => void;
    private _readySettled = false;

    public readonly ready = new Promise<TopologyNetworkSnapshot>((resolve) => {
        this._resolveReady = resolve;
    });
    public readonly done = new Promise<void>((resolve) => {
        this._resolveDone = resolve;
    });

    public constructor(
        private readonly _connection: LinkRpcConnection<unknown, unknown>,
        private readonly _options: TopologyNetworkOptions,
    ) {
        this._explorer = _options.sourceServiceIds === undefined
            ? new HubDirectoryExplorer(_connection.channel, {
                interfaceId: topologyInterface.info.id,
                maxDepth: _options.maxDepth,
            })
            : undefined;
        void this._initialize();
    }

    public get snapshot(): TopologyNetworkSnapshot {
        return this._store.snapshot;
    }

    public subscribe(listener: (snapshot: TopologyNetworkSnapshot) => void): () => void {
        return this._store.subscribe(listener);
    }

    public async cancel(reason = 'topology watch cancelled'): Promise<void> {
        if (this._cancelled) return this.done;
        this._cancelled = true;
        this._stopDirectoryWatch?.();
        this._stopDirectoryWatch = undefined;
        this._explorer?.dispose();
        const watches = [...this._sourceWatches.values()];
        this._sourceWatches.clear();
        await Promise.allSettled(watches.map((watch) => watch.cancel(reason)));
        if (!this._readySettled) this._settleReady();
        this._resolveDone();
    }

    private async _initialize(): Promise<void> {
        try {
            if (this._options.sourceServiceIds !== undefined) {
                const serviceIds = uniqueSorted(this._options.sourceServiceIds);
                this._store.reconcileSources(serviceIds);
                for (const serviceId of serviceIds) this._startSourceWatch(serviceId);
            } else {
                const explorer = this._explorer!;
                explorer.subscribe((event) => this._reconcileDirectory(event.snapshot));
                this._stopDirectoryWatch = await explorer.watch(() => {});
                this._reconcileDirectory(explorer.graphSnapshot);
            }
            await Promise.allSettled(this._initialSourceReady.values());
            if (!this._cancelled) {
                this._store.setComplete();
                this._settleReady();
            }
        } catch (error) {
            if (!this._cancelled) {
                this._store.setDirectoryError(error);
                this._store.setComplete();
                this._settleReady();
            }
        }
    }

    private _reconcileDirectory(snapshot: HubDirectoryGraphSnapshot): void {
        if (this._cancelled) return;
        this._store.setDirectory(snapshot);
        const serviceIds = topologyServiceIds(snapshot);
        const desired = new Set(serviceIds);
        for (const serviceId of serviceIds) this._startSourceWatch(serviceId);
        for (const [serviceId, watch] of this._sourceWatches) {
            if (desired.has(serviceId)) continue;
            this._sourceWatches.delete(serviceId);
            this._initialSourceReady.delete(serviceId);
            this._store.removeSource(serviceId);
            void watch.cancel('topology source removed').catch(() => undefined);
        }
    }

    private _startSourceWatch(serviceId: string): void {
        if (this._sourceWatches.has(serviceId) || this._cancelled) return;
        this._store.ensureSource(serviceId);
        const watch = new TopologyClient(this._connection, serviceId).watch({
            onGraph: (graph) => {
                if (!this._cancelled && this._sourceWatches.get(serviceId) === watch) {
                    this._store.setSourceGraph(serviceId, graph);
                }
            },
            onError: (error) => {
                if (!this._cancelled && this._sourceWatches.get(serviceId) === watch) {
                    this._store.setSourceError(serviceId, error);
                }
            },
        });
        this._sourceWatches.set(serviceId, watch);
        const initial = watch.ready.then(
            () => undefined,
            (error) => {
                if (!this._cancelled && this._sourceWatches.get(serviceId) === watch) {
                    this._store.setSourceError(serviceId, error);
                }
            },
        );
        this._initialSourceReady.set(serviceId, initial);
        void watch.done.catch((error) => {
            if (!this._cancelled && this._sourceWatches.get(serviceId) === watch) {
                this._store.setSourceError(serviceId, error);
            }
        });
    }

    private _settleReady(): void {
        if (this._readySettled) return;
        this._readySettled = true;
        this._resolveReady(this._store.snapshot);
    }
}

interface MutableTopologySource {
    readonly serviceId: string;
    state: TopologySourceState;
    graph?: TopologyGraph;
    error?: string;
}

class TopologyNetworkStore {
    private readonly _sources = new Map<string, MutableTopologySource>();
    private readonly _listeners = new Set<(snapshot: TopologyNetworkSnapshot) => void>();
    private _revision = 0;
    private _complete = false;
    private _directory: HubDirectoryGraphSnapshot | undefined;
    private _directoryError: string | undefined;

    public get snapshot(): TopologyNetworkSnapshot {
        const sources = [...this._sources.values()]
            .sort((a, b) => a.serviceId.localeCompare(b.serviceId))
            .map((source): TopologySourceSnapshot => ({
                serviceId: source.serviceId,
                state: source.state,
                ...(source.graph !== undefined ? { graph: source.graph } : {}),
                ...(source.error !== undefined ? { error: source.error } : {}),
            }));
        return {
            revision: this._revision,
            complete: this._complete,
            ...(this._directory !== undefined ? { directory: this._directory } : {}),
            ...(this._directoryError !== undefined
                ? { directoryError: this._directoryError }
                : {}),
            sources,
            graph: mergeTopologyGraphs(sources.flatMap((source) =>
                source.graph === undefined
                    ? []
                    : [{ source: source.serviceId, graph: source.graph }])),
        };
    }

    public subscribe(listener: (snapshot: TopologyNetworkSnapshot) => void): () => void {
        this._listeners.add(listener);
        listener(this.snapshot);
        return () => this._listeners.delete(listener);
    }

    public hasSource(serviceId: string): boolean {
        return this._sources.has(serviceId);
    }

    public ensureSource(serviceId: string): void {
        if (this._sources.has(serviceId)) return;
        this._sources.set(serviceId, { serviceId, state: 'loading' });
        this._emit();
    }

    public reconcileSources(serviceIds: readonly string[]): void {
        const desired = new Set(serviceIds);
        let changed = false;
        for (const serviceId of serviceIds) {
            if (!this._sources.has(serviceId)) {
                this._sources.set(serviceId, { serviceId, state: 'loading' });
                changed = true;
            }
        }
        for (const serviceId of this._sources.keys()) {
            if (!desired.has(serviceId)) {
                this._sources.delete(serviceId);
                changed = true;
            }
        }
        if (changed) this._emit();
    }

    public removeSource(serviceId: string): void {
        if (this._sources.delete(serviceId)) this._emit();
    }

    public setSourceGraph(serviceId: string, graph: TopologyGraph): void {
        const source = this._sources.get(serviceId);
        if (source === undefined) return;
        source.state = 'ready';
        source.graph = graph;
        source.error = undefined;
        this._emit();
    }

    public setSourceError(serviceId: string, error: unknown): void {
        const source = this._sources.get(serviceId);
        if (source === undefined) return;
        source.state = 'error';
        source.error = errorMessage(error);
        this._emit();
    }

    public setDirectory(snapshot: HubDirectoryGraphSnapshot): void {
        this._directory = snapshot;
        this._directoryError = undefined;
        this._emit();
    }

    public setDirectoryError(error: unknown): void {
        this._directoryError = errorMessage(error);
        this._emit();
    }

    public setComplete(): void {
        if (this._complete) return;
        this._complete = true;
        this._emit();
    }

    private _emit(): void {
        this._revision++;
        const snapshot = this.snapshot;
        for (const listener of [...this._listeners]) {
            try {
                listener(snapshot);
            } catch {
                // A consumer cannot disrupt source reconciliation.
            }
        }
    }
}

function topologyServiceIds(snapshot: HubDirectoryGraphSnapshot): string[] {
    return uniqueSorted(snapshot.result.listings
        .filter((listing) => listing.interfaceId === topologyInterface.info.id)
        .map((listing) => listing.serviceId));
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
