import { ErrorCode, isRequest, type JsonRpcMessage } from '../protocol/jsonRpc';
import type { JsonValue } from '../protocol/jsonValue';
import {
    type IMessageTransport,
    type MessageTransportTrace,
    traceMessageTransport,
} from '../transport/messageTransport';
import { NdjsonTransport } from './ndjsonTransport';

/**
 * Reserved transport-handshake method. Sent as the very first message on a
 * connection that authenticates and/or negotiates transport details. It is
 * handled entirely by the transport layer (via {@link connectNdjson}) and is
 * never forwarded to the hub or any service — it is not a routed call.
 */
export const INITIALIZE_METHOD = 'linkrpc::initialize';

/** Current transport protocol version. */
export const INITIALIZE_PROTOCOL_VERSION = 1;

/** Default time (ms) to wait for the handshake message before giving up. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** Fixed request id for the initiator's `linkrpc::initialize` request. */
const INITIALIZE_REQUEST_ID = 0;

export interface InitializeParams {
    readonly protocolVersion: number;
    /** Shared-secret auth token, when the transport requires one. */
    readonly token?: string;
}

export interface InitializeResult {
    readonly protocolVersion: number;
}

/**
 * The handshake role for a connection:
 *  - `client`: send `linkrpc::initialize` and await the reply (the dialing side).
 *  - `server`: require `linkrpc::initialize` as the first message, validate the
 *    token, and reply (the accepting side).
 */
export type InitializeRole =
    | { readonly kind: 'client'; readonly token?: string; }
    | {
        readonly kind: 'server';
        readonly isTokenAccepted: (token: string | undefined) => Promise<boolean>;
    };

export interface ConnectNdjsonOptions {
    readonly input: NodeJS.ReadableStream;
    readonly output: NodeJS.WritableStream;
    readonly onClose?: () => void;
    /**
     * Run a `linkrpc::initialize` handshake before the transport goes live. Omit
     * for trusted links that need neither auth nor negotiation (e.g. stdio).
     */
    readonly initialize?: InitializeRole;
    /** Observe all messages, including the initialize handshake. */
    readonly trace?: MessageTransportTrace;
    /** Override the handshake timeout (ms). */
    readonly handshakeTimeoutMs?: number;
}

export interface ConnectedNdjson {
    /**
     * The connected transport, already past the handshake. Callers never see
     * the pre-handshake transport, so the "initialize is the first message"
     * invariant holds structurally and the wire setup stays free to evolve.
     */
    readonly transport: IMessageTransport;
    /** The token presented by the peer (server role); `undefined` otherwise. */
    readonly token?: string;
}

/**
 * The single supported way to build an ndjson transport. Constructs the
 * transport over `input`/`output` and, when {@link ConnectNdjsonOptions.initialize}
 * is set, runs the `linkrpc::initialize` handshake internally before resolving.
 *
 * Rejects (after disposing the transport) when the handshake fails — a bad or
 * missing token, a wrong/absent first message, or a timeout. The accepting side
 * should treat a rejection as "drop this connection".
 */
export async function connectNdjson(opts: ConnectNdjsonOptions): Promise<ConnectedNdjson> {
    const role = opts.initialize;
    let rejectClosedHandshake: ((error: Error) => void) | undefined;
    const closedDuringHandshake = role
        ? new Promise<never>((_resolve, reject) => {
            rejectClosedHandshake = reject;
        })
        : undefined;
    const baseTransport = new NdjsonTransport(opts.input, opts.output, () => {
        try {
            opts.onClose?.();
        } finally {
            rejectClosedHandshake?.(new Error('linkrpc::initialize: transport closed during handshake'));
        }
    });
    const transport = opts.trace === undefined
        ? baseTransport
        : traceMessageTransport(baseTransport, opts.trace);

    if (!role) {
        return { transport };
    }

    try {
        const { token } = await Promise.race([
            runInitializeHandshake(transport, role, {
                ...(opts.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: opts.handshakeTimeoutMs } : {}),
            }),
            closedDuringHandshake!,
        ]);
        rejectClosedHandshake = undefined;
        return { transport, ...(token !== undefined ? { token } : {}) };
    } catch (err) {
        rejectClosedHandshake = undefined;
        transport.dispose();
        throw err;
    }
}

