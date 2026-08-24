import type { HubRpcConnection } from '../../connection/hubRpcConnection';
import {
    trafficInterface,
    type TrafficOverflowEvent,
    type TrafficTransitEvent,
    type TrafficWatchResult,
} from '../common/inspection.interfaces';

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
}

export interface TrafficWatchWithPayloadsOptions extends TrafficWatchOptions {
    readonly maxPayloadBytes: number;
}

/** Traffic stream client for the endpoint node hosting one service. */
export class TrafficClient<TInCtx = unknown, TOutCtx = unknown> {
    constructor(
        private readonly _connection: HubRpcConnection<TInCtx, TOutCtx>,
        public readonly serviceId: string,
    ) { }

    public watch(
        options: TrafficWatchOptions,
        callbacks: TrafficCallbacks,
    ): TrafficWatch {
        const call = this._connection.service(this.serviceId)
            .get(trafficInterface)
            .watch(options, { onMessage: (event) => {
                dispatchTrafficEvent(event, callbacks);
            } });
        void call.catch((error) => reportTrafficError(callbacks, error));
        return {
            done: call,
            cancel: async (reason?: string) => {
                try {
                    await call.cancel(reason);
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
            .watchWithPayloads(options, { onMessage: (event) => {
                dispatchTrafficEvent(event, callbacks);
            } });
        void call.catch((error) => reportTrafficError(callbacks, error));
        return {
            done: call,
            cancel: async (reason?: string) => {
                try {
                    await call.cancel(reason);
                } finally {
                    call.dispose?.(reason);
                }
            },
        };
    }
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
