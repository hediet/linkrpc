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
} from '../connection/streaming';
import type { TrafficTransitEvent } from './inspection.interfaces';
import type { WireMessageDirection, WireMessageObserver } from '../connection/channel';

interface RequestCorrelation {
    readonly method: string;
    readonly timeMs: number;
}

const REQUEST_CORRELATION_RETENTION_MS = 30 * 60_000;
const MAX_REQUEST_CORRELATIONS = 4096;

export class EndpointTrafficInspector {
    private readonly _outboundRequests = new Map<string, RequestCorrelation>();
    private readonly _inboundRequests = new Map<string, RequestCorrelation>();

    public readonly observe: WireMessageObserver = (direction, message) => {
        this._onMessage(direction, message);
    };

    constructor(
        private readonly _nodeId: string,
        private readonly _portId: string,
        private readonly _emit: (event: TrafficTransitEvent) => void,
        private readonly _isObserved: () => boolean,
    ) { }

    public dispose(): void {
        this._outboundRequests.clear();
        this._inboundRequests.clear();
    }

    private _onMessage(
        direction: WireMessageDirection,
        message: JsonRpcMessage,
    ): void {
        const now = Date.now();
        this._pruneRequestCorrelations(now);
        const publiclyObserved = this._isObserved();
        if (!publiclyObserved) this.dispose();
        let transit: TrafficTransitEvent;
        const endpoint = this._endpoint('id' in message ? message.id ?? undefined : undefined);
        const base = {
            type: 'transit' as const,
            timeMs: now,
            nodeId: this._nodeId,
            ...(direction === 'inbound' ? { in: endpoint } : { out: endpoint }),
            disposition: direction === 'inbound' ? 'consumed' as const : 'forwarded' as const,
        };
        if (isRequest(message)) {
            const correlation: RequestCorrelation = {
                method: message.method,
                timeMs: now,
            };
            if (publiclyObserved) {
                const map = this._requestMap(direction);
                const key = requestKey(message.id);
                map.delete(key);
                map.set(key, correlation);
            }
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
            const key = requestKey(message.id);
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

        function requestKey(requestId: RequestId | null): string {
            return JSON.stringify([typeof requestId, requestId]);
        }

        this._emit(transit);
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

    private _pruneRequestCorrelations(timeMs: number): void {
        this._pruneRequestMap(this._outboundRequests, timeMs);
        this._pruneRequestMap(this._inboundRequests, timeMs);
    }

    private _pruneRequestMap(
        map: Map<string, RequestCorrelation>,
        timeMs: number,
    ): void {
        while (map.size !== 0) {
            const first = map.entries().next().value as
                | [string, RequestCorrelation]
                | undefined;
            if (
                first === undefined
                || (
                    map.size <= MAX_REQUEST_CORRELATIONS
                    && timeMs - first[1].timeMs <= REQUEST_CORRELATION_RETENTION_MS
                )
            ) {
                return;
            }
            map.delete(first[0]);
        }
    }

}
