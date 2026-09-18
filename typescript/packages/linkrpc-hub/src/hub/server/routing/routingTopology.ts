import type { IMessageTransport } from '@hediet/linkrpc';
import type { JsonValue } from '@hediet/linkrpc';
import {
    type NodeInfo,
    type ParticipantDescriptorSource,
    type TopologyGraph,
    type TopologyTransportInfo,
    type TopologyIdGenerator,
} from '@hediet/linkrpc/inspection';
import type { ServiceId } from '@hediet/linkrpc/hub/common';

import { GET_NODE_ID_METHOD, PeerDiscovery } from './peerDiscovery';
export { GET_NODE_ID_METHOD } from './peerDiscovery';

export interface ManagedRoutingTopology {
    readonly node: TopologyGraph['nodes'][number];
    readonly hubLinks: readonly {
        readonly hubPortId: string;
        readonly nodePortId: string;
        readonly label?: string;
    }[];
    readonly peerPortId: string;
    readonly peerLinkLabel?: string;
    readonly peerTransport?: TopologyTransportInfo;
    readonly adjacentNodes?: TopologyGraph['nodes'];
    readonly adjacentLinks?: TopologyGraph['links'];
}

export interface ManagedTopologyFragment {
    readonly nodes: TopologyGraph['nodes'];
    readonly links?: TopologyGraph['links'];
    readonly routes?: TopologyGraph['routes'];
}

interface Disposable {
    dispose(): void;
}

export interface RoutingTopologyOptions {
    readonly nodeId: string;
    readonly generateTopologyId: TopologyIdGenerator;
    readonly debugName?: string;
    readonly descriptors?: readonly ParticipantDescriptorSource[];
    readonly peerIdentificationTimeoutMs?: number;
    readonly links: () => Iterable<IMessageTransport>;
    readonly forwardingEntries: () => Iterable<readonly [ServiceId, IMessageTransport]>;
    readonly edgeId: (link: IMessageTransport) => string;
    readonly transportInfo: (link: IMessageTransport) => TopologyTransportInfo | undefined;
    readonly isAttached: (link: IMessageTransport) => boolean;
    readonly requestOnLink: (
        link: IMessageTransport,
        method: string,
        params: JsonValue,
        timeoutMs?: number,
    ) => Promise<JsonValue | undefined>;
    readonly onDidChange: () => void;
}

/**
 * Owns the Hub's inspection-facing topology state. Routing remains in Hub;
 * this class only consumes snapshots and low-level request callbacks.
 */
export class RoutingTopology {
    private readonly _portIds = new WeakMap<IMessageTransport, string>();
    private readonly _handleLinks = new WeakMap<object, IMessageTransport>();
    private readonly _peers: PeerDiscovery;
    private readonly _inspectionServices = new WeakMap<IMessageTransport, Set<string>>();
    private readonly _managedRoutingTopologies =
        new WeakMap<IMessageTransport, ManagedRoutingTopology>();
    private readonly _managedTopologyFragments = new Set<ManagedTopologyFragment>();

    constructor(private readonly _options: RoutingTopologyOptions) {
        this._peers = new PeerDiscovery({
            timeoutMs: _options.peerIdentificationTimeoutMs,
            request: (link, timeoutMs) =>
                _options.requestOnLink(link, GET_NODE_ID_METHOD, {}, timeoutMs),
            onDidChange: _options.onDidChange,
        });
    }

    public attachLink(link: IMessageTransport): void {
        this._peers.attach(link);
    }

    public portId(link: IMessageTransport): string {
        let id = this._portIds.get(link);
        if (id === undefined) {
            id = this._options.generateTopologyId('port');
            this._portIds.set(link, id);
        }
        return id;
    }

    public registerHandle(handle: object, link: IMessageTransport): void {
        this._handleLinks.set(handle, link);
    }

    public identifyPeer(link: IMessageTransport): Promise<NodeInfo> {
        return this._peers.identify(link);
    }

