import type { LinkRpcConnection } from '../../connection/linkRpcConnection';
import {
    topologyInterface,
    type TopologyGraph,
} from '../common/inspection.interfaces';

export interface TopologyWatch {
    /** Resolves with the initial snapshot after its callback has run. */
    readonly ready: Promise<TopologyGraph>;
    /** Resolves after cancellation and all queued re-fetches complete. */
    readonly done: Promise<void>;
    cancel(reason?: string): Promise<void>;
}

export interface TopologyWatchCallbacks {
    onGraph(graph: TopologyGraph): void;
    onError?(error: unknown): void;
}

/** Snapshot and invalidation-watch client for one inspected service. */
export class TopologyClient<TInCtx = unknown, TOutCtx = unknown> {
    constructor(
        private readonly _connection: LinkRpcConnection<TInCtx, TOutCtx>,
        public readonly serviceId: string,
    ) { }

    public getGraph(): Promise<TopologyGraph> {
        return this._connection.service(this.serviceId)
            .get(topologyInterface)
            .getGraph({});
    }

    public watch(callbacks: TopologyWatchCallbacks): TopologyWatch {
        const client = this._connection.service(this.serviceId).get(topologyInterface);
        let active = true;
        let dirty = false;
        let refreshing = false;
        let refreshTail: Promise<void> = Promise.resolve();
        let readySettled = false;
        let resolveReady!: (graph: TopologyGraph) => void;
        let rejectReady!: (error: unknown) => void;
        const ready = new Promise<TopologyGraph>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });

        const reportError = (error: unknown): void => {
            try {
                callbacks.onError?.(error);
            } catch {
                // Consumer callbacks never participate in watch lifecycle.
            }
        };
        const requestRefresh = (): void => {
            if (!active) return;
            dirty = true;
            if (refreshing) return;
            refreshing = true;
            refreshTail = (async () => {
                while (active && dirty) {
                    dirty = false;
                    try {
                        const graph = await client.getGraph({});
                        if (!active) break;
                        try {
                            callbacks.onGraph(graph);
                        } catch (error) {
                            reportError(error);
                        }
                        if (!readySettled) {
                            readySettled = true;
                            resolveReady(graph);
                        }
                    } catch (error) {
                        reportError(error);
                        if (!readySettled) {
                            readySettled = true;
                            rejectReady(error);
                        }
                    }
                }
            })().finally(() => {
                refreshing = false;
                if (active && dirty) requestRefresh();
            });
        };

        const call = client.watchGraph({}, {
            onMessage: requestRefresh,
        });
        requestRefresh();
        const done = (async () => {
            try {
                await call;
            } catch (error) {
                reportError(error);
                throw error;
            } finally {
                active = false;
            }
            await refreshTail;
        })();

        return {
            ready,
            done,
            cancel: async (reason?: string) => {
                active = false;
                if (!readySettled) {
                    readySettled = true;
                    rejectReady(new Error(reason ?? 'Topology watch cancelled'));
                }
                try {
                    await call.cancel(reason);
                } finally {
                    call.dispose?.(reason);
                }
            },
        };
    }
}
