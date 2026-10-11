import { describe, expect, it, vi } from 'vitest';
import type { JsonRpcMessage } from '../protocol/jsonRpc';
import { TransportPair } from '../transport/messageTransport';
import { JsonRpcChannel } from './jsonRpcChannel';

describe('JsonRpcChannel deferred request handling', () => {
    it('keeps outbound response and output-stream processing live during setup', async () => {
        const pair = new TransportPair();
        const local = JsonRpcChannel.createWithClose(pair.a, { deferRequests: true });
        const remote = JsonRpcChannel.createWithClose(pair.b);
        remote.channel.setRequestHandler({
            handleRequest: async call => {
                call.stream.send('progress');
                return { result: 'ready' };
            },
            handleNotification: () => {},
        });
        const chunks: unknown[] = [];
        try {
            const call = local.channel.sender.sendRequestWithStream('setup', {}, {
                onStreamMessage: chunk => chunks.push(chunk),
            });
            expect(await call.result).toBe('ready');
            expect(chunks).toEqual(['progress']);
        } finally {
            local.close();
            remote.close();
        }
    });

    it('preserves deferred request, input-stream, and notification ordering', async () => {
        const pair = new TransportPair();
        const local = JsonRpcChannel.createWithClose(pair.a, { deferRequests: true });
        const remote = JsonRpcChannel.createWithClose(pair.b);
        const events: unknown[] = [];
        try {
            const call = remote.channel.sender.sendRequestWithStream('queued', {});
            call.send('input');
            await remote.channel.sender.sendNotification('notification', {});
            local.channel.setRequestHandler({
                handleRequest: incoming => {
                    events.push(incoming.method);
                    return new Promise(resolve => incoming.stream.onMessage(value => {
                        events.push(value);
                        resolve({ result: 'done' });
                    }));
                },
                handleNotification: incoming => { events.push(incoming.method); },
            });
            expect(events).toEqual([]);
            local.resumeRequests();
            expect(await call.result).toBe('done');
            expect(events).toEqual(['queued', 'input', 'notification']);
        } finally {
            local.close();
            remote.close();
        }
    });

    it('discards deferred messages on close', async () => {
        const pair = new TransportPair();
        const local = JsonRpcChannel.createWithClose(pair.a, { deferRequests: true });
        const handleNotification = vi.fn();
        local.channel.setRequestHandler({
            handleRequest: async () => ({ result: null }),
            handleNotification,
        });
        pair.b.send({ jsonrpc: '2.0', method: 'queued' });
        local.close();
        local.resumeRequests();
        expect(handleNotification).not.toHaveBeenCalled();
        pair.b.dispose();
    });

    it('preserves cancellation of a request received before setup completes', async () => {
        const pair = new TransportPair();
        const local = JsonRpcChannel.createWithClose(pair.a, { deferRequests: true });
        const remote = JsonRpcChannel.createWithClose(pair.b);
        try {
            const call = remote.channel.sender.sendRequestWithStream('queued', {});
            call.cancel('cancelled during setup');
            local.channel.setRequestHandler({
                handleRequest: incoming => new Promise(resolve => {
                    incoming.signal.addEventListener('abort', () => resolve({
                        error: { code: -32800, message: incoming.signal.reason.message },
                    }), { once: true });
                }),
                handleNotification: () => {},
            });
            local.resumeRequests();
            await expect(call.result).rejects.toThrow('cancelled during setup');
        } finally {
            local.close();
            remote.close();
        }
    });
});

describe('JsonRpcChannel streaming call lifecycle', () => {
    it('can cancel remotely and dispose local bookkeeping independently', async () => {
        vi.useFakeTimers();
        const pair = new TransportPair();
        const sent: JsonRpcMessage[] = [];
        pair.b.setListener((message) => sent.push(message));
        const { channel, close } = JsonRpcChannel.createWithClose(pair.a);

        try {
            const call = channel.sender.sendRequestWithStream('jobs::run', {});
            expect(sent).toHaveLength(1);

            call.cancel('task cancelled');
            expect(sent).toHaveLength(2);

            call.dispose?.('task cancelled');
            await expect(call.result).rejects.toThrow('task cancelled');

            const sentAfterDispose = sent.length;
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(sent).toHaveLength(sentAfterDispose);
        } finally {
            close();
            pair.b.dispose();
            vi.useRealTimers();
        }
    });
});
