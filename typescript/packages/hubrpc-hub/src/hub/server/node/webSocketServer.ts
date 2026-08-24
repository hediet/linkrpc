import * as http from 'node:http';
import { type WebSocket, WebSocketServer as WsServer } from 'ws';
import type { JsonRpcMessage } from '@vscode/hubrpc';
import { runInitializeHandshake } from '@vscode/hubrpc/node';
import type {
    ITransportServer,
    TopologyTransportInfo,
    Transport,
} from '@vscode/hubrpc/hub/common';

/**
 * A {@link Transport} over a server-side `ws` WebSocket. One JSON-RPC message
 * per text frame; binary frames are decoded as UTF-8 and unparseable frames
 * are dropped (the same lenient behaviour as {@link NodeSocketTransport}).
 *
 * The transport takes ownership of the socket: {@link dispose} closes it, and
 * a peer close / error fires {@link onDidClose} handlers exactly once.
 */
export class NodeWebSocketTransport implements Transport {
    private _listener: ((m: JsonRpcMessage) => void) | undefined;
    private readonly _buffer: JsonRpcMessage[] = [];
    private readonly _closeHandlers: (() => void)[] = [];
    private _closed = false;

    /**
     * Token presented by the peer in the `hubrpc::initialize` handshake, when
     * the server ran one. A {@link ConnectionProvenanceProvider} can read it to
     * attest the peer. `undefined` when the handshake carried no token.
     */
    public initializeToken: string | undefined;

