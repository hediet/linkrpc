import {
    BoundedTrafficSubscription,
    TrafficWatchFlowTracker,
} from '@hediet/linkrpc/inspection';
import type {
    TrafficEvent,
    TrafficSubscription,
    TrafficSubscriptionOptions,
    TrafficTransitEvent,
} from '@hediet/linkrpc/inspection';
import type { NodeTransit, TransitEndpoint } from './nodeTransit';
import type { Hub, IDisposable } from './routing/routingHub';

export interface HubTrafficWatchOptions extends TrafficSubscriptionOptions {}

export interface HubTrafficSubscription extends IDisposable, TrafficSubscription {}

export interface HubTrafficSource {
    observe(observer: (transit: TrafficTransitEvent) => void): IDisposable;
}

interface RegisteredTrafficSource {
    readonly source: HubTrafficSource;
    observation?: IDisposable;
}

/** Publishes dynamically observed raw node transits through bounded traffic streams. */
export class HubInspector implements IDisposable {
    private readonly _subscribers = new Set<BoundedTrafficSubscription>();
    private readonly _trafficSources = new Set<RegisteredTrafficSource>();
    private readonly _trafficWatches = new TrafficWatchFlowTracker();
    private readonly _observation: IDisposable;

    constructor(private readonly _hub: Hub) {
        this._observation = this._hub.observeTransits((transit) => {
            this._onTransit(transit);
        });
    }

    public get observerCount(): number {
        return this._subscribers.size;
    }

    public subscribe(
        options: HubTrafficWatchOptions,
        send: (event: TrafficEvent) => Promise<void>,
    ): HubTrafficSubscription {
        if (
            options.trafficIgnoreKey !== undefined
            && !this._trafficWatches.claim(options.trafficIgnoreKey)
        ) {
            throw new Error('Traffic watch request was not observed before subscription');
        }
        const subscriber = new BoundedTrafficSubscription(options, send, () => {
            this._subscribers.delete(subscriber);
            if (this._subscribers.size === 0) this._stopTrafficSources();
        });
        if (this._subscribers.size === 0) this._startTrafficSources();
        this._subscribers.add(subscriber);
        return subscriber;
    }

    public dispose(): void {
        for (const subscriber of [...this._subscribers]) subscriber.dispose();
        this._subscribers.clear();
        this._observation.dispose();
        this._trafficWatches.clear();
        this._stopTrafficSources();
        this._trafficSources.clear();
    }

    /** Add an endpoint traffic source managed by this Hub inspection service. */
    public addTrafficSource(source: HubTrafficSource): IDisposable {
        const registered: RegisteredTrafficSource = { source };
        this._trafficSources.add(registered);
        if (this._subscribers.size !== 0) this._startTrafficSource(registered);
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this._trafficSources.delete(registered);
                registered.observation?.dispose();
                registered.observation = undefined;
            },
        };
    }

    private _startTrafficSources(): void {
        for (const source of this._trafficSources) this._startTrafficSource(source);
    }

    private _startTrafficSource(source: RegisteredTrafficSource): void {
        source.observation ??= source.source.observe((transit) => this._emitTransit(transit));
    }

    private _stopTrafficSources(): void {
        for (const source of this._trafficSources) {
            source.observation?.dispose();
            source.observation = undefined;
        }
    }

    private _onTransit(transit: NodeTransit): void {
        const event: TrafficTransitEvent = {
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
        };
        if (this._trafficWatches.accept(event)) return;
        if (this._subscribers.size !== 0) this._emitTransit(event);
    }

    private _emitTransit(transit: TrafficTransitEvent): void {
        for (const subscriber of this._subscribers) subscriber.enqueue(transit);
    }
}

function normalizeEndpoint(endpoint: TransitEndpoint) {
    return {
        edgeId: endpoint.edgeId,
        portId: endpoint.portId ?? endpoint.edgeId,
        ...(endpoint.requestId !== undefined ? { requestId: endpoint.requestId } : {}),
    };
}
