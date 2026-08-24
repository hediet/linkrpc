import {
    isNotification,
    isRequest,
    isResponse,
    type JsonRpcMessage,
    type RequestId,
} from '../protocol/jsonRpc';
import {
    STREAM_METHOD,
    type StreamSendParams,
} from './streaming';
import type {
    TrafficEvent,
    TrafficTransitEvent,
} from '../hub/common/inspection.interfaces';
import {
    BoundedTrafficSubscription,
    type TrafficSubscription,
    type TrafficSubscriptionOptions,
} from '../hub/common/boundedTrafficSubscription';
import type { WireMessageDirection, WireMessageObserver } from './channel';

interface RequestCorrelation {
    readonly method: string;
}

export interface EndpointTrafficWatchOptions extends TrafficSubscriptionOptions {}

export interface EndpointTrafficSubscription extends TrafficSubscription {}

export interface EndpointTrafficObservation {
    dispose(): void;
}

export class EndpointTrafficInspector {
    private readonly _subscribers = new Set<BoundedTrafficSubscription>();
    private readonly _observers = new Set<(transit: TrafficTransitEvent) => void>();
    private readonly _outboundRequests = new Map<string, RequestCorrelation>();
    private readonly _inboundRequests = new Map<string, RequestCorrelation>();

    public readonly observe: WireMessageObserver = (direction, message) => {
        this._onMessage(direction, message);
    };

    constructor(
        private readonly _nodeId: string,
        private readonly _portId: string,
        private readonly _setActive: (active: boolean) => void,
    ) { }

    public get observerCount(): number {
        return this._subscribers.size + this._observers.size;
    }

    public subscribe(
        options: EndpointTrafficWatchOptions,
        send: (event: TrafficEvent) => Promise<void>,
    ): EndpointTrafficSubscription {
        const subscriber = new BoundedTrafficSubscription(options, send, () => {
            this._subscribers.delete(subscriber);
            this._deactivateIfUnused();
        });
        this._activateIfUnused();
        this._subscribers.add(subscriber);
        return subscriber;
    }

    public observeTransits(observer: (transit: TrafficTransitEvent) => void): EndpointTrafficObservation {
        this._activateIfUnused();
        this._observers.add(observer);
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                this._observers.delete(observer);
                this._deactivateIfUnused();
            },
        };
    }

    public dispose(): void {
        for (const subscriber of [...this._subscribers]) subscriber.dispose();
        this._subscribers.clear();
        this._observers.clear();
        this._outboundRequests.clear();
        this._inboundRequests.clear();
        this._setActive(false);
    }

    private _onMessage(
        direction: WireMessageDirection,
        message: JsonRpcMessage,
    ): void {
        if (this._subscribers.size === 0 && this._observers.size === 0) return;

        const now = Date.now();
        let transit: TrafficTransitEvent;
        const endpoint = this._endpoint('id' in message ? message.id ?? undefined : undefined);
        const base = {
            type: 'transit' as const,
            ts: now,
            nodeId: this._nodeId,
            ...(direction === 'inbound' ? { in: endpoint } : { out: endpoint }),
            disposition: direction === 'inbound' ? 'consumed' as const : 'forwarded' as const,
        };
        if (isRequest(message)) {
            const correlation: RequestCorrelation = {
                method: message.method,
            };
            this._requestMap(direction).set(String(message.id), correlation);
            transit = {
                ...base,
                kind: 'request',
                method: message.method,
                params: message.params,
            };
        } else if (isResponse(message)) {
            const responseMap = direction === 'inbound'
                ? this._outboundRequests
                : this._inboundRequests;
            const key = String(message.id);
            const correlation = responseMap.get(key);
            responseMap.delete(key);
            transit = {
                ...base,
                kind: 'response',
                method: correlation?.method,
                result: 'result' in message ? message.result : undefined,
                error: 'error' in message ? message.error : undefined,
            };
        } else if (isNotification(message) && message.method === STREAM_METHOD) {
            const params = message.params as StreamSendParams | undefined;
            const streamEndpoint = this._endpoint(params?.requestId);
            transit = {
                ...base,
                ...(direction === 'inbound' ? { in: streamEndpoint } : { out: streamEndpoint }),
                kind: 'stream',
                method: STREAM_METHOD,
                params: message.params,
            };
        } else {
            transit = {
                ...base,
                kind: 'notification',
                method: message.method,
                params: message.params,
            };
        }

        for (const observer of [...this._observers]) {
            try {
                observer(transit);
            } catch {
                // Diagnostic observers never participate in transport lifecycle.
            }
        }
        for (const subscriber of this._subscribers) subscriber.enqueue(transit);
    }

    private _requestMap(
        direction: WireMessageDirection,
    ): Map<string, RequestCorrelation> {
        return direction === 'outbound'
            ? this._outboundRequests
            : this._inboundRequests;
    }

    private _endpoint(requestId: RequestId | undefined) {
        return {
            edgeId: this._portId,
            portId: this._portId,
            ...(requestId !== undefined ? { requestId } : {}),
        } as const;
    }

    private _activateIfUnused(): void {
        if (this._subscribers.size === 0 && this._observers.size === 0) {
            this._setActive(true);
        }
    }

    private _deactivateIfUnused(): void {
        if (this._subscribers.size !== 0 || this._observers.size !== 0) return;
        this._outboundRequests.clear();
        this._inboundRequests.clear();
        this._setActive(false);
    }
}
