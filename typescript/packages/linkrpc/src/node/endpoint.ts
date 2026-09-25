import { timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import type { WebSocketServer } from 'ws';
import type { Channel } from '../connection/channel';
import { formatEndpointUri, parseEndpointUri, type SocketEndpoint, type WsEndpoint } from '../connection/endpointUri';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';
import type { IDisposable } from '../disposable';
import type { IMessageTransport } from '../transport/messageTransport';
import { LINKRPC_ENDPOINT_VAR, LINKRPC_TOKEN_VAR, openHubChannel } from './hubClient';
import { connectNdjson, runInitializeHandshake } from './initialize';
import { openStdioChannel } from './stdio';
import { WebSocketTransport } from './webSocketClientTransport';

export interface StartEndpointOptions {
    /** Overrides LINKRPC_ENDPOINT. Use `listen:` to accept rather than dial. */
    readonly endpoint?: string;
    /** Overrides the URI token, then LINKRPC_TOKEN. Required for listeners. */
    readonly token?: string;
    /** Install services/signing on each authenticated, unsigned channel. */
    readonly onConnection: (connection: EndpointConnection) => void | Promise<void>;
    /** Listener peer/transport failures. Defaults to process.emitWarning. Must not throw. */
    readonly onError?: (error: Error) => void;
}

export interface EndpointConnection extends IDisposable {
    readonly channel: Channel<undefined, unknown>;
    /** Resolves on peer disconnect or disposal; pending RPC calls are rejected. */
    readonly closed: Promise<void>;
}

export interface StartedEndpoint extends IDisposable {
    /** Dialable bound address (including the assigned port), without credentials; or `stdio:`. */
    readonly endpoint: string;
    /** Resolves after shutdown. Listeners stay open until disposed or a server error. */
    readonly closed: Promise<void>;
}

/**
 * Start a Node application's RPC endpoint without imposing argument parsing,
 * signing, service registration, signal handlers, or process-exit policy.
 * Startup and initial onConnection failures reject. A listener isolates failed
 * peers, reports them via onError, and continues accepting other connections.
 */
export async function startEndpoint(options: StartEndpointOptions): Promise<StartedEndpoint> {
    const configured = (options.endpoint ?? process.env[LINKRPC_ENDPOINT_VAR])?.trim();
    if (!configured) throw new Error(`${LINKRPC_ENDPOINT_VAR} is not set; specify an endpoint.`);
    if (configured === 'stdio' || configured === 'stdio:') {
        return _startSingle('stdio:', await openStdioChannel(), options);
    }
    const listening = configured.startsWith('listen:');
    const target = parseEndpointUri(listening ? configured.slice('listen:'.length) : configured);
    if (target.kind !== 'socket' && target.kind !== 'ws') {
        throw new Error('startEndpoint supports stdio, socket, and LinkRPC WebSocket endpoints only.');
    }
    const token = options.token ?? target.token ?? process.env[LINKRPC_TOKEN_VAR] ?? '';
    const endpoint = formatEndpointUri({ ...target, token: undefined });
    if (!listening) {
        const channel = await openHubChannel({
            endpoint: target.kind === 'socket' ? target.path : target.url, token,
        });
        return _startSingle(endpoint, channel, options);
    }
    if (!token) throw new Error('Listening endpoints require a nonempty token.');
    return EndpointListener.start(target, token, options);
}

async function _startSingle(
    endpoint: string,
    source: Channel<undefined, unknown> & { close(): void; onClose(listener: () => void): IDisposable },
    options: StartEndpointOptions,
): Promise<StartedEndpoint> {
    let finish!: () => void;
    const closed = new Promise<void>(resolve => { finish = resolve; });
    const subscription = source.onClose(finish);
    void closed.then(() => subscription.dispose());
    const connection: EndpointConnection = { channel: source, closed, dispose: () => source.close() };
    try {
        await options.onConnection(connection);
        return { endpoint, closed, dispose: connection.dispose };
    } catch (error) {
        connection.dispose();
        await closed;
        throw error;
    }
}

class EndpointListener implements StartedEndpoint {
    private readonly _peers = new Set<ListenerPeer>();
    private readonly _tasks = new Set<Promise<void>>();
    private readonly _sockets = new Set<net.Socket>();
    private _disposed = false;
    private _finish!: () => void;
    public readonly closed = new Promise<void>(resolve => { this._finish = resolve; });

    private constructor(
        public readonly endpoint: string,
        private readonly _server: net.Server,
        private readonly _token: string,
        private readonly _options: StartEndpointOptions,
        private readonly _webSocketServer?: WebSocketServer,
    ) {
        _server.on('connection', socket => {
            this._sockets.add(socket);
            socket.on('close', () => this._sockets.delete(socket));
            if (this._disposed) socket.destroy();
        });
        _server.on('error', error => {
            this._report(error);
            this.dispose();
        });
    }

    public static async start(
        target: SocketEndpoint | WsEndpoint,
        token: string,
        options: StartEndpointOptions,
    ): Promise<EndpointListener> {
        if (target.kind === 'socket') {
            const server = net.createServer();
            await _listen(server, () => server.listen(target.path));
            const owner = new EndpointListener(formatEndpointUri({ ...target, token: undefined }), server, token, options);
            server.on('connection', socket => {
                const peer = owner._createPeer(() => socket.destroy());
                socket.on('error', error => owner._peerError(peer, error));
                socket.on('close', () => peer.dispose());
                owner._accept(peer, () => connectNdjson({
                    input: socket, output: socket,
                    onClose: () => peer.dispose(),
                    signal: peer.signal,
                    initialize: { kind: 'server', isTokenAccepted: async candidate => owner._accepts(candidate) },
                }).then(result => result.transport));
            });
            return owner;
        }
        const url = new URL(target.url);
        if (url.protocol !== 'ws:') throw new Error('Listening WebSockets require ws:; terminate TLS at a reverse proxy.');
        if (url.username || url.password || url.search || url.hash) {
            throw new Error('Listening WebSocket URLs cannot contain credentials, query parameters, or fragments.');
        }
        const { WebSocketServer } = await import('ws');
        const server = http.createServer((_request, response) => {
            response.writeHead(426);
            response.end('WebSocket upgrade required');
        });
        await _listen(server, () => server.listen(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, '')));
        const webSockets = new WebSocketServer({
            server,
            path: url.pathname,
            maxPayload: 16 * 1024 * 1024,
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            throw new Error('WebSocket listener did not bind a TCP address.');
        }
        url.port = String(address.port);
        const owner = new EndpointListener(url.toString(), server, token, options, webSockets);
        webSockets.on('error', error => {
            owner._report(error);
            owner.dispose();
        });
        webSockets.on('connection', socket => {
            const peer = owner._createPeer(() => socket.terminate());
            socket.on('error', error => owner._peerError(peer, error));
            socket.on('close', () => peer.dispose());
            const transport = new WebSocketTransport(socket, () => peer.dispose());
            peer.setTransport(transport);
            owner._accept(peer, async () => {
                await runInitializeHandshake(transport, {
                    kind: 'server', isTokenAccepted: async candidate => owner._accepts(candidate),
                }, { signal: peer.signal });
                return transport;
            });
        });
        return owner;
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        for (const peer of this._peers) peer.dispose();
        for (const socket of this._sockets) socket.destroy();
        const webSocketsClosed = this._webSocketServer
            ? new Promise<void>(resolve => this._webSocketServer!.close(() => resolve()))
            : Promise.resolve();
        this._server.close(() => {
            void Promise.all([...this._tasks, webSocketsClosed]).then(() => this._finish());
        });
    }

    private _accepts(candidate: string | undefined): boolean {
        if (typeof candidate !== 'string') return false;
        const expected = Buffer.from(this._token);
        const actual = Buffer.from(candidate);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }

    private _createPeer(closeSocket: () => void): ListenerPeer {
        const peer = new ListenerPeer(closeSocket);
        this._peers.add(peer);
        void peer.closed.then(() => this._peers.delete(peer));
        if (this._disposed) peer.dispose();
        return peer;
    }

    private _accept(peer: ListenerPeer, open: () => Promise<IMessageTransport>): void {
        const task = (async () => {
            try {
                const transport = await open();
                peer.setTransport(transport);
                if (this._disposed || peer.signal.aborted) return;
                const connection = peer.connect();
                await this._options.onConnection(connection);
            } catch (error) {
                const report = !this._disposed;
                peer.dispose();
                if (report) this._report(error);
            }
        })();
        this._tasks.add(task);
        void task.then(() => this._tasks.delete(task));
    }

    private _peerError(peer: ListenerPeer, error: Error): void {
        if (!peer.signal.aborted && !this._disposed) this._report(error);
        peer.dispose();
    }

    private _report(error: unknown): void {
        const report = this._options.onError ?? (error => process.emitWarning(error));
        try {
            report(error instanceof Error ? error : new Error(String(error)));
        } catch (error) {
            process.emitWarning(new Error('startEndpoint onError callback threw', { cause: error }));
        }
    }
}

class ListenerPeer implements IDisposable {
    private readonly _abort = new AbortController();
    public readonly signal = this._abort.signal;
    private _finish!: () => void;
    public readonly closed = new Promise<void>(resolve => { this._finish = resolve; });
    private _transport: IMessageTransport | undefined;
    private _closeChannel: (() => void) | undefined;

    constructor(private readonly _closeSocket: () => void) {}

    public setTransport(transport: IMessageTransport): void {
        this._transport = transport;
        if (this.signal.aborted) transport.dispose();
    }

    public connect(): EndpointConnection {
        const rpc = JsonRpcChannel.createWithClose(this._transport!);
        this._closeChannel = rpc.close;
        return { channel: rpc.channel, closed: this.closed, dispose: () => this.dispose() };
    }

    public dispose(): void {
        if (this.signal.aborted) return;
        this._abort.abort(new Error('Endpoint connection closed'));
        this._closeChannel?.();
        this._transport?.dispose();
        this._closeSocket();
        this._finish();
    }
}

function _listen(server: net.Server, listen: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
            listen();
        } catch (error) {
            server.removeListener('error', onError);
            server.removeListener('listening', onListening);
            reject(error);
        }
    });
}
