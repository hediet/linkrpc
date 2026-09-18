import type { LinkRpcConnection } from '@hediet/linkrpc';
import { nodeInterface, type NodeInfo } from '@hediet/linkrpc/inspection';

/** Typed convenience client for root and service-scoped node identity. */
export class NodeInfoClient<TInCtx = unknown, TOutCtx = unknown> {
    constructor(
        private readonly _connection: LinkRpcConnection<TInCtx, TOutCtx>,
    ) { }

    public getPeer(): Promise<NodeInfo> {
        return this._connection.get(nodeInterface).getNodeId({});
    }

    public getForService(serviceId: string): Promise<NodeInfo> {
        return this._connection.service(serviceId).get(nodeInterface).getNodeId({});
    }
}
