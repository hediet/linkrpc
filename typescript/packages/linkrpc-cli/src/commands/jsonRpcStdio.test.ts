import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
    JsonRpcChannel,
    LinkRpcConnection,
    TransportPair,
    type JsonValue,
} from '@hediet/linkrpc';
import {
    JsonRpcTransportPair,
    registerJsonRpcConnectionService,
} from '@hediet/linkrpc-infra/json-rpc';
import type { CliConnection } from '@hediet/linkrpc-client';
import { jsonRpcStdioCommand } from './jsonRpcStdio';

describe('jsonRpcStdioCommand', () => {
    it('bridges NDJSON stdin/stdout to a remote JSON-RPC transport', async () => {
        const link = new TransportPair();
        const server = LinkRpcConnection.fromTransport(link.a);
        const rpcChannel = JsonRpcChannel.create(link.b);
        let peer!: JsonRpcTransportPair;
        registerJsonRpcConnectionService({
            connection: server,
            serviceId: 'json',
            openTransport: () => {
                peer = new JsonRpcTransportPair();
                return Promise.resolve(peer.a);
            },
        });

        const input = new PassThrough();
        const output = new PassThrough();
        output.setEncoding('utf8');
        let stdout = '';
        output.on('data', (chunk: string) => { stdout += chunk; });
        const command = jsonRpcStdioCommand({
            local: { rpcChannel } as CliConnection,
            serviceId: 'json',
            input,
            output,
        });

        const request = nextFrame((listener) => peer.b.onMessage(listener));
        input.write('{"jsonrpc":"2.0","id":1,"method":"demo"}\n');
        await expect(request).resolves.toEqual({
            jsonrpc: '2.0',
            id: 1,
            method: 'demo',
        });

        await peer.b.send({ jsonrpc: '2.0', id: 1, result: true });
        await waitFor(() => stdout.length > 0);
        expect(stdout).toBe('{"jsonrpc":"2.0","id":1,"result":true}\n');

        input.end();
        await command;
    });
});

function nextFrame(
    subscribe: (listener: (frame: JsonValue) => void) => { dispose(): void; },
): Promise<JsonValue> {
    return new Promise((resolve) => {
        const subscription = subscribe((frame) => {
            subscription.dispose();
            resolve(frame);
        });
    });
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 20; i++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for output');
}
