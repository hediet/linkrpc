import { randomUUID } from 'node:crypto';
import { ErrorCode, RpcError, type IMessageTransport } from '@hediet/linkrpc';
import type { JsonValue } from '@hediet/linkrpc';
import {
    nodeInterface,
    type NodeInfo,
    type ParticipantDescriptorSource,
    type ServiceId,
    type TopologyGraph,
    type TopologyTransportInfo,
} from '@hediet/linkrpc/hub/common';

export const GET_NODE_ID_METHOD = `${nodeInterface.info.id}::getNodeId`;

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
    private readonly _peerInfo = new WeakMap<IMessageTransport, NodeInfo>();
    private readonly _peerStates = new WeakMap<
        IMessageTransport,
        'identified' | 'pending' | 'unsupported' | 'error'
    >();
    private readonly _peerIdentifications = new WeakMap<IMessageTransport, Promise<NodeInfo>>();
    private readonly _inspectionServices = new WeakMap<IMessageTransport, Set<string>>();
    private readonly _managedRoutingTopologies =
        new WeakMap<IMessageTransport, ManagedRoutingTopology>();
    private readonly _managedTopologyFragments = new Set<ManagedTopologyFragment>();

    constructor(private readonly _options: RoutingTopologyOptions) {}

    public portId(link: IMessageTransport): string {
        let id = this._portIds.get(link);
        if (id === undefined) {
            id = randomUUID();
            this._portIds.set(link, id);
        }
        return id;
    }

    public registerHandle(handle: object, link: IMessageTransport): void {
        this._handleLinks.set(handle, link);
    }

    public identifyPeer(link: IMessageTransport): Promise<NodeInfo> {
        return this._identifyPeer(link);
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
                    peerState: this._peerStates.get(link) ?? 'pending',
                });
                links.push(...(managed.adjacentLinks ?? []));
                continue;
            }
            const transport = this._options.transportInfo(link);
            links.push({
                from: { nodeId: this._options.nodeId, portId: this.portId(link) },
                to: peer,
                label: this._options.edgeId(link),
                peerState: this._peerStates.get(link) ?? 'pending',
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
        this._peerStates.delete(link);
    }

    private _attachedLink(attached: object, operation: string): IMessageTransport {
        const link = this._handleLinks.get(attached);
        if (link === undefined || !this._options.isAttached(link)) {
            throw new Error(`${operation}: link is not attached to this hub`);
        }
        return link;
    }

    private _topologyPeer(link: IMessageTransport): { nodeId: string; portId: string; } {
        const identified = this._peerInfo.get(link);
        if (identified !== undefined) return identified;
        const localPortId = this.portId(link);
        return {
            nodeId: `${this._options.nodeId}:unidentified:${localPortId}`,
            portId: `unidentified:${localPortId}`,
        };
    }

    private _identifyPeer(link: IMessageTransport): Promise<NodeInfo> {
        const cached = this._peerInfo.get(link);
        if (cached !== undefined) return Promise.resolve(cached);
        const active = this._peerIdentifications.get(link);
        if (active !== undefined) return active;
        if (!this._options.isAttached(link)) {
            return Promise.reject(new Error('identifyPeer: link is detached'));
        }

        this._peerStates.set(link, 'pending');
        const identification = this._options.requestOnLink(
            link,
            GET_NODE_ID_METHOD,
            {},
            this._options.peerIdentificationTimeoutMs ?? 1000,
        )
            .then((raw) => {
                if (
                    raw === null
                    || typeof raw !== 'object'
                    || Array.isArray(raw)
                    || typeof (raw as { nodeId?: unknown }).nodeId !== 'string'
                    || (raw as { nodeId: string }).nodeId.length === 0
                    || typeof (raw as { portId?: unknown }).portId !== 'string'
                    || (raw as { portId: string }).portId.length === 0
                ) {
                    throw new Error(
                        `identifyPeer: invalid result from ${GET_NODE_ID_METHOD}`,
                    );
                }
                const info: NodeInfo = {
                    nodeId: (raw as { nodeId: string }).nodeId,
                    portId: (raw as { portId: string }).portId,
                    ...(Array.isArray((raw as { descriptors?: unknown }).descriptors)
                        ? { descriptors: (raw as { descriptors: NodeInfo['descriptors'] }).descriptors }
                        : {}),
                };
                this._peerInfo.set(link, info);
                this._peerStates.set(link, 'identified');
                this._options.onDidChange();
                return info;
            })
            .catch((error: unknown) => {
                this._peerStates.set(
                    link,
                    error instanceof RpcError && error.code === ErrorCode.methodNotFound
                        ? 'unsupported'
                        : 'error',
                );
                this._options.onDidChange();
                throw new Error(
                    `identifyPeer: ${GET_NODE_ID_METHOD} failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            })
            .finally(() => {
                this._peerIdentifications.delete(link);
            });
        this._peerIdentifications.set(link, identification);
        return identification;
    }
}
