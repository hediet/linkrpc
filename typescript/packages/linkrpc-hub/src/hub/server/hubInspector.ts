import { InspectionHost } from '@hediet/linkrpc/inspection';
import type {
    InspectionSource,
    TopologyFragment,
    TrafficEvent,
    TrafficSubscription,
    TrafficSubscriptionOptions,
    TrafficTransitEvent,
} from '@hediet/linkrpc/inspection';
import type { TransitEndpoint } from './nodeTransit';
import type { Hub, IDisposable } from './routing/routingHub';

export interface HubTrafficWatchOptions extends TrafficSubscriptionOptions {}

export interface HubTrafficSubscription extends IDisposable, TrafficSubscription {}

export interface HubTrafficSource {
    observe(observer: (transit: TrafficTransitEvent) => void): IDisposable;
}

/** Publishes dynamically observed raw node transits through bounded traffic streams. */
export class HubInspector implements IDisposable {
    public readonly host: InspectionHost;

    constructor(hub: Hub) {
        this.host = new InspectionHost({ nodeId: hub.nodeId, kind: 'hub' });
        this.host.addSource(new HubInspectionSource(hub));
    }

    public get observerCount(): number {
        return this.host.observerCount;
    }

    public subscribe(
        options: HubTrafficWatchOptions,
        send: (event: TrafficEvent) => Promise<void>,
    ): HubTrafficSubscription {
        return this.host.subscribe(options, send);
    }

    public dispose(): void {
        this.host.dispose();
    }

    /** Add an endpoint traffic source managed by this Hub inspection service. */
    public addTrafficSource(source: HubTrafficSource): IDisposable {
        return this.host.addTrafficSource(source);
    }
}

export class HubInspectionSource implements InspectionSource {
    constructor(private readonly _hub: Hub) {}

    public snapshotTopology(): TopologyFragment {
        const { nodes, links, routes } = this._hub.getTopologyGraph('');
        return { nodes, links, routes };
    }

    public onTopologyChanged(listener: () => void): IDisposable {
        return { dispose: this._hub.onDidChangeTopology(listener) };
    }

    public observeTraffic(observer: (event: TrafficTransitEvent) => void): IDisposable {
        return this._hub.observeTransits((transit) => observer({
            type: 'transit',
            timeMs: transit.timeMs,
            nodeId: transit.nodeId,
            ...(transit.in !== undefined ? { in: normalizeEndpoint(transit.in) } : {}),
            ...(transit.out !== undefined ? { out: normalizeEndpoint(transit.out) } : {}),
            disposition: transit.disposition,
            kind: transit.kind,
            method: transit.method,
            params: transit.params,
            result: transit.result,
            error: transit.error,
        }));
    }
}

function normalizeEndpoint(endpoint: TransitEndpoint) {
    return {
        edgeId: endpoint.edgeId,
        portId: endpoint.portId ?? endpoint.edgeId,
        ...(endpoint.requestId !== undefined ? { requestId: endpoint.requestId } : {}),
    };
}
