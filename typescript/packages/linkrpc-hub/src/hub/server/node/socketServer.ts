import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { connectNdjson } from '@hediet/linkrpc/node';
import type { IMessageTransport, JsonRpcMessage } from '@hediet/linkrpc';
import type {
    ITransportServer,
    TopologyTransportInfo,
    Transport,
} from '@hediet/linkrpc/hub/common';

/**
 * A {@link Transport} over a Node socket that still exposes the underlying
 * {@link net.Socket}. Provenance providers (peercred, etc.) read `socket`;
 * the hub core never does. Framing is newline-delimited JSON, and the
 * connection has already completed the `hubrpc::initialize` handshake.
 */
export class NodeSocketTransport implements Transport {
    private readonly _closeHandlers: (() => void)[] = [];
    private _closed = false;

    /**
     * Token presented by the peer in the `hubrpc::initialize` handshake. When
     * the server was started with {@link SocketServerOptions.isTokenAccepted}
     * the token has already been validated (the connection would otherwise have
     * been dropped); a {@link ConnectionProvenanceProvider} can read it to
     * further attest the peer (e.g. map a one-shot run token to an identity).
     * `undefined` when the handshake carried no token.
     */
    public initializeToken: string | undefined;

    constructor(
        public readonly socket: net.Socket,
        private readonly _inner: IMessageTransport,
        public readonly topologyInfo?: TopologyTransportInfo,
    ) {
        socket.on('close', () => this._fireClose());
        socket.on('error', () => this.dispose());
    }

    public send(message: JsonRpcMessage): void | Promise<void> {
        return this._inner.send(message);
    }

    public setListener(listener: ((message: JsonRpcMessage) => void) | undefined): void {
        this._inner.setListener(listener);
    }

    public onDidClose(handler: () => void): void {
        if (this._closed) {
            queueMicrotask(handler);
            return;
        }
        this._closeHandlers.push(handler);
    }

    public dispose(): void {
        this._inner.dispose();
        try {
            this.socket.destroy();
        } catch { /* ignore */ }
    }

    private _fireClose(): void {
        if (this._closed) return;
        this._closed = true;
        for (const handler of this._closeHandlers) {
            handler();
        }
        this._closeHandlers.length = 0;
    }
}

export interface SocketServerOptions {
    /**
     * Named pipe (Windows) / UDS path (Unix) to listen on. Defaults to a
     * per-instance computed path.
     */
    readonly endpoint?: string;
    /**
     * Validate the token presented in the client's `hubrpc::initialize`
     * handshake. Resolve `true` to admit the connection, `false` to reject it
     * (the socket is dropped before it reaches the connection handler). Called
     * live on every connection, so a dynamic allow-list (e.g. one-shot run
     * tokens added for the lifetime of a spawned child) is re-read per connect.
     *
     * Omit to accept any token: the handshake is still required and the token
     * is captured onto {@link NodeSocketTransport.initializeToken} for a
     * provenance provider, but it is not gated.
     */
    readonly isTokenAccepted?: (token: string | undefined) => Promise<boolean>;
}

/**
 * A hub-agnostic {@link ITransportServer} over a named pipe / UDS. It listens,
 * accepts, runs the `hubrpc::initialize` handshake (authentication + protocol
 * negotiation), frames each socket as a {@link NodeSocketTransport}, and hands
 * it to the connection handler — no hub coupling. Compose
 * attestation/identity on top via `withProvenance` and
 * {@link HubConnectionAcceptor}.
 *
 * The handshake's token is validated via
 * {@link SocketServerOptions.isTokenAccepted} when provided; otherwise any
 * token is accepted and merely captured for a provenance provider.
 */
export class SocketServer implements ITransportServer<NodeSocketTransport> {
    private readonly _server: net.Server;
    private readonly _endpoint: string;
    private readonly _live = new Set<NodeSocketTransport>();
    private readonly _isTokenAccepted: (token: string | undefined) => Promise<boolean>;
    private _handler: ((transport: NodeSocketTransport) => void) | undefined;
    private _disposed = false;

