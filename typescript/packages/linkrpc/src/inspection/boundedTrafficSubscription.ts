import type {
    TrafficEvent,
    TrafficTransitEvent,
    TrafficWatchResult,
} from './inspection.interfaces';
import type { JsonValue } from '../protocol/jsonRpc';
import {
    TrafficFlowFilter,
} from './trafficFlowFilter';
import type { TrafficRequestRef } from './trafficFlowFilter';

const DEFAULT_QUEUE_LIMIT = 256;

export interface TrafficSubscriptionOptions {
    readonly methodPrefix?: string;
    readonly maxPayloadBytes?: number;
    readonly trafficIgnoreKey?: string;
    readonly focusRequest?: TrafficRequestRef;
}

export interface TrafficSubscription {
    readonly closed: Promise<TrafficWatchResult>;
    dispose(): void;
}

/**
 * Applies per-subscriber filtering and payload policy while isolating traffic
 * producers from slow or failed stream consumers.
 */
export class BoundedTrafficSubscription implements TrafficSubscription {
    private readonly _queue: TrafficTransitEvent[] = [];
    private _active = true;
    private _pumping = false;
    private _overflowPending = 0;
    private _delivered = 0;
    private _dropped = 0;
    private readonly _resolveClosed: (result: TrafficWatchResult) => void;
    private readonly _filter: TrafficFlowFilter;
    public readonly closed: Promise<TrafficWatchResult>;

    constructor(
        private readonly _options: TrafficSubscriptionOptions,
        private readonly _send: (event: TrafficEvent) => Promise<void>,
        private readonly _onDispose: () => void,
        private readonly _queueLimit = DEFAULT_QUEUE_LIMIT,
    ) {
        let resolve!: (result: TrafficWatchResult) => void;
        this.closed = new Promise<TrafficWatchResult>((r) => resolve = r);
        this._resolveClosed = resolve;
        this._filter = new TrafficFlowFilter({
            focus: _options.focusRequest,
        });
    }

    public enqueue(transit: TrafficTransitEvent): void {
        if (!this._active) return;
        if (!this._filter.shouldInclude(transit)) return;
        if (
            this._options.methodPrefix !== undefined
            && !transit.method?.startsWith(this._options.methodPrefix)
        ) {
            return;
        }

        const event = this._options.maxPayloadBytes === undefined
            ? withoutPayloads(transit)
            : withCappedPayloads(transit, this._options.maxPayloadBytes);
        if (this._queue.length >= this._queueLimit) {
            this._queue.shift();
            this._dropped++;
            this._overflowPending++;
        }
        this._queue.push(event);
        if (!this._pumping) {
            this._pumping = true;
            queueMicrotask(() => void this._pump());
        }
    }

    public dispose(): void {
        if (!this._active) return;
        this._active = false;
        this._dropped += this._queue.length;
        this._queue.length = 0;
        this._overflowPending = 0;
        this._onDispose();
        if (!this._pumping) this._complete();
    }

    private async _pump(): Promise<void> {
        try {
            while (this._active) {
                if (this._overflowPending > 0) {
                    const dropped = this._overflowPending;
                    this._overflowPending = 0;
                    await this._send({ type: 'overflow', dropped });
                    continue;
                }
                const event = this._queue.shift();
                if (event === undefined) break;
                await this._send(event);
                this._delivered++;
            }
        } catch {
            this.dispose();
        } finally {
            this._pumping = false;
            if (!this._active) {
                this._complete();
            } else if (this._queue.length > 0 || this._overflowPending > 0) {
                this._pumping = true;
                queueMicrotask(() => void this._pump());
            }
        }
    }

    private _complete(): void {
        this._resolveClosed({
            delivered: this._delivered,
            dropped: this._dropped,
        });
    }
}

function withoutPayloads(transit: TrafficTransitEvent): TrafficTransitEvent {
    const { params: _params, result: _result, error, ...rest } = transit;
    if (error === undefined) return rest;
    return {
        ...rest,
        error: { code: error.code, message: error.message },
    };
}

function withCappedPayloads(
    transit: TrafficTransitEvent,
    maxPayloadBytes: number,
): TrafficTransitEvent {
    return {
        ...transit,
        params: capPayload(transit.params, maxPayloadBytes),
        result: capPayload(transit.result, maxPayloadBytes),
        error: transit.error === undefined ? undefined : {
            ...transit.error,
            data: capPayload(transit.error.data, maxPayloadBytes),
        },
    };
}

function capPayload(value: unknown, maxBytes: number): JsonValue | undefined {
    if (value === undefined) return undefined;
    if (maxBytes === Number.POSITIVE_INFINITY) return value as JsonValue;
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    const encoded = new TextEncoder().encode(json);
    if (encoded.byteLength <= maxBytes) return value as JsonValue;
    const encoder = new TextEncoder();
    let preview = new TextDecoder().decode(encoded.slice(0, maxBytes));
    while (encoder.encode(preview).byteLength > maxBytes) {
        preview = preview.slice(0, -1);
    }
    return preview;
}
