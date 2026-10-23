import { describe, expect, it } from 'vitest';
import { LinkRpcConnection, TransportPair, type JsonValue } from '@hediet/linkrpc';
import { connectRawJsonRpcTransport } from './client';
import { jsonRpcConnectionInterface } from './interface';
import { registerJsonRpcConnectionService } from './server';
import { JsonRpcTransportPair } from './transport';

describe('raw JSON-RPC bridge', () => {
    it('cancels an opening factory through an AbortSignal', async () => {
        const link = new TransportPair();
        const server = LinkRpcConnection.fromTransport(link.a);
        const client = LinkRpcConnection.fromTransport(link.b);
        let factorySignal: AbortSignal | undefined;
        const registration = registerJsonRpcConnectionService({
            connection: server,
            openTransport: (_params, signal) => {
                factorySignal = signal;
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
                });
            },
        });
        const controller = new AbortController();
        const opening = connectRawJsonRpcTransport(client.get(jsonRpcConnectionInterface), undefined, controller.signal);
        const rejected = expect(opening).rejects.toThrow('cancelled');
        await expect.poll(() => factorySignal !== undefined).toBe(true);
        controller.abort();
        await rejected;
        await expect.poll(() => factorySignal?.aborted).toBe(true);
        registration.dispose();
        link.a.dispose();
        link.b.dispose();
    });

    it('forwards opaque frames in both directions', async () => {
        const link = new TransportPair();
        const server = LinkRpcConnection.fromTransport(link.a);
        const client = LinkRpcConnection.fromTransport(link.b);
        let peer!: JsonRpcTransportPair;

        registerJsonRpcConnectionService({
            connection: server,
            serviceId: 'json',
            openTransport: () => {
                peer = new JsonRpcTransportPair();
                return Promise.resolve(peer.a);
            },
        });

        const remote = await connectRawJsonRpcTransport(
            client.service('json').get(jsonRpcConnectionInterface),
        );
        const fromClient = nextFrame((listener) => peer.b.onMessage(listener));
        await remote.send({ jsonrpc: '2.0', id: 1, method: 'demo' });
        await expect(fromClient).resolves.toEqual({ jsonrpc: '2.0', id: 1, method: 'demo' });

        const fromServer = nextFrame((listener) => remote.onMessage(listener));
        await peer.b.send({ jsonrpc: '2.0', id: 1, result: true });
        await expect(fromServer).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: true });

        remote.close();
    });

    it('rejects instead of hanging when the service closes before ready', async () => {
        const link = new TransportPair();
        const server = LinkRpcConnection.fromTransport(link.a);
        const client = LinkRpcConnection.fromTransport(link.b);
        registerJsonRpcConnectionService({
            connection: server,
            openTransport: () => {
                const pair = new JsonRpcTransportPair();
                pair.a.close('already closed');
                return Promise.resolve(pair.a);
            },
        });

        await expect(connectRawJsonRpcTransport(
            client.get(jsonRpcConnectionInterface),
        )).rejects.toThrow('closed before it was ready');
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
