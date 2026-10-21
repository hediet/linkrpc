import type { TopologyGraph, TopologyTransportInfo } from '@hediet/linkrpc/inspection';

const MAX_HOPS = 3;
/** Ports are never reused, so entries stay valid; the oldest are forgotten beyond this. */
const MAX_ENTRIES = 4_096;

/**
 * Describes how the peer behind a hub port is connected, from the hub's
 * topology graph: the nearest link (within a few hops, not crossing the hub)
 * that reports a transport. A participant's transport sits on its overlay's
 * participant link, two hops from the hub port.
 *
 * Call {@link observe} while the port's connection is open (when a call
 * enters): short-lived clients are gone from the topology by the time their
 * call is recorded.
 */
export class PortTransports {
    /** `null`: the port has no transport (or was not in the graph). */
    private readonly _known = new Map<string, string | null>();

    constructor(private readonly _readGraph: () => TopologyGraph) { }

    /** Resolve and remember `portId`'s transport; reads the graph only for unknown ports. */
    public observe(portId: string): void {
        if (this._known.has(portId)) return;
        for (const [port, transport] of _transportsByHubPort(this._readGraph())) {
            if (!this._known.has(port)) this._remember(port, transport);
        }
        if (!this._known.has(portId)) this._remember(portId, null);
    }

    public describe(portId: string): string | undefined {
        return this._known.get(portId) ?? undefined;
    }

    private _remember(portId: string, transport: string | null): void {
        this._known.set(portId, transport);
        if (this._known.size > MAX_ENTRIES) this._known.delete(this._known.keys().next().value!);
    }
}

function _transportsByHubPort(graph: TopologyGraph): Map<string, string | null> {
    const linksOf = new Map<string, TopologyGraph['links']>();
    for (const link of graph.links) {
        for (const nodeId of new Set([link.from.nodeId, link.to.nodeId])) {
            linksOf.set(nodeId, [...linksOf.get(nodeId) ?? [], link]);
        }
    }
    const hub = graph.nodes.find(node => node.nodeId === graph.entryNodeId);
    const result = new Map<string, string | null>();
    for (const port of hub?.ports ?? []) {
        const transport = _nearestTransport(graph.entryNodeId, port.portId, linksOf);
        result.set(port.portId, transport !== undefined ? _format(transport) : null);
    }
    return result;
}

function _nearestTransport(
    hubNodeId: string,
    portId: string,
    linksOf: ReadonlyMap<string, TopologyGraph['links']>,
): TopologyTransportInfo | undefined {
    const isHubPort = (end: { nodeId: string; portId: string; }) => end.nodeId === hubNodeId && end.portId === portId;
    let frontier = (linksOf.get(hubNodeId) ?? []).filter(link => isHubPort(link.from) || isHubPort(link.to));
    const visited = new Set<string>([hubNodeId]);
    for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop++) {
        const withTransport = frontier.find(link => link.transport !== undefined);
        if (withTransport) return withTransport.transport;
        const next: TopologyGraph['links'] = [];
        for (const link of frontier) {
            for (const nodeId of [link.from.nodeId, link.to.nodeId]) {
                if (visited.has(nodeId)) continue;
                visited.add(nodeId);
                next.push(...(linksOf.get(nodeId) ?? []).filter(candidate => candidate !== link));
            }
        }
        frontier = next;
    }
    return undefined;
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