    public registerManagedRoutingTopology(
        attached: object,
        topology: ManagedRoutingTopology,
    ): Disposable {
        const link = this._attachedLink(attached, 'registerManagedRoutingTopology');
        this._managedRoutingTopologies.set(link, topology);
        this._options.onDidChange();
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                if (this._managedRoutingTopologies.get(link) !== topology) return;
                this._managedRoutingTopologies.delete(link);
                this._options.onDidChange();
            },
        };
    }

    public registerManagedTopologyFragment(fragment: ManagedTopologyFragment): Disposable {
        this._managedTopologyFragments.add(fragment);
        this._options.onDidChange();
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this._managedTopologyFragments.delete(fragment);
                this._options.onDidChange();
            },
        };
    }

    public markInspectionService(attached: object, serviceId: ServiceId): void {
        const link = this._attachedLink(attached, 'markInspectionService');
        let services = this._inspectionServices.get(link);
        if (services === undefined) {
            services = new Set();
            this._inspectionServices.set(link, services);
        }
        services.add(serviceId);
    }

    public isInspectionService(link: IMessageTransport, serviceId: string): boolean {
        return this._inspectionServices.get(link)?.has(serviceId) === true;
    }

    public getTopologyGraph(observerServiceId: string): TopologyGraph {
        const allLinks = [...this._options.links()];
        const visibleLinks = allLinks.filter((link) => !this._inspectionServices.has(link));
        const hubPorts = allLinks.map((link) => ({
            portId: this.portId(link),
            label: this._options.edgeId(link),
        }));
        for (const link of visibleLinks) {
            for (const hubLink of this._managedRoutingTopologies.get(link)?.hubLinks ?? []) {
                if (!hubPorts.some((port) => port.portId === hubLink.hubPortId)) {
                    hubPorts.push({
                        portId: hubLink.hubPortId,
                        label: hubLink.label ?? hubLink.hubPortId,
                    });
                }
            }
        }
        const nodes: TopologyGraph['nodes'] = [{
            nodeId: this._options.nodeId,
            kind: 'hub',
            ...(this._options.debugName !== undefined
                ? { label: this._options.debugName }
                : {}),
            ...(this._options.descriptors !== undefined
                ? { descriptors: [...this._options.descriptors] }
                : {}),
            ports: hubPorts,
        }];
        const peerNodes = new Map<string, TopologyGraph['nodes'][number]>();
        const links: TopologyGraph['links'] = [];

        for (const link of visibleLinks) {
            const peer = this._topologyPeer(link);
            const managed = this._managedRoutingTopologies.get(link);
            let peerNode = peerNodes.get(peer.nodeId);
            if (peerNode === undefined) {
                peerNode = { nodeId: peer.nodeId, ports: [] };
                peerNodes.set(peer.nodeId, peerNode);
                nodes.push(peerNode);
            }
            if (!peerNode.ports.some((port) => port.portId === peer.portId)) {
                peerNode.ports.push({ portId: peer.portId });
            }
            if (managed !== undefined) {
                nodes.push({
                    ...managed.node,
                    ports: [...managed.node.ports],
                });
                for (const adjacentNode of managed.adjacentNodes ?? []) {
                    nodes.push({
                        ...adjacentNode,
                        ports: [...adjacentNode.ports],
                    });
                }
                for (const hubLink of managed.hubLinks) {
                    links.push({
                        from: { nodeId: this._options.nodeId, portId: hubLink.hubPortId },
                        to: { nodeId: managed.node.nodeId, portId: hubLink.nodePortId },
                        ...(hubLink.label !== undefined ? { label: hubLink.label } : {}),
                    });
                }
                links.push({
                    from: { nodeId: managed.node.nodeId, portId: managed.peerPortId },
                    to: peer,
                    ...(managed.peerLinkLabel !== undefined
                        ? { label: managed.peerLinkLabel }
                        : {}),
                    ...(managed.peerTransport !== undefined
                        ? { transport: managed.peerTransport }
                        : {}),
                    peerState: this._peers.status(link),
                });
                links.push(...(managed.adjacentLinks ?? []));
                continue;
            }
            const transport = this._options.transportInfo(link);
            links.push({
                from: { nodeId: this._options.nodeId, portId: this.portId(link) },
                to: peer,
                label: this._options.edgeId(link),
                peerState: this._peers.status(link),
                ...(transport !== undefined ? { transport } : {}),
            });
        }

        const routes: TopologyGraph['routes'] = [];
        for (const [serviceId, link] of this._options.forwardingEntries()) {
            if (this.isInspectionService(link, serviceId)) {
                routes.push({
                    serviceId,
                    nodeId: this._options.nodeId,
                    portId: this.portId(link),
                    match: 'prefix',
                });
                continue;
            }
            const peer = this._topologyPeer(link);
            routes.push({
                serviceId,
                nodeId: peer.nodeId,
                portId: peer.portId,
                match: 'prefix',
            });
        }
        for (const fragment of this._managedTopologyFragments) {
            nodes.push(...fragment.nodes.map((node) => ({
                ...node,
                ports: [...node.ports],
            })));
            links.push(...(fragment.links ?? []));
            routes.push(...(fragment.routes ?? []));
        }

        return {
            observerServiceId,
            entryNodeId: this._options.nodeId,
            nodes,
            links,
            routes,
        };
    }

    public cleanupLink(link: IMessageTransport): void {
        this._inspectionServices.delete(link);
        this._peers.detach(link);
        this._managedRoutingTopologies.delete(link);
    }

    private _attachedLink(attached: object, operation: string): IMessageTransport {
        const link = this._handleLinks.get(attached);
        if (link === undefined || !this._options.isAttached(link)) {
            throw new Error(`${operation}: link is not attached to this hub`);
        }
        return link;
    }

    private _topologyPeer(link: IMessageTransport): { nodeId: string; portId: string; } {
        const identified = this._peers.info(link);
        if (identified !== undefined) return identified;
        const localPortId = this.portId(link);
        return {
            nodeId: `${this._options.nodeId}:unidentified:${localPortId}`,
            portId: `unidentified:${localPortId}`,
        };
    }
}
