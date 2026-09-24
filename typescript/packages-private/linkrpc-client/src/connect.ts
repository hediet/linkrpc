import {
    type CapProvider,
    type Channel,
    type IMessageTransport,
    type MessageTransportTrace,
    type IRequestHandler,
    type IRequestSender,
    JsonRpcChannel,
    type OneShotCapStaging,
    type Principal,
    RpcError,
    type SigningCallCtx,
    SigningSender,
    traceMessageTransport,
} from '@hediet/linkrpc';
import {
    connectNdjson,
    type EndpointCommand,
    openWebSocket,
    runInitializeHandshake,
    WebSocketTransport,
} from '@hediet/linkrpc/node';
import { tapTransport } from '@hediet/linkrpc-hub/hub/server/transit';
import { spawnCommand } from '@hediet/linkrpc-hub/spawn';
import * as net from 'node:net';
import type { ResolvedEndpoint } from './endpoint';
import { startLocalHub, startLocalOverlay } from './localHub';

// `spawnCommand` is owned by the shared hub engine; the CLI re-exports it so
// existing `./connect` import sites keep working. (Socket-path allocation now
// lives on `SocketServer.allocSocketPath`.)
export { spawnCommand };

/**
 * Mutable signing config consulted per-call by the {@link SigningSender}
 * wrapping a {@link CliConnection.channel}. Starts empty; `setupHubSigning`
 * installs a {@link Principal} (identity + persistent caps) and an optional
 * {@link OneShotCapStaging} policy. Mutating a field takes effect on the
 * next outbound call.
 */
export interface CliSigning {
    principal?: Principal;
    oneShotCaps?: OneShotCapStaging;
    capProvider?: CapProvider;
}

/**
 * Tee every JSON-RPC message crossing the connection's transport to a line
 * sink, rendered like the hub's "Flows" view. For inspecting a *direct*
 * connection that never routes through a local hub.
 */
export interface ConnectLogOptions {
    readonly log?: (line: string) => void;
    /** Edge label for the far end in the rendered path. Default `"peer"`. */
    readonly remoteLabel?: string;
    /** Max JSON length per payload before truncation. Default 200. */
    readonly maxPayload?: number;
    /** Raw message trace, attached before any transport handshake. */
    readonly trace?: MessageTransportTrace;
}

/**
 * A live linkrpc connection plus the underlying child / socket. The CLI
 * owns both so it can wait for the channel to drain before tearing the
 * peer down.
 *
 * `signing` is the mutable holder consulted by the {@link SigningSender}
 * wrapping `channel`. Starts empty (unsigned plain JSON-RPC); populated
 * by `setupHubSigning`. User code with its own signing requirements can
 * mutate it directly.
 */
export interface CliConnection {
    readonly channel: IRequestSender<SigningCallCtx>;
    readonly signing: CliSigning;
    /**
     * The underlying signing {@link Channel} (sender + inbound binding seam).
     * Hand this to `new LinkRpcConnection(conn.rpcChannel)` when a command needs
     * to **serve** typed interfaces over the connection (e.g. `mcp-forward`
     * registers `mcpForwardInterface` + `enableReflection`). Constructing a
     * `LinkRpcConnection` from it binds the inbound handler, so do not also use
     * {@link setRequestHandler} on the same connection — they are mutually
     * exclusive inbound modes (last writer wins).
     */
    readonly rpcChannel: Channel<unknown, SigningCallCtx>;
    /**
     * Bind the raw inbound request/notification handler for this connection.
     * Lets a command (e.g. `tunnel`) receive *all* requests the peer routes
     * here, bypassing the typed {@link LinkRpcConnection} dispatch. Pass
     * `undefined` to detach.
     */
    setRequestHandler(handler: IRequestHandler | undefined): void;
    /** Close the transport, reject pending requests, kill the child (cmd) or destroy the socket (hub). */
    close(): void;
}

export async function connect(
    endpoint: ResolvedEndpoint,
    log?: ConnectLogOptions,
): Promise<CliConnection> {
    switch (endpoint.kind) {
        case 'cmd-stdio':
            return _connectCmdStdio(endpoint.command, endpoint.env, endpoint.cwd, log);
        case 'cmd-env':
            return _connectCmdEnv(endpoint.command, endpoint.provisionSlot, endpoint.env, endpoint.cwd, log);
        case 'ws':
            return _connectWs(endpoint, log);
        case 'ws-no-init':
            return _connectWs(endpoint, log);
        case 'socket':
            return _connectSocket(endpoint.path, endpoint.token, log);
    }
}

/**
 * Spawn a child from a command spec. `{ command }` is run through the OS shell
 * (so quoting / splitting follows the shell's rules); `{ argv }` is run
 * directly (no shell), except on Windows where `.cmd` shims need one.
 */
async function _connectCmdStdio(
    command: EndpointCommand,
    env: Readonly<Record<string, string>> | undefined,
    cwd: string | undefined,
    log?: ConnectLogOptions,
): Promise<CliConnection> {
    const child = spawnCommand(command, {
        stdio: ['pipe', 'pipe', 'inherit'],
        ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
    });
    if (!child.stdin || !child.stdout) {
        throw new Error('connect: child process exposes no stdio');
    }
    const input = child.stdin;
    const close = () => {
        // A child handling SIGTERM may still wait on its open stdin pipe.
        if (!input.destroyed && !input.writableEnded) input.end();
        if (!child.killed) child.kill();
    };
    const { transport } = await connectNdjson({
        input: child.stdout,
        output: child.stdin,
        onClose: close,
        trace: log?.trace,
    });
    return _makeCliConnection(transport, close, log);
}

