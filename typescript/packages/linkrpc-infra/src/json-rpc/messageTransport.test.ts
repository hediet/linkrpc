import { describe, expect, it } from 'vitest';
import {
    JsonRpcChannel,
    type JsonRpcMessage,
    type JsonValue,
} from '@hediet/linkrpc';
import { adaptJsonRpcTransport } from './messageTransport';
import { JsonRpcTransportPair } from './transport';

describe('JSON-RPC message transport adapter', () => {
    it('supports bidirectional Channel requests, notifications, and errors', async () => {
        const pair = new JsonRpcTransportPair();
        const channel = JsonRpcChannel.create(adaptJsonRpcTransport(pair.a));
        const notifications: Array<JsonValue | undefined> = [];
        channel.setRequestHandler({
            handleRequest: async (call) => call.method === 'echo'
                ? { result: call.params ?? null }
                : { error: { code: -32601, message: 'not found', data: { method: call.method } } },
            handleNotification: (call) => { notifications.push(call.params); },
        });

        const echoResponse = nextMessage(pair.b);
        await pair.b.send({ jsonrpc: '2.0', id: 'external', method: 'echo', params: null });
        await expect(echoResponse).resolves.toEqual({
            jsonrpc: '2.0', id: 'external', result: null,
        });

        await pair.b.send({ jsonrpc: '2.0', method: 'changed' });
        await Promise.resolve();
        expect(notifications).toEqual([undefined]);

        const outbound = nextMessage(pair.b);
        const result = channel.sender.sendRequest('reverse', { value: 1 });
        const request = await outbound as { id: string | number };
        await pair.b.send({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32001, message: 'external failure', data: { retry: false } },
        });
        await expect(result).rejects.toMatchObject({
            code: -32001,
            message: 'external failure',
            data: { retry: false },
        });
        channel.sender.close();
    });

    it('closes the external transport on invalid envelopes', async () => {
        const pair = new JsonRpcTransportPair();
        adaptJsonRpcTransport(pair.a).setListener(() => undefined);
        let reason: string | undefined;
        pair.b.onClose((value) => { reason = value; });
        await pair.b.send({ method: 'missing-jsonrpc' });
        await Promise.resolve();
        expect(pair.b.closed).toBe(true);
        expect(reason).toContain('expected jsonrpc "2.0"');
    });

    it('propagates peer closure to a channel and rejects pending requests', async () => {
        const pair = new JsonRpcTransportPair();
        const transport = adaptJsonRpcTransport(pair.a);
        const lifecycle = JsonRpcChannel.createWithClose(transport);
        transport.onClose(() => lifecycle.close());
        const pending = lifecycle.channel.sender.sendRequest('waiting', {});
        const rejected = expect(pending).rejects.toThrow('Connection closed');
        pair.b.close('peer exited');
        await rejected;
        expect(transport.closeReason).toBe('peer exited');
    });

    it('bounds buffering before a channel listener is installed', async () => {
        const pair = new JsonRpcTransportPair();
        const transport = adaptJsonRpcTransport(pair.a, { maxPendingMessages: 1 });
        await pair.b.send({ jsonrpc: '2.0', method: 'first' });
        await pair.b.send({ jsonrpc: '2.0', method: 'overflow' });
        await Promise.resolve();
        expect(transport.closed).toBe(true);
        expect(transport.closeReason).toContain('backlog exceeded 1');
        const frames: JsonRpcMessage[] = [];
        transport.setListener((message) => frames.push(message));
        expect(frames).toEqual([]);
    });
});

function nextMessage(transport: JsonRpcTransportPair['b']): Promise<JsonRpcMessage> {
    return new Promise((resolve) => {
        const subscription = transport.onMessage((message) => {
            subscription.dispose();
            resolve(message as unknown as JsonRpcMessage);
        });
    });
}