    constructor(
        public readonly socket: WebSocket,
        public readonly topologyInfo?: TopologyTransportInfo,
    ) {
        socket.on('message', (data, isBinary) => {
            const text = isBinary ?
                Buffer.isBuffer(data) ?
                    data.toString('utf8') :
                    Array.isArray(data) ?
                    Buffer.concat(data).toString('utf8') :
                    Buffer.from(data as ArrayBuffer).toString('utf8') :
                data.toString();
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
        const onEnd = (): void => {
            if (this._closed) return;
            this._closed = true;
            this._fireClose();
        };
        socket.on('close', onEnd);
        socket.on('error', onEnd);
    }

    public send(message: JsonRpcMessage): void {
        if (this._closed) return;
        if (this.socket.readyState !== 1 /* OPEN */) return;
        this.socket.send(JSON.stringify(message));
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

    public onDidClose(handler: () => void): void {
        if (this._closed) {
            queueMicrotask(handler);
            return;
        }
        this._closeHandlers.push(handler);
    }

    public dispose(): void {
        if (this._closed) return;
        this._closed = true;
        try {
            this.socket.close();
        } catch { /* ignore */ }
        this._fireClose();
    }

    private _fireClose(): void {
        const handlers = this._closeHandlers.splice(0);
        for (const h of handlers) {
            try {
                h();
            } catch { /* ignore */ }
        }
    }

    private _deliver(m: JsonRpcMessage): void {
        if (this._listener) this._listener(m);
        else this._buffer.push(m);
    }
}

export type WebSocketServerEvent =
    | { readonly kind: 'accepted'; readonly remoteAddress: string | undefined; }
    | { readonly kind: 'rejected'; readonly reason: string; readonly remoteAddress: string | undefined; }
    | { readonly kind: 'closed'; readonly remoteAddress: string | undefined; };

export interface WebSocketServerOptions {
    /** TCP port to listen on. Defaults to an OS-assigned free port (`0`). */
    readonly port?: number;
    /** Host/interface to bind. Defaults to all interfaces. */
    readonly host?: string;
    /**
     * Validate the token presented in the client's `hubrpc::initialize`
     * handshake. Resolve `true` to admit the connection, `false` to reject it.
     * Required unless {@link allowAnonymous} is set. Browsers cannot set the
     * `Authorization` header on the `WebSocket` constructor, so auth happens
     * over the in-band handshake rather than the HTTP upgrade.
     */
    readonly isTokenAccepted?: (token: string | undefined) => Promise<boolean>;
    /**
     * Allow connections without validating a token: the `hubrpc::initialize`
     * handshake still runs (and its token is captured), but any token is
     * accepted. Use ONLY behind a trusted reverse proxy that performs auth
     * itself, or on a private interface.
     */
    readonly allowAnonymous?: boolean;
    /**
     * Optional `Origin` allow-list for browser clients. When set, the upgrade
     * is rejected if `Origin` is present and not in the list. Non-browser
     * clients (which send no `Origin`) are unaffected.
     */
    readonly allowedOrigins?: readonly string[];
    /**
     * URL path the WebSocket endpoint is mounted at. Defaults to `/`. Any
     * other path gets a `404`, so the same server can host health checks.
     */
    readonly path?: string;
    /** Bytes. Frames larger than this close the connection. Defaults to 16 MiB. */
    readonly maxPayload?: number;
    /** Optional logger called on accept / reject / close. */
    readonly onEvent?: (event: WebSocketServerEvent) => void;
    /**
     * Optional handler for ordinary (non-upgrade) HTTP requests on the same
     * port. An Express app is a valid {@link http.RequestListener}, so this
     * lets the WebSocket endpoint and e.g. a `/health` route share one port.
     * Defaults to replying `426 upgrade required` to every request.
     */
    readonly requestListener?: http.RequestListener;
}

/**
 * A hub-agnostic {@link ITransportServer} over WebSocket. It owns an
 * `http.Server`, gates each upgrade by origin, runs the `hubrpc::initialize`
 * handshake (authentication + protocol negotiation) over each accepted socket,
 * and frames it as a {@link NodeWebSocketTransport}. Compose identity/claim
 * policy on top via {@link HubConnectionAcceptor} — this server never couples
 * to the hub.
 *
 * Sibling of {@link SocketServer} (named pipe / UDS) for reaching the hub from
 * outside the host over `ws://` / `wss://`.
 */
export class WebSocketServer implements ITransportServer<NodeWebSocketTransport> {
    private readonly _httpServer: http.Server;
    private readonly _wss: WsServer;
    private readonly _path: string;
    private readonly _attached = new Set<NodeWebSocketTransport>();
    private readonly _sockets = new Set<WebSocket>();
    private _handler: ((transport: NodeWebSocketTransport) => void) | undefined;
    private _disposed = false;

    private constructor(private readonly _opts: WebSocketServerOptions) {
        this._path = _opts.path ?? '/';
        if (!_opts.allowAnonymous && !_opts.isTokenAccepted) {
            throw new Error(
                'WebSocketServer: either `isTokenAccepted` must be provided or `allowAnonymous` must be true',
            );
        }
        this._httpServer = http.createServer(
            _opts.requestListener ??
                ((_req, res) => {
                    res.writeHead(426, { 'content-type': 'text/plain' });
                    res.end('upgrade required');
                }),
        );
        this._wss = new WsServer({
            noServer: true,
            maxPayload: _opts.maxPayload ?? 16 * 1024 * 1024,
        });
        this._httpServer.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
        this._wss.on('connection', (ws, req) => this._onConnection(ws, req));
    }

    /** Bind + listen, resolving once the port is open. */
    public static start(options: WebSocketServerOptions = {}): Promise<WebSocketServer> {
        const server = new WebSocketServer(options);
        return new Promise<WebSocketServer>((resolve, reject) => {
            const onError = (err: Error): void => reject(err);
            server._httpServer.once('error', onError);
            server._httpServer.listen(options.port ?? 0, options.host, () => {
                server._httpServer.removeListener('error', onError);
                resolve(server);
            });
        });
    }

    /** The bound port (resolved even when started with port `0`). */
    public get port(): number {
        const addr = this._httpServer.address();
        if (addr && typeof addr === 'object') return addr.port;
        return 0;
    }

    public setConnectionHandler(handler: (transport: NodeWebSocketTransport) => void): void {
        this._handler = handler;
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        for (const t of this._attached) {
            t.dispose();
        }
        this._attached.clear();
        for (const s of this._sockets) {
            try {
                s.terminate();
            } catch { /* ignore */ }
        }
        this._sockets.clear();
        this._wss.close();
        this._httpServer.close();
    }

    private _onUpgrade(
        req: http.IncomingMessage,
        socket: NodeJS.WritableStream & { destroy: () => void; },
        head: Buffer,
    ): void {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== this._path) {
            this._reject(socket, 404, 'not found', req);
            return;
        }
        const allowedOrigins = this._opts.allowedOrigins;
        if (allowedOrigins && allowedOrigins.length > 0) {
            const origin = req.headers.origin;
            if (origin && !allowedOrigins.includes(origin)) {
                this._reject(socket, 403, 'origin not allowed', req);
                return;
            }
        }
        this._wss.handleUpgrade(req, socket as never, head, (ws) => {
            this._wss.emit('connection', ws, req);
        });
    }

    private _onConnection(ws: WebSocket, req: http.IncomingMessage): void {
        void this._acceptConnection(ws, req);
    }

    /**
     * Frame the upgraded socket, run the `hubrpc::initialize` handshake
     * (authentication + protocol negotiation), then hand the transport to the
     * connection handler. A failed handshake (bad/missing token, wrong first
     * message, or timeout) drops the socket without reaching the handler.
     */
    private async _acceptConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
        if (this._disposed) {
            try {
                ws.terminate();
            } catch { /* ignore */ }
            return;
        }
        this._sockets.add(ws);
        ws.once('close', () => this._sockets.delete(ws));

        const transport = new NodeWebSocketTransport(
            ws,
            _webSocketTopologyInfo(req, this._path),
        );
        const isTokenAccepted = this._opts.isTokenAccepted ?? (async () => true);
        let token: string | undefined;
        try {
            ({ token } = await runInitializeHandshake(transport, { kind: 'server', isTokenAccepted }));
        } catch {
            transport.dispose();
            this._opts.onEvent?.({ kind: 'rejected', reason: '401 unauthorized', remoteAddress: _remoteAddr(req) });
            return;
        }
        if (this._disposed) {
            transport.dispose();
            return;
        }
        transport.initializeToken = token;
        transport.onDidClose(() => {
            this._attached.delete(transport);
            this._opts.onEvent?.({ kind: 'closed', remoteAddress: _remoteAddr(req) });
        });
        this._attached.add(transport);
        this._handler?.(transport);
        this._opts.onEvent?.({ kind: 'accepted', remoteAddress: _remoteAddr(req) });
    }

    private _reject(
        socket: NodeJS.WritableStream & { destroy: () => void; },
        status: number,
        message: string,
        req: http.IncomingMessage,
    ): void {
        this._opts.onEvent?.({ kind: 'rejected', reason: `${status} ${message}`, remoteAddress: _remoteAddr(req) });
        try {
            socket.write(
                `HTTP/1.1 ${status} ${message}\r\n` +
                    `Content-Length: 0\r\n` +
                    `Connection: close\r\n` +
                    `\r\n`,
            );
        } catch { /* ignore */ }
        try {
            socket.destroy();
        } catch { /* ignore */ }
    }
}

function _remoteAddr(req: http.IncomingMessage): string | undefined {
    return _forwardedFor(req) ?? req.socket.remoteAddress ?? undefined;
}

function _webSocketTopologyInfo(
    req: http.IncomingMessage,
    path: string,
): TopologyTransportInfo {
    const forwardedFor = _forwardedFor(req);
    const origin = req.headers.origin;
    return {
        type: 'websocket',
        path,
        ...(req.socket.localAddress !== undefined || req.socket.localPort !== undefined
            ? {
                local: {
                    ...(req.socket.localAddress !== undefined
                        ? { address: req.socket.localAddress }
                        : {}),
                    ...(req.socket.localPort !== undefined ? { port: req.socket.localPort } : {}),
                },
            }
            : {}),
        ...(req.socket.remoteAddress !== undefined || req.socket.remotePort !== undefined
            ? {
                remote: {
                    ...(req.socket.remoteAddress !== undefined
                        ? { address: req.socket.remoteAddress }
                        : {}),
                    ...(req.socket.remotePort !== undefined ? { port: req.socket.remotePort } : {}),
                },
            }
            : {}),
        ...(forwardedFor !== undefined || origin !== undefined
            ? {
                metadata: {
                    ...(forwardedFor !== undefined ? { forwardedFor } : {}),
                    ...(origin !== undefined ? { origin } : {}),
                },
            }
            : {}),
    };
}

function _forwardedFor(req: http.IncomingMessage): string | undefined {
    const value = req.headers['x-forwarded-for'];
    if (typeof value !== 'string') return undefined;
    return value.split(',')[0]?.trim() || undefined;
}
