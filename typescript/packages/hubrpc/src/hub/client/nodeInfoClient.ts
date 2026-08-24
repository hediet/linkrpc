import type { HubRpcConnection } from '../../connection/hubRpcConnection';
import { nodeInterface, type NodeInfo } from '../common/node.interfaces';

/** Typed convenience client for root and service-scoped node identity. */
export class NodeInfoClient<TInCtx = unknown, TOutCtx = unknown> {
    constructor(
        private readonly _connection: HubRpcConnection<TInCtx, TOutCtx>,
    ) { }

    public getPeer(): Promise<NodeInfo> {
        return this._connection.get(nodeInterface).getNodeId({});
    }

    public getForService(serviceId: string): Promise<NodeInfo> {
        return this._connection.service(serviceId).get(nodeInterface).getNodeId({});
    }
}
