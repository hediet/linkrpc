import type { LinkRpcConnection } from '../../connection/linkRpcConnection';
import type {
    RouteClaim,
    TopologyGraph,
    TopologyLink,
    TopologyLinkEndpoint,
    TopologyNode,
    TrafficOverflowEvent,
    TrafficTransitEvent,
} from '../common/inspection.interfaces';
import {
    TrafficClient,
    type TrafficCallbacks,
    type TrafficWatch,
    type TrafficWatchOptions,
    type TrafficWatchWithPayloadsOptions,
} from './trafficClient';
import { TopologyClient, type TopologyWatch } from './topologyClient';

export interface SourcedTopologyNode extends TopologyNode {
    readonly sources: readonly string[];
}

export interface SourcedTopologyLink extends TopologyLink {
    readonly sources: readonly string[];
}

export interface SourcedRouteClaim extends RouteClaim {
    readonly sources: readonly string[];
}

export interface NetworkTopologyGraph {
    readonly nodes: readonly SourcedTopologyNode[];
    readonly links: readonly SourcedTopologyLink[];
    readonly routes: readonly SourcedRouteClaim[];
    readonly sources: readonly {
        serviceId: string;
        observerServiceId: string;
        entryNodeId: string;
    }[];
}

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

export function mergeTopologyGraphs(
    inputs: readonly { source: string; graph: TopologyGraph; }[],
): NetworkTopologyGraph {
    const nodes = new Map<string, { value: TopologyNode; sources: Set<string>; }>();
    const links = new Map<string, { value: TopologyLink; sources: Set<string>; }>();
    const routes = new Map<string, { value: RouteClaim; sources: Set<string>; }>();

    for (const { source, graph } of [...inputs].sort((a, b) => a.source.localeCompare(b.source))) {
        for (const node of graph.nodes) {
            const existing = nodes.get(node.nodeId);
            if (existing === undefined) {
                nodes.set(node.nodeId, { value: cloneTopologyNode(node), sources: new Set([source]) });
            } else {
                existing.sources.add(source);
                if (node.kind === 'hub') {
                    existing.value.kind = 'hub';
                }
                existing.value.label ??= node.label;
                for (const port of node.ports) {
                    const current = existing.value.ports.find((candidate) =>
                        candidate.portId === port.portId);
                    if (current === undefined) {
                        existing.value.ports.push({ ...port });
                    } else {
                        current.label ??= port.label;
                    }
                }
                const descriptors = existing.value.descriptors ?? [];
                const descriptorKeys = new Set(descriptors.map(descriptorKey));
                for (const descriptor of node.descriptors ?? []) {
                    const key = descriptorKey(descriptor);
                    if (!descriptorKeys.has(key)) {
                        descriptors.push(cloneParticipantDescriptorSource(descriptor));
                        descriptorKeys.add(key);
                    }
                }
                if (descriptors.length > 0) existing.value.descriptors = descriptors;
            }
        }
        for (const link of graph.links) {
            const isReversed = endpointKey(link.from) > endpointKey(link.to);
            const [from, to] = canonicalEndpoints(link.from, link.to);
            const key = `${endpointKey(from)}\u0000${endpointKey(to)}`;
            const value: TopologyLink = {
                ...link,
                from,
                to,
                ...(link.transport === undefined
                    ? {}
                    : { transport: cloneTopologyTransport(link.transport, isReversed) }),
            };
            const existing = links.get(key);
            if (existing === undefined) {
                links.set(key, { value, sources: new Set([source]) });
            } else {
                existing.sources.add(source);
                existing.value.transport ??= value.transport;
            }
        }
        for (const route of graph.routes) {
            const key = `${route.serviceId}\u0000${route.nodeId}\u0000${route.portId}\u0000${route.match}`;
            const existing = routes.get(key);
            if (existing === undefined) {
                routes.set(key, { value: { ...route }, sources: new Set([source]) });
            } else {
                existing.sources.add(source);
            }
        }
    }

    const sourcedRoutes = [...routes.values()].map(({ value, sources }) => ({
        ...value,
        sources: [...sources].sort(),
    }));
    return {
        nodes: [...nodes.values()].map(({ value, sources }) => ({
            ...value,
            ports: [...value.ports].sort((a, b) => a.portId.localeCompare(b.portId)),
            ...(value.descriptors === undefined ? {} : {
                descriptors: [...value.descriptors].sort((a, b) =>
                    descriptorKey(a).localeCompare(descriptorKey(b))),
            }),
            sources: [...sources].sort(),
        })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
        links: [...links.values()].map(({ value, sources }) => ({
            ...value,
            sources: [...sources].sort(),
        })).sort((a, b) =>
            endpointKey(a.from).localeCompare(endpointKey(b.from))
            || endpointKey(a.to).localeCompare(endpointKey(b.to))),
        routes: sourcedRoutes.sort((a, b) =>
            a.serviceId.localeCompare(b.serviceId)
            || a.nodeId.localeCompare(b.nodeId)
            || a.portId.localeCompare(b.portId)
            || a.match.localeCompare(b.match)),
        sources: [...inputs].sort((a, b) => a.source.localeCompare(b.source)).map(({ source, graph }) => ({
            serviceId: source,
            observerServiceId: graph.observerServiceId,
            entryNodeId: graph.entryNodeId,
        })),
    };
}

function cloneTopologyNode(node: TopologyNode): TopologyNode {
    return {
        ...node,
        ports: node.ports.map((port) => ({ ...port })),
        ...(node.descriptors === undefined ? {} : {
            descriptors: node.descriptors.map(cloneParticipantDescriptorSource),
        }),
    };
}

function cloneParticipantDescriptorSource(
    source: NonNullable<TopologyNode['descriptors']>[number],
): NonNullable<TopologyNode['descriptors']>[number] {
    return {
        ...source,
        descriptor: {
            ...source.descriptor,
            ...(source.descriptor.metadata === undefined
                ? {}
                : { metadata: { ...source.descriptor.metadata } }),
        },
    };
}

function cloneTopologyTransport(
    transport: NonNullable<TopologyLink['transport']>,
    reverse: boolean,
): NonNullable<TopologyLink['transport']> {
    const {
        local: reportedLocal,
        remote: reportedRemote,
        metadata,
        ...rest
    } = transport;
    const local = reverse ? reportedRemote : reportedLocal;
    const remote = reverse ? reportedLocal : reportedRemote;
    return {
        ...rest,
        ...(local === undefined ? {} : { local: { ...local } }),
        ...(remote === undefined ? {} : { remote: { ...remote } }),
        ...(metadata === undefined ? {} : { metadata: { ...metadata } }),
    };
}

function descriptorKey(
    source: NonNullable<TopologyNode['descriptors']>[number],
): string {
    const descriptor = source.descriptor;
    const metadata = descriptor.metadata === undefined
        ? undefined
        : Object.fromEntries(Object.entries(descriptor.metadata).sort(([a], [b]) =>
            a.localeCompare(b)));
    return JSON.stringify({
        source: source.source,
        descriptor: {
            ...descriptor,
            ...(metadata === undefined ? {} : { metadata }),
        },
    });
}

function canonicalEndpoints(
    a: TopologyLinkEndpoint,
    b: TopologyLinkEndpoint,
): readonly [TopologyLinkEndpoint, TopologyLinkEndpoint] {
    return endpointKey(a) <= endpointKey(b) ? [a, b] : [b, a];
}

function endpointKey(endpoint: TopologyLinkEndpoint): string {
    return `${endpoint.nodeId}\u0000${endpoint.portId}`;
}
