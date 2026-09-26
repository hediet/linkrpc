import type { JsonRpcMessage } from '../protocol/jsonRpc';
import type { IMessageTransport } from '../transport/messageTransport';
import { runInitializeHandshake } from './initialize';

/**
 * Client-side WebSocket transport: one JSON-RPC message per text frame.
 * Shared by the Node and browser entries so either can reach a ws/wss hub
 * without depending on `@hediet/linkrpc-hub`.
 *
 * Uses the platform-global `WebSocket` (Node 22+, browsers), so no `ws`
 * package dependency is required on the client side.
 *
 * Takes ownership of the socket: {@link dispose} closes it, and a peer
 * close / error fires `onClose` exactly once.
 */
export class WebSocketTransport implements IMessageTransport<JsonRpcMessage, JsonRpcMessage> {
    private _listener: ((m: JsonRpcMessage) => void) | undefined;
    private readonly _buffer: JsonRpcMessage[] = [];
    private _closed = false;

    constructor(
        private readonly _ws: WebSocket,
        private readonly _onClose?: () => void,
    ) {
        _ws.binaryType = 'arraybuffer';
        _ws.addEventListener('message', (event: MessageEvent) => {
            const data = event.data;
            const text = typeof data === 'string' ?
                data :
                data instanceof ArrayBuffer ?
                    new TextDecoder().decode(data) :
                    ArrayBuffer.isView(data) ?
                        new TextDecoder().decode(data as ArrayBufferView) :
                        String(data);
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let parsed: JsonRpcMessage;
                try {
                    parsed = JSON.parse(trimmed) as JsonRpcMessage;
                } catch {
                    continue;
                }
                this._deliver(parsed);
            }
        });
        const onEnd = () => {
            if (this._closed) return;
            this._closed = true;
            this._onClose?.();
        };
        _ws.addEventListener('close', onEnd);
        _ws.addEventListener('error', onEnd);
    }

    public send(message: JsonRpcMessage): void {
        if (this._closed) return;
        if (this._ws.readyState !== WebSocket.OPEN) return;
        this._ws.send(JSON.stringify(message));
    }

    public setListener(listener: ((m: JsonRpcMessage) => void) | undefined): void {
        this._listener = listener;
        if (listener) {
            while (this._buffer.length > 0 && this._listener) {
                const m = this._buffer.shift()!;
                this._listener(m);
            }
        }
    }

    public dispose(): void {
        if (this._closed) return;
        this._closed = true;
        try {
            this._ws.close();
        } catch { /* ignore */ }
        this._onClose?.();
    }

    private _deliver(m: JsonRpcMessage): void {
        if (this._listener) this._listener(m);
        else this._buffer.push(m);
    }
}

/** Options for {@link openWebSocket}. */
export interface OpenWebSocketOptions {
    readonly protocols?: string | string[];
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

/**
 * Open a WebSocket to `url` and resolve once it is connected. Rejects if the
 * socket errors before open.
 *
 * Authentication is NOT done here: the hub's WebSocket server authenticates
 * over the in-band `hubrpc::initialize` handshake (so browsers, which cannot
 * set request headers on the `WebSocket` constructor, work too). Run
 * {@link runInitializeHandshake} on the resulting {@link WebSocketTransport}.
 *
 * Uses the standard constructor overload; credentials belong in initialization.
 */
export function openWebSocket(
    url: string,
    opts: OpenWebSocketOptions = {},
): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
        if (opts.signal?.aborted) {
            reject(new Error('WebSocket connection cancelled'));
            return;
        }
        const ws = opts.protocols === undefined ? new WebSocket(url) : new WebSocket(url, opts.protocols);
        const cleanup = () => {
            clearTimeout(timer);
            ws.removeEventListener('open', onOpen);
            ws.removeEventListener('error', onError);
            ws.removeEventListener('close', onError);
            opts.signal?.removeEventListener('abort', onAbort);
        };
        const fail = (message: string) => {
            cleanup();
            ws.close();
            reject(new Error(message));
        };
        const onOpen = () => {
            cleanup();
            resolve(ws);
        };
        const onError = () => fail('WebSocket connection failed');
        const onAbort = () => fail('WebSocket connection cancelled');
        const timer = setTimeout(() => fail('WebSocket connection timed out'), opts.timeoutMs ?? 10_000);
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
        ws.addEventListener('close', onError, { once: true });
        opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export interface ConnectWebSocketTransportOptions extends OpenWebSocketOptions {
    /** Sent in initialization only, never appended to the URL. */
    readonly token?: string;
    readonly onClose?: () => void;
}

/** Open and initialize native WebSocket; cancellation also closes a live connection. */
export async function connectWebSocketTransport(
    url: string,
    options: ConnectWebSocketTransportOptions = {},
): Promise<WebSocketTransport> {
    const socket = await openWebSocket(url, options);
    const handshake = new AbortController();
    const transport = new WebSocketTransport(socket, () => {
        handshake.abort();
        options.signal?.removeEventListener('abort', abort);
        options.onClose?.();
    });
    const abort = () => transport.dispose();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
        if (options.signal?.aborted) throw new Error('WebSocket connection cancelled');
        await runInitializeHandshake(transport, { kind: 'client', token: options.token }, {
            handshakeTimeoutMs: options.timeoutMs,
            signal: handshake.signal,
        });
        return transport;
    } catch (error) {
        transport.dispose();
        throw error;
    }
}
