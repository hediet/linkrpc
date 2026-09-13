import type { LinkRpcConnection } from '@hediet/linkrpc';
import type {
    TopologyGraph,
    TrafficOverflowEvent,
    TrafficTransitEvent,
} from '@hediet/linkrpc/inspection';
import {
    TrafficClient,
    type TrafficCallbacks,
    type TrafficWatch,
    type TrafficWatchOptions,
    type TrafficWatchWithPayloadsOptions,
} from './trafficClient';
import { TopologyClient, type TopologyWatch } from './topologyClient';
import { mergeTopologyGraphs, type NetworkTopologyGraph } from './topologyGraph';

export interface NetworkInspectionClientOptions {
    onGraph?(graph: NetworkTopologyGraph): void;
    onError?(error: unknown, sourceServiceId: string): void;
}

export interface NetworkTrafficCallbacks {
    onTransit(transit: TrafficTransitEvent, sourceServiceId: string): void;
    onOverflow?(overflow: TrafficOverflowEvent, sourceServiceId: string): void;
    onError?(error: unknown, sourceServiceId: string): void;
}

export interface NetworkTrafficWatch {
    readonly done: Promise<void>;
    cancel(reason?: string): Promise<void>;
}

interface TopologySource {
    readonly client: TopologyClient<unknown, unknown>;
    readonly watch: TopologyWatch;
    graph: TopologyGraph | undefined;
}

/**
 * Merges independently observed service graphs. Traffic is deliberately not
 * deduplicated: each source remains identified so consumers can stitch flows.
 */
export class NetworkInspectionClient {
    private readonly _sources = new Map<string, TopologySource>();
    private readonly _trafficGroups = new Set<NetworkTrafficGroup>();

    constructor(
        private readonly _connection: LinkRpcConnection<unknown, unknown>,
        private readonly _options: NetworkInspectionClientOptions = {},
    ) { }

    public async addTopologyService(serviceId: string): Promise<void> {
        const existing = this._sources.get(serviceId);
        if (existing !== undefined) {
            await existing.watch.ready;
            return;
        }

        const client = new TopologyClient(this._connection, serviceId);
        let source!: TopologySource;
        const watch = client.watch({
            onGraph: (graph) => {
                source.graph = graph;
                this._options.onGraph?.(this.getGraph());
            },
            onError: (error) => this._options.onError?.(error, serviceId),
        });
        source = { client, watch, graph: undefined };
        this._sources.set(serviceId, source);
        for (const group of this._trafficGroups) group.add(serviceId);
        try {
            await watch.ready;
        } catch (error) {
            if (this._sources.get(serviceId) === source) {
                await this.removeTopologyService(serviceId);
            } else {
                await source.watch.cancel('source-replaced').catch(() => undefined);
                await source.watch.done.catch(() => undefined);
            }
            throw error;
        }
    }

    public async removeTopologyService(serviceId: string): Promise<void> {
        const source = this._sources.get(serviceId);
        if (source === undefined) return;
        this._sources.delete(serviceId);
        await Promise.all([...this._trafficGroups].map((group) => group.remove(serviceId)));
        await source.watch.cancel('source-removed');
        await source.watch.done.catch(() => undefined);
        this._options.onGraph?.(this.getGraph());
    }

    public getGraph(): NetworkTopologyGraph {
        return mergeTopologyGraphs(
            [...this._sources.entries()]
                .flatMap(([source, value]) =>
                    value.graph === undefined ? [] : [{ source, graph: value.graph }]),
        );
    }

    public watchTraffic(
        options: TrafficWatchOptions | TrafficWatchWithPayloadsOptions,
        callbacks: NetworkTrafficCallbacks,
    ): NetworkTrafficWatch {
        const group = new NetworkTrafficGroup(
            this._connection,
            options,
            callbacks,
            () => this._trafficGroups.delete(group),
        );
        this._trafficGroups.add(group);
        for (const serviceId of this._sources.keys()) group.add(serviceId);
        return group;
    }

    public async dispose(): Promise<void> {
        const failures: unknown[] = [];
        const trafficResults = await Promise.allSettled(
            [...this._trafficGroups].map((group) => group.cancel('disposed')),
        );
        failures.push(...trafficResults.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []));
        const sourceResults = await Promise.allSettled(
            [...this._sources.keys()].map((serviceId) => this.removeTopologyService(serviceId)),
        );
        failures.push(...sourceResults.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []));
        if (failures.length !== 0) {
            throw new AggregateError(failures, 'Failed to dispose network inspection');
        }
    }
}

class NetworkTrafficGroup implements NetworkTrafficWatch {
    private readonly _watches = new Map<string, TrafficWatch>();
    private _active = true;
    private readonly _resolveDone: () => void;
    public readonly done: Promise<void>;

    constructor(
        private readonly _connection: LinkRpcConnection<unknown, unknown>,
        private readonly _options: TrafficWatchOptions | TrafficWatchWithPayloadsOptions,
        private readonly _callbacks: NetworkTrafficCallbacks,
        private readonly _onCancel: () => void,
    ) {
        let resolve!: () => void;
        this.done = new Promise<void>((r) => resolve = r);
        this._resolveDone = resolve;
    }

    public add(serviceId: string): void {
        if (!this._active || this._watches.has(serviceId)) return;
        const client = new TrafficClient(this._connection, serviceId);
        const callbacks: TrafficCallbacks = {
            onTransit: (transit) => this._callbacks.onTransit(transit, serviceId),
            onOverflow: (overflow) => this._callbacks.onOverflow?.(overflow, serviceId),
            onError: (error) => this._callbacks.onError?.(error, serviceId),
        };
        const watch = 'maxPayloadBytes' in this._options
            ? client.watchWithPayloads(this._options, callbacks)
            : client.watch(this._options, callbacks);
        this._watches.set(serviceId, watch);
    }

    public async remove(serviceId: string): Promise<void> {
        const watch = this._watches.get(serviceId);
        if (watch === undefined) return;
        this._watches.delete(serviceId);
        await watch.cancel('source-removed').catch(() => undefined);
        await watch.done.catch(() => undefined);
    }

    public async cancel(reason?: string): Promise<void> {
        if (!this._active) return this.done;
        this._active = false;
        this._onCancel();
        const watches = [...this._watches.values()];
        this._watches.clear();
        const failures: unknown[] = [];
        try {
            const results = await Promise.allSettled(watches.map(async (watch) => {
                await watch.cancel(reason);
                await watch.done;
            }));
            failures.push(...results.flatMap((result) =>
                result.status === 'rejected' ? [result.reason] : []));
        } finally {
            this._resolveDone();
        }
        if (failures.length !== 0) {
            throw new AggregateError(failures, 'Failed to cancel network traffic watches');
        }
    }
}