    private constructor(
        endpoint: string,
        isTokenAccepted: ((token: string | undefined) => Promise<boolean>) | undefined,
    ) {
        this._endpoint = endpoint;
        this._isTokenAccepted = isTokenAccepted ?? (async () => true);
        this._server = net.createServer((socket) => this._onConnection(socket));
    }

    /** Bind + listen (with stale-UDS unlink retry), resolving once ready. */
    public static async start(options: SocketServerOptions = {}): Promise<SocketServer> {
        const server = new SocketServer(
            options.endpoint ?? SocketServer.allocSocketPath(),
            options.isTokenAccepted,
        );
        await server._listenWithRetry();
        return server;
    }

    /** Allocate a fresh, unused socket path (named pipe on Windows, UDS elsewhere). */
    public static allocSocketPath(): string {
        const id = randomUUID();
        if (process.platform === 'win32') {
            return `\\\\.\\pipe\\vscode-linkrpc-${id}`;
        }
        return path.join(os.tmpdir(), `vscode-linkrpc-${id}.sock`);
    }

    public get endpoint(): string {
        return this._endpoint;
    }

    public setConnectionHandler(handler: (transport: NodeSocketTransport) => void): void {
        this._handler = handler;
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        for (const t of this._live) {
            t.dispose();
        }
        this._live.clear();
        this._server.close();
        if (process.platform !== 'win32') {
            try {
                fs.unlinkSync(this._endpoint);
            } catch { /* ignore */ }
        }
    }

    private _onConnection(socket: net.Socket): void {
        void this._acceptConnection(socket);
    }

    /**
     * Run the `hubrpc::initialize` handshake on the freshly accepted socket,
     * then frame it as a {@link NodeSocketTransport} and hand it to the
     * connection handler. A failed handshake (bad/missing token, wrong first
     * message, or timeout) drops the socket without reaching the handler.
     */
    private async _acceptConnection(socket: net.Socket): Promise<void> {
        socket.on('error', () => socket.destroy());
        let connected: { transport: IMessageTransport; token?: string; };
        try {
            connected = await connectNdjson({
                input: socket,
                output: socket,
                initialize: { kind: 'server', isTokenAccepted: this._isTokenAccepted },
            });
        } catch {
            socket.destroy();
            return;
        }
        if (this._disposed) {
            connected.transport.dispose();
            socket.destroy();
            return;
        }
        const transport = new NodeSocketTransport(
            socket,
            connected.transport,
            {
                type: process.platform === 'win32' ? 'named-pipe' : 'unix',
                path: this._endpoint,
            },
        );
        transport.initializeToken = connected.token;
        this._live.add(transport);
        transport.onDidClose(() => this._live.delete(transport));
        this._handler?.(transport);
    }

    private async _listenWithRetry(): Promise<void> {        // On Unix, EADDRINUSE on our deterministic path means a stale UDS from
        // a crashed instance — unlink and retry once. On Windows, named pipes
        // are kernel-managed and may linger briefly after close — retry with
        // backoff over a bounded window.
        const isWin = process.platform === 'win32';
        const deadline = Date.now() + 1000;
        let delay = 10;
        while (true) {
            try {
                await this._listenOnce();
                return;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
                if (!isWin) {
                    try {
                        fs.unlinkSync(this._endpoint);
                    } catch { /* ignore */ }
                    await this._listenOnce();
                    return;
                }
                if (Date.now() >= deadline) throw err;
                await new Promise((r) => setTimeout(r, delay));
                delay = Math.min(delay * 2, 100);
            }
        }
    }

    private _listenOnce(): Promise<void> {
        return new Promise((resolve, reject) => {
            const onError = (err: Error) => {
                this._server.removeListener('error', onError);
                reject(err);
            };
            this._server.once('error', onError);
            this._server.listen(this._endpoint, () => {
                this._server.removeListener('error', onError);
                resolve();
            });
        });
    }
}
