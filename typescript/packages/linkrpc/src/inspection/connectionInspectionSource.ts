import type { LinkRpcConnection, InterfaceRegistration } from '../connection/linkRpcConnection';
import { EndpointTrafficInspector } from './endpointTrafficInspector';
import type { InspectionSource, TopologyFragment } from './inspectionHost';
import type { TopologyLink, TopologyNode, TrafficTransitEvent } from './inspection.interfaces';

export interface TrackConnectionOptions {
    readonly portId: string;
    readonly label?: string;
    /** Explicit peer identity; foreign protocols need not support discovery. */
    readonly peer?: {
        readonly nodeId: string;
        readonly portId: string;
        readonly label?: string;
    };
    readonly transport?: TopologyLink['transport'];
}

export class ConnectionInspectionSource<TIn, TOut> implements InspectionSource {
    constructor(
        private readonly _connection: LinkRpcConnection<TIn, TOut>,
        private readonly _nodeId: string,
        private readonly _options: TrackConnectionOptions,
        private readonly _isObserved: () => boolean,
    ) {}

    public snapshotTopology(): TopologyFragment {
        const { portId, label, peer, transport } = this._options;
        const nodes: TopologyNode[] = [{
            nodeId: this._nodeId,
            ports: [{ portId, ...(label === undefined ? {} : { label }) }],
        }];
        const links: TopologyLink[] = [];
        if (peer !== undefined) {
            nodes.push({
                nodeId: peer.nodeId, kind: 'endpoint',
                ...(peer.label === undefined ? {} : { label: peer.label }),
                ports: [{ portId: peer.portId }],
            });
            links.push({
                from: { nodeId: this._nodeId, portId },
                to: { nodeId: peer.nodeId, portId: peer.portId },
                peerState: 'identified',
                ...(transport === undefined ? {} : { transport }),
            });
        }
        return { nodes, links, routes: [] };
    }

    public onTopologyChanged(_listener: () => void): InterfaceRegistration {
        return { dispose: () => {} };
    }

    public observeTraffic(listener: (event: TrafficTransitEvent) => void): InterfaceRegistration {
        const inspector = new EndpointTrafficInspector(
            this._nodeId, this._options.portId, listener, this._isObserved,
        );
        const observation = this._connection.observeWireMessages(inspector.observe);
        return { dispose: () => {
            observation.dispose();
            inspector.dispose();
        } };
    }
}
