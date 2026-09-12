import { describe, expect, it } from 'vitest';
import { JsonRpcChannel, type JsonRpcMessage } from '@hediet/linkrpc';
import { createCdpWebSocketTransport, type CdpWebSocketLike } from './cdp';

describe('CDP WebSocket transport', () => {
    it('isolates duplicate request ids across flattened sessions', async () => {
        const socket = new MockWebSocket();
        const cdp = createCdpWebSocketTransport(socket);
        const a = cdp.session('a');
        const b = cdp.session('b');
        const receivedA: JsonRpcMessage[] = [];
        const receivedB: JsonRpcMessage[] = [];
        a.setListener((message) => receivedA.push(message));
        b.setListener((message) => receivedB.push(message));

        a.send({ jsonrpc: '2.0', id: 7, method: 'Runtime.evaluate', params: { expression: 'a' } });
        b.send({ jsonrpc: '2.0', id: 7, method: 'Runtime.evaluate', params: { expression: 'b' } });
        expect(socket.sent).toEqual([
            { id: 1, method: 'Runtime.evaluate', params: { expression: 'a' }, sessionId: 'a' },
            { id: 2, method: 'Runtime.evaluate', params: { expression: 'b' }, sessionId: 'b' },
        ]);

        socket.receive({ id: 2, result: { value: 'b' }, sessionId: 'b' });
        socket.receive({ id: 1, error: { code: -32000, message: 'failed', data: { detail: 1 } }, sessionId: 'a' });
        await tick();
        expect(receivedA).toEqual([{
            jsonrpc: '2.0',
            id: 7,
            error: { code: -32000, message: 'failed', data: { detail: 1 } },
        }]);
        expect(receivedB).toEqual([{
            jsonrpc: '2.0', id: 7, result: { value: 'b' },
        }]);
    });

    it('does not misroute root events and supports reverse requests', async () => {
        const socket = new MockWebSocket();
        const cdp = createCdpWebSocketTransport(socket);
        const root: JsonRpcMessage[] = [];
        const child: JsonRpcMessage[] = [];
        cdp.root.setListener((message) => root.push(message));
        cdp.session('child').setListener((message) => child.push(message));

        socket.receive({ method: 'Inspector.detached', params: null });
        socket.receive({ id: 'peer-id', method: 'Example.reverse', params: { x: 1 }, sessionId: 'child' });
        await tick();
        expect(root).toEqual([{ jsonrpc: '2.0', method: 'Inspector.detached', params: null }]);
        expect(child).toEqual([{
            jsonrpc: '2.0', id: 'peer-id', method: 'Example.reverse', params: { x: 1 },
        }]);

        cdp.session('child').send({
            jsonrpc: '2.0',
            id: 'peer-id',
            error: { code: -32601, message: 'unsupported', data: { method: 'Example.reverse' } },
        });
        expect(socket.sent).toEqual([{
            id: 'peer-id',
            error: { code: -32601, message: 'unsupported', data: { method: 'Example.reverse' } },
            sessionId: 'child',
        }]);
    });

    it('closes explicitly on malformed frames and owns socket close only when asked', async () => {
        const socket = new MockWebSocket();
        const cdp = createCdpWebSocketTransport(socket);
        socket.receiveText('{');
        await tick();
        expect(cdp.closed).toBe(true);
        expect(cdp.closeReason).toContain('Invalid CDP JSON frame');
        expect(socket.closeCalls).toBe(1);
        expect(() => cdp.session('late')).toThrow('Invalid CDP JSON frame');

        const socket2 = new MockWebSocket();
        const cdp2 = createCdpWebSocketTransport(socket2);
        cdp2.close('done');
        expect(socket2.closeCalls).toBe(1);
        expect(cdp2.closeReason).toBe('done');
    });

    it.each(['close', 'error'] as const)(
        'rejects pending Channel requests when the socket emits %s',
        async (eventType) => {
            const socket = new MockWebSocket();
            const cdp = createCdpWebSocketTransport(socket);
            const lifecycle = JsonRpcChannel.createWithClose(cdp.root);
            cdp.root.onClose(() => lifecycle.close());
            const pending = lifecycle.channel.sender.sendRequest('Runtime.enable', undefined);

            if (eventType === 'close') socket.peerClose();
            else socket.fail('connection reset');

            await expect(pending).rejects.toThrow('Connection closed');
            expect(cdp.closeReason).toContain(eventType === 'close' ? 'closed' : 'connection reset');
            expect(socket.closeCalls).toBe(eventType === 'error' ? 1 : 0);
        },
    );

    it('rolls back failed sends and removes requests when a session is disposed', async () => {
        const failedSocket = new MockWebSocket();
        const failedCdp = createCdpWebSocketTransport(failedSocket);
        failedSocket.sendError = new Error('send failed');
        expect(() => failedCdp.root.send({
            jsonrpc: '2.0', id: 1, method: 'Runtime.enable',
        })).toThrow('send failed');
        failedSocket.sendError = undefined;
        failedSocket.receive({ id: 1, result: {} });
        await tick();
        expect(failedCdp.closed).toBe(false);

        const socket = new MockWebSocket();
        const cdp = createCdpWebSocketTransport(socket);
        const child = cdp.session('child');
        child.send({ jsonrpc: '2.0', id: 1, method: 'Runtime.enable' });
        child.dispose();
        socket.receive({ id: 1, result: {}, sessionId: 'child' });
        await tick();
        expect(cdp.closed).toBe(false);
        cdp.root.send({ jsonrpc: '2.0', id: 7, method: 'Runtime.enable' });
        const received: JsonRpcMessage[] = [];
        cdp.root.setListener((message) => received.push(message));
        socket.receive({ id: 2, result: {} });
        await tick();
        expect(received).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
    });
});

class MockWebSocket implements CdpWebSocketLike {
    public readonly readyState = 1;
    public readonly sent: unknown[] = [];
    public closeCalls = 0;
    public sendError: Error | undefined;
    private readonly listeners = new Map<string, Set<EventListener>>();

    public send(data: string): void {
        if (this.sendError) throw this.sendError;
        this.sent.push(JSON.parse(data));
    }
    public close(): void {
        this.closeCalls++;
    }
    public addEventListener(type: string, listener: EventListener): void {
        let listeners = this.listeners.get(type);
        if (!listeners) this.listeners.set(type, listeners = new Set());
        listeners.add(listener);
    }
    public removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
    }
    public receive(value: unknown): void {
        this.receiveText(JSON.stringify(value));
    }
    public receiveText(data: string): void {
        this.emit('message', new MessageEvent('message', { data }));
    }
    public peerClose(): void {
        this.emit('close', new Event('close'));
    }
    public fail(message: string): void {
        const event = new Event('error');
        Object.defineProperty(event, 'message', { value: message });
        this.emit('error', event);
    }
    private emit(type: string, event: Event): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
}

async function tick(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}
