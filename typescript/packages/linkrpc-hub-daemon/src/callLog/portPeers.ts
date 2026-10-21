import type { ParticipantDescriptor, TopologyGraph, TopologyTransportInfo } from '@hediet/linkrpc/inspection';

const MAX_HOPS = 3;
/** Ports are never reused, so entries stay valid; the oldest are forgotten beyond this. */
const MAX_ENTRIES = 4_096;

/** What the hub's topology graph says about the peer behind one of its ports. */
export interface PortPeer {
    /** How it is connected, e.g. `named-pipe \\.\pipe\…` or `websocket 10.0.0.2:5000`. */
    readonly transport?: string;
    /** The attacher's description of it, e.g. which managed service it is. */
    readonly descriptor?: ParticipantDescriptor;
}

/**
 * Describes the peer behind a hub port from the hub's topology graph: the
 * nearest link (within a few hops, not crossing the hub) that reports a
 * transport, and the nearest node with an attacher descriptor. A participant's
 * transport sits on its overlay's participant link, and its descriptor on the
 * node at the far end, two hops from the hub port.
 *
 * Call {@link observe} while the port's connection is open (when a call
 * enters): short-lived clients are gone from the topology by the time their
 * call is recorded.
 */
export class PortPeers {
    private readonly _known = new Map<string, PortPeer>();

    constructor(private readonly _readGraph: () => TopologyGraph) { }

    /** Resolve and remember `portId`'s peer; reads the graph only for unknown ports. */
    public observe(portId: string): void {
        if (this._known.has(portId)) return;
        for (const [port, peer] of _peersByHubPort(this._readGraph())) {
            if (!this._known.has(port)) this._remember(port, peer);
        }
        if (!this._known.has(portId)) this._remember(portId, {});
    }

    public describe(portId: string): PortPeer {
        return this._known.get(portId) ?? {};
    }

    private _remember(portId: string, peer: PortPeer): void {
        this._known.set(portId, peer);
        if (this._known.size > MAX_ENTRIES) this._known.delete(this._known.keys().next().value!);
    }
}

function _peersByHubPort(graph: TopologyGraph): Map<string, PortPeer> {
    const linksOf = new Map<string, TopologyGraph['links']>();
    for (const link of graph.links) {
        for (const nodeId of new Set([link.from.nodeId, link.to.nodeId])) {
            linksOf.set(nodeId, [...linksOf.get(nodeId) ?? [], link]);
        }
    }
    const nodes = new Map(graph.nodes.map(node => [node.nodeId, node]));
    const result = new Map<string, PortPeer>();
    for (const port of nodes.get(graph.entryNodeId)?.ports ?? []) {
        result.set(port.portId, _peerOf(graph.entryNodeId, port.portId, linksOf, nodes));
    }
    return result;
}

function _peerOf(
    hubNodeId: string,
    portId: string,
    linksOf: ReadonlyMap<string, TopologyGraph['links']>,
    nodes: ReadonlyMap<string, TopologyGraph['nodes'][number]>,
): PortPeer {
    const isHubPort = (end: { nodeId: string; portId: string; }) => end.nodeId === hubNodeId && end.portId === portId;
    let frontier = (linksOf.get(hubNodeId) ?? []).filter(link => isHubPort(link.from) || isHubPort(link.to));
    const visited = new Set<string>([hubNodeId]);
    let transport: TopologyTransportInfo | undefined;
    let descriptor: ParticipantDescriptor | undefined;
    for (let hop = 0; hop < MAX_HOPS && frontier.length > 0 && (!transport || !descriptor); hop++) {
        transport ??= frontier.find(link => link.transport !== undefined)?.transport;
        const next: TopologyGraph['links'] = [];
        for (const link of frontier) {
            for (const nodeId of [link.from.nodeId, link.to.nodeId]) {
                if (visited.has(nodeId)) continue;
                visited.add(nodeId);
                descriptor ??= nodes.get(nodeId)?.descriptors?.find(source => source.source === 'attacher')?.descriptor;
                next.push(...(linksOf.get(nodeId) ?? []).filter(candidate => candidate !== link));
            }
        }
        frontier = next;
    }
    return {
        ...(transport !== undefined ? { transport: _format(transport) } : {}),
        ...(descriptor !== undefined ? { descriptor } : {}),
    };
}

function _format(transport: TopologyTransportInfo): string {
    const remote = transport.remote;
    const where = transport.path
        ?? (remote?.address !== undefined ? `${remote.address}${remote.port !== undefined ? `:${remote.port}` : ''}` : undefined);
    const forwardedFor = transport.metadata?.forwardedFor;
    return [transport.type, where, forwardedFor !== undefined ? `(for ${String(forwardedFor)})` : undefined]
        .filter(part => part !== undefined)
        .join(' ');
}
