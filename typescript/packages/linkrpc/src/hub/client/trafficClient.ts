import type { LinkRpcConnection } from '../../connection/linkRpcConnection';
import {
    trafficInterface,
    type TrafficOverflowEvent,
    type TrafficTransitEvent,
    type TrafficWatchResult,
} from '../common/inspection.interfaces';
import type { TrafficRequestRef } from '../common/trafficFlowFilter';

export interface TrafficCallbacks {
    onTransit(transit: TrafficTransitEvent): void;
    onOverflow?(overflow: TrafficOverflowEvent): void;
    onError?(error: unknown): void;
}

export interface TrafficWatch {
    readonly done: Promise<TrafficWatchResult>;
    cancel(reason?: string): Promise<void>;
}

export interface TrafficWatchOptions {
    readonly methodPrefix?: string;
    readonly trafficIgnoreKey?: string;
    readonly focusRequest?: TrafficRequestRef;
}

export interface TrafficWatchWithPayloadsOptions extends TrafficWatchOptions {
    readonly maxPayloadBytes: number;
}

/** Traffic stream client for the endpoint node hosting one service. */
export class TrafficClient<TInCtx = unknown, TOutCtx = unknown> {
    constructor(
        private readonly _connection: LinkRpcConnection<TInCtx, TOutCtx>,
        public readonly serviceId: string,
    ) { }

    public watch(
        options: TrafficWatchOptions,
        callbacks: TrafficCallbacks,
    ): TrafficWatch {
        const call = this._connection.service(this.serviceId)
            .get(trafficInterface)
            .watch(withTrafficIgnoreKey(options), { onMessage: (event) => {
                dispatchTrafficEvent(event, callbacks);
            } });
        void call.catch((error) => reportTrafficError(callbacks, error));
        return {
            done: call,
            cancel: async (reason?: string) => {
                try {
                    await call.cancel(reason);
                    await call;
                } finally {
                    call.dispose?.(reason);
                }
            },
        };
    }

    public watchWithPayloads(
        options: TrafficWatchWithPayloadsOptions,
        callbacks: TrafficCallbacks,
    ): TrafficWatch {
        const call = this._connection.service(this.serviceId)
            .get(trafficInterface)
            .watchWithPayloads(withTrafficIgnoreKey(options), { onMessage: (event) => {
                dispatchTrafficEvent(event, callbacks);
            } });
        void call.catch((error) => reportTrafficError(callbacks, error));
        return {
            done: call,
            cancel: async (reason?: string) => {
                try {
                    await call.cancel(reason);
                    await call;
                } finally {
                    call.dispose?.(reason);
                }
            },
        };
    }
}

function withTrafficIgnoreKey<T extends TrafficWatchOptions>(
    options: T,
): T & { trafficIgnoreKey: string; } {
    return {
        ...options,
        trafficIgnoreKey: options.trafficIgnoreKey ?? createTrafficIgnoreKey(),
    };
}

function createTrafficIgnoreKey(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function dispatchTrafficEvent(
    event: TrafficTransitEvent | TrafficOverflowEvent,
    callbacks: TrafficCallbacks,
): void {
    try {
        if (event.type === 'transit') callbacks.onTransit(event);
        else callbacks.onOverflow?.(event);
    } catch (error) {
        reportTrafficError(callbacks, error);
    }
}

function reportTrafficError(callbacks: TrafficCallbacks, error: unknown): void {
    try {
        callbacks.onError?.(error);
    } catch {
        // Consumer callbacks never participate in transport lifecycle.
    }
}
