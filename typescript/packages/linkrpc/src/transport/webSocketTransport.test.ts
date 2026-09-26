import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectWebSocketTransport, openWebSocket } from '../web';

class BrowserSocket extends EventTarget {
    static readonly OPEN = 1;
    static instances: BrowserSocket[] = [];
    static reply = true;
    readonly args: unknown[];
    readyState = 0;
    binaryType = '';
    sent: unknown[] = [];
    constructor(...args: unknown[]) {
        super();
        this.args = args;
        BrowserSocket.instances.push(this);
        if (args[1] !== undefined && typeof args[1] !== 'string' && !Array.isArray(args[1])) {
            throw new TypeError('Invalid browser WebSocket protocols');
        }
        queueMicrotask(() => {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.dispatchEvent(new Event('open'));
        });
    }
    send(text: string) {
        const message = JSON.parse(text);
        this.sent.push(message);
        if (BrowserSocket.reply) queueMicrotask(() => {
            this.dispatchEvent(new MessageEvent('message', {
                data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }),
            }));
        });
    }
    close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
    BrowserSocket.instances = [];
    BrowserSocket.reply = true;
});

describe('browser WebSocket transport', () => {
    it('uses the native overload and keeps credentials in initialization only', async () => {
        vi.stubGlobal('WebSocket', BrowserSocket);
        const transport = await connectWebSocketTransport('wss://example.test', { token: 'test-only' });
        const socket = BrowserSocket.instances[0]!;
        expect(socket.args).toEqual(['wss://example.test']);
        expect(socket.sent).toEqual([{
            jsonrpc: '2.0', id: 0, method: 'hubrpc::initialize',
            params: { protocolVersion: 1, token: 'test-only' },
        }]);
        transport.dispose();
        expect(socket.readyState).toBe(3);
    });

    it('passes standard subprotocols', async () => {
        vi.stubGlobal('WebSocket', BrowserSocket);
        const socket = await openWebSocket('wss://example.test', { protocols: ['linkrpc'] });
        expect(BrowserSocket.instances[0]!.args).toEqual(['wss://example.test', ['linkrpc']]);
        socket.close();
    });

    it('cancels initialization and closes the socket exactly once', async () => {
        vi.stubGlobal('WebSocket', BrowserSocket);
        BrowserSocket.reply = false;
        const abort = new AbortController();
        const onClose = vi.fn();
        const pending = connectWebSocketTransport('wss://example.test', { signal: abort.signal, onClose });
        await Promise.resolve();
        await Promise.resolve();
        abort.abort();
        await expect(pending).rejects.toThrow(/cancelled/);
        expect(BrowserSocket.instances[0]!.readyState).toBe(3);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('rejects an already cancelled attempt without opening a socket', async () => {
        vi.stubGlobal('WebSocket', BrowserSocket);
        await expect(openWebSocket('wss://example.test', { signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/);
        expect(BrowserSocket.instances).toHaveLength(0);
    });

    it('closes a transport when initialization times out', async () => {
        vi.stubGlobal('WebSocket', BrowserSocket);
        BrowserSocket.reply = false;
        await expect(connectWebSocketTransport('wss://example.test', { timeoutMs: 5 })).rejects.toThrow(/timed out/);
        expect(BrowserSocket.instances[0]!.readyState).toBe(3);
    });
});
