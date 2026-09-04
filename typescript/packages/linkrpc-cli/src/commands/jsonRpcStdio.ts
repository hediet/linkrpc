import { LinkRpcConnection, type JsonValue } from '@hediet/linkrpc';
import {
    connectJsonRpcTransports,
    connectRawJsonRpcTransport,
    createNdjsonJsonRpcTransport,
    jsonRpcConnectionInterface,
} from '@hediet/linkrpc-infra/json-rpc';
import type { CliConnection } from '@hediet/linkrpc-client';

export interface JsonRpcStdioOptions {
    readonly local: CliConnection;
    readonly serviceId: string;
    readonly params?: JsonValue;
    readonly input?: NodeJS.ReadableStream;
    readonly output?: NodeJS.WritableStream;
}

/** Expose a remote `jsonRpcConnection` service as an NDJSON stdio endpoint. */
export async function jsonRpcStdioCommand(options: JsonRpcStdioOptions): Promise<void> {
    const connection = new LinkRpcConnection(options.local.rpcChannel);
    const client = connection.service(options.serviceId).get(jsonRpcConnectionInterface);
    const remote = await connectRawJsonRpcTransport(client, options.params);
    const stdio = createNdjsonJsonRpcTransport({
        input: options.input ?? process.stdin,
        output: options.output ?? process.stdout,
    });
    const bridge = connectJsonRpcTransports(remote, stdio);

    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
            if (settled) return;
            settled = true;
            resolve();
        };
        remote.onClose(finish);
        stdio.onClose(finish);
    });
    bridge.dispose();
    remote.close('closed');
    stdio.close('closed');
}
