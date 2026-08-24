import type { JsonRpcMessage } from '../protocol/jsonRpc';
import type { IMessageTransport } from '../transport/messageTransport';

/**
 * Client-side WebSocket transport: one JSON-RPC message per text frame.
 * Mirror of the hub's server-side `WebSocketTransport`, kept here so the
 * core node entry can reach a `ws://` / `wss://` hub without depending on
 * `@vscode/hubrpc-hub`.
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
    /** Extra request headers to send on the upgrade. */
    readonly headers?: Record<string, string>;
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
 * Headers ride on the upgrade request via the non-standard `headers` option
 * supported by Node's global `WebSocket` (undici); browsers ignore it.
 */
export function openWebSocket(
    url: string,
    opts: OpenWebSocketOptions = {},
): Promise<WebSocket> {
    const headers: Record<string, string> = { ...opts.headers };
    return new Promise<WebSocket>((resolve, reject) => {
        // `headers` is a non-standard undici extension to the WHATWG
        // constructor (second arg is normally `protocols`); cast through.
        const ws = new WebSocket(url, { headers } as unknown as string[]);
        const onOpen = () => {
            ws.removeEventListener('error', onError);
            resolve(ws);
        };
        const onError = (event: Event) => {
            ws.removeEventListener('open', onOpen);
            const message = (event as { message?: string; }).message;
            reject(new Error(message ? `WebSocket error: ${message}` : 'WebSocket connection failed'));
        };
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
    });
}
