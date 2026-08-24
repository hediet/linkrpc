import type { LinkRpcConnection } from '../../connection/linkRpcConnection';
import { nodeInterface, type NodeInfo } from '../common/node.interfaces';

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
