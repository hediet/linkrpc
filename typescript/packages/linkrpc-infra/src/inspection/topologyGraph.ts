import type {
    RouteClaim,
    TopologyGraph,
    TopologyLink,
    TopologyLinkEndpoint,
    TopologyNode,
} from '@hediet/linkrpc/inspection';

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
