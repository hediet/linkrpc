import { LinkRpcConnection } from '@hediet/linkrpc';
import { connectRawJsonRpcTransport, jsonRpcConnectionInterface } from '@hediet/linkrpc-infra/json-rpc';
import {
    startJsonRpcWebSocketExport,
    type JsonRpcExportRoute,
    type JsonRpcWebSocketExport,
} from '@hediet/linkrpc-infra/json-rpc/node';
import type { CliConnection } from '@hediet/linkrpc-client-internal';

/** Preserve option order so a missing path cannot shift subsequent service mappings. */
export class JsonRpcExportRoutes {
    private readonly _routes: JsonRpcExportRoute[] = [];
    private _pendingService: string | undefined;

    public serviceId(value: string): void {
        if (this._pendingService !== undefined) throw new Error('Each --serviceId must be followed by --path.');
        this._pendingService = value;
    }

    public path(value: string): void {
        if (this._pendingService === undefined) throw new Error('--path must follow --serviceId.');
        this._routes.push({ serviceId: this._pendingService, path: value.startsWith('/') ? value : `/${value}` });
        this._pendingService = undefined;
    }

    public getRoutes(): readonly JsonRpcExportRoute[] {
        if (this._pendingService !== undefined) throw new Error('Each --serviceId must be followed by --path.');
        return this._routes;
    }
}

export async function jsonRpcExportCommand(options: {
    readonly local: Pick<CliConnection, 'rpcChannel'>;
    readonly targetEndpoint: string;
    readonly token?: string;
    readonly routes: readonly JsonRpcExportRoute[];
    readonly onError: (error: Error) => void;
}): Promise<JsonRpcWebSocketExport> {
    const connection = new LinkRpcConnection(options.local.rpcChannel);
    return startJsonRpcWebSocketExport({
        ...options,
        openTransport: (serviceId, signal) => connectRawJsonRpcTransport(
            connection.service(serviceId).get(jsonRpcConnectionInterface),
            undefined,
            signal,
        ),
    });
}