/**
 * Start a private in-process hub, spawn the child as a participant, then
 * connect to the hub's socket. The child registers its services against the
 * hub exactly as it would against a remote one; we tear the hub + child down
 * when the connection closes.
 */
async function _connectCmdEnv(
    command: EndpointCommand,
    provisionSlot: string | undefined,
    env: Readonly<Record<string, string>> | undefined,
    cwd: string | undefined,
    log?: ConnectLogOptions,
): Promise<CliConnection> {
    return connectViaLocalHub({ command, provisionSlot, env, cwd, log });
}

/**
 * Spawn a child under an in-process local hub (`startLocalHub`) and connect
 * to that hub over a socket. Backs the standard `cmd-env` endpoint path; the
 * hub + child are torn down when the connection closes.
 */
export async function connectViaLocalHub(opts: {
    readonly command: EndpointCommand;
    readonly provisionSlot: string | undefined;
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
    readonly log?: ConnectLogOptions;
}): Promise<CliConnection> {
    const hub = await startLocalHub({
        command: opts.command,
        provisionSlot: opts.provisionSlot,
        env: opts.env,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    try {
        const conn = await _connectSocket(hub.socketPath, hub.token, opts.log);
        return {
            ...conn,
            close: () => {
                conn.close();
                hub.dispose();
            },
        };
    } catch (e) {
        hub.dispose();
        throw e;
    }
}

/**
 * Connect to a spawned `cmd-env` child through a {@link startLocalOverlay}
 * RootOverlay instead of a full local hub. Root-form calls (`identity::*`,
 * `hubGrantedServiceId::*`, `hubrpc.directory`, `hubAccess`) are served locally;
 * every prefixed request/response is relayed over the returned connection's
 * channel. Used by `tunnel --target-endpoint-cmd`: the tunnel forwards each
 * claimed request onto this channel and the overlay delivers it to the child —
 * no hub, no `hub` service id, no claim-wait, but `identity::*` still served so
 * `--provision-identity` targets work.
 */
export async function connectViaRootOverlay(opts: {
    readonly command: EndpointCommand;
    readonly provisionSlot: string | undefined;
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
    readonly grantedNamespace: string;
    readonly log?: ConnectLogOptions;
}): Promise<CliConnection> {
    const overlay = await startLocalOverlay({
        command: opts.command,
        provisionSlot: opts.provisionSlot,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        grantedNamespace: opts.grantedNamespace,
    });
    return _makeCliConnection(overlay.uplink, overlay.dispose, opts.log);
}

function _connectWs(
    endpoint: Extract<ResolvedEndpoint, { kind: 'ws' | 'ws-no-init'; }>,
    log?: ConnectLogOptions,
): Promise<CliConnection> {
    return openWebSocket(endpoint.url).then(async (ws) => {
        const closeWs = () => {
            try {
                ws.close();
            } catch { /* ignore */ }
        };
        const baseTransport = new WebSocketTransport(ws, closeWs);
        const transport = log?.trace === undefined
            ? baseTransport
            : traceMessageTransport(baseTransport, log.trace);
        if (endpoint.kind === 'ws') {
            try {
                await runInitializeHandshake(transport, {
                    kind: 'client',
                    token: endpoint.token ?? '',
                });
            } catch (err) {
                transport.dispose();
                closeWs();
                throw err;
            }
        }
        return _makeCliConnection(transport, closeWs, log);
    });
}

async function _connectSocket(
    socketPath: string,
    token: string | undefined,
    log?: ConnectLogOptions,
): Promise<CliConnection> {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
            socket.removeListener('error', onError);
            resolve();
        };
        const onError = (error: Error) => {
            socket.removeListener('connect', onConnect);
            socket.destroy();
            reject(error);
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
    });
    socket.on('error', () => socket.destroy());
    const { transport } = await connectNdjson({
        input: socket,
        output: socket,
        onClose: () => socket.destroy(),
        initialize: { kind: 'client', token: token ?? '' },
        trace: log?.trace,
    });
    return _makeCliConnection(transport, () => socket.destroy(), log);
}

/**
 * In-memory connection — for tests. The caller hands us a transport already
 * wired to a server-side channel (typically via `TransportPair`).
 */
export function connectViaTransport(transport: IMessageTransport): CliConnection {
    return _makeCliConnection(transport, () => { });
}

function _makeCliConnection(
    transport: IMessageTransport,
    onClose: () => void,
    log?: ConnectLogOptions,
): CliConnection {
    const tapped = log?.log === undefined
        ? transport
        : tapTransport(transport, {
            log: log.log,
            localLabel: 'cli',
            remoteLabel: log.remoteLabel ?? 'peer',
            ...(log.maxPayload !== undefined ? { maxPayload: log.maxPayload } : {}),
        });
    const signing: CliSigning = {};
    const wrapped = SigningSender.wrapChannel(
        JsonRpcChannel.create(tapped),
        signing,
    );
    const channel = wrapped.sender;
    return {
        channel,
        rpcChannel: wrapped,
        signing,
        setRequestHandler: (handler) => wrapped.setRequestHandler(handler),
        close: () => {
            channel.close();
            onClose();
        },
    };
}

export { RpcError };