export interface RunInitializeHandshakeOptions {
    /** Override the handshake timeout (ms). */
    readonly handshakeTimeoutMs?: number;
}

/**
 * Run the `linkrpc::initialize` handshake on an already-constructed transport.
 * Used for transports that the caller builds itself (e.g. WebSocket), where
 * {@link connectNdjson} does not apply. On failure it throws but does NOT
 * dispose the transport — the caller owns it and decides how to tear down.
 *
 * For ndjson links, prefer {@link connectNdjson}, which constructs the
 * transport and runs this handshake atomically.
 */
export async function runInitializeHandshake(
    transport: IMessageTransport,
    role: InitializeRole,
    options: RunInitializeHandshakeOptions = {},
): Promise<{ readonly token?: string; }> {
    const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (role.kind === 'client') {
        await _runClientHandshake(transport, role.token, timeoutMs);
        return {};
    }
    const token = await _runServerHandshake(transport, role.isTokenAccepted, timeoutMs);
    return { token };
}

async function _runClientHandshake(
    transport: IMessageTransport,
    token: string | undefined,
    timeoutMs: number,
): Promise<void> {
    const reply = _nextMessage(transport, timeoutMs);
    const params: InitializeParams = {
        protocolVersion: INITIALIZE_PROTOCOL_VERSION,
        ...(token !== undefined ? { token } : {}),
    };
    void transport.send({
        jsonrpc: '2.0',
        id: INITIALIZE_REQUEST_ID,
        method: INITIALIZE_METHOD,
        params: params as unknown as JsonValue,
    });
    const message = await reply;
    if (isRequest(message) || !('id' in message) || message.id !== INITIALIZE_REQUEST_ID) {
        throw new Error('linkrpc::initialize: unexpected reply to handshake');
    }
    if ('error' in message) {
        throw new Error(`linkrpc::initialize rejected: ${message.error.message}`);
    }
}

async function _runServerHandshake(
    transport: IMessageTransport,
    isTokenAccepted: (token: string | undefined) => Promise<boolean>,
    timeoutMs: number,
): Promise<string | undefined> {
    const first = await _nextMessage(transport, timeoutMs);
    if (!isRequest(first) || first.method !== INITIALIZE_METHOD) {
        throw new Error('linkrpc::initialize: expected initialize as the first message');
    }
    const params = (first.params ?? {}) as Partial<InitializeParams>;
    if (!(await isTokenAccepted(params.token))) {
        void transport.send({
            jsonrpc: '2.0',
            id: first.id,
            error: { code: ErrorCode.invalidRequest, message: 'unauthenticated' },
        });
        throw new Error('linkrpc::initialize: unauthenticated');
    }
    const result: InitializeResult = { protocolVersion: INITIALIZE_PROTOCOL_VERSION };
    void transport.send({
        jsonrpc: '2.0',
        id: first.id,
        result: result as unknown as JsonValue,
    });
    return params.token;
}

/**
 * Consume exactly one incoming message, then detach. Relies on
 * {@link NdjsonTransport}'s buffering: setting the listener to `undefined` from
 * inside the callback stops the buffer drain, leaving any later messages queued
 * for the real listener the channel attaches afterwards.
 */
function _nextMessage(transport: IMessageTransport, timeoutMs: number): Promise<JsonRpcMessage> {
    return new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
            transport.setListener(undefined);
            reject(new Error('linkrpc::initialize: handshake timed out'));
        }, timeoutMs);
        transport.setListener((message) => {
            clearTimeout(timer);
            transport.setListener(undefined);
            resolve(message);
        });
    });
}
