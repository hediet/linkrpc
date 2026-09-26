import { ErrorCode, isRequest, type JsonRpcMessage } from '../protocol/jsonRpc';
import type { JsonValue } from '../protocol/jsonValue';
import type { IMessageTransport } from './messageTransport';

/** Transport-only handshake, never forwarded to a routed service. */
export const INITIALIZE_METHOD = 'hubrpc::initialize';
export const LINKRPC_INITIALIZE_METHOD_ALIAS = 'linkrpc::initialize';
export const INITIALIZE_PROTOCOL_VERSION = 1;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const INITIALIZE_REQUEST_ID = 0;

export interface InitializeParams {
    readonly protocolVersion: number;
    readonly token?: string;
}

export interface InitializeResult {
    readonly protocolVersion: number;
}

export type InitializeRole =
    | { readonly kind: 'client'; readonly token?: string; }
    | {
        readonly kind: 'server';
        readonly isTokenAccepted: (token: string | undefined) => Promise<boolean>;
    };

export interface RunInitializeHandshakeOptions {
    readonly handshakeTimeoutMs?: number;
    readonly signal?: AbortSignal;
}

/** Run the shared initialization on any transport. The caller owns disposal. */
export async function runInitializeHandshake(
    transport: IMessageTransport,
    role: InitializeRole,
    options: RunInitializeHandshakeOptions = {},
): Promise<{ readonly token?: string; }> {
    if (options.signal?.aborted) throw new Error('hubrpc::initialize: handshake cancelled');
    const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (role.kind === 'client') {
        const reply = nextMessage(transport, timeoutMs, options.signal);
        const params: InitializeParams = {
            protocolVersion: INITIALIZE_PROTOCOL_VERSION,
            ...(role.token !== undefined ? { token: role.token } : {}),
        };
        void transport.send({
            jsonrpc: '2.0', id: INITIALIZE_REQUEST_ID, method: INITIALIZE_METHOD,
            params: params as unknown as JsonValue,
        });
        const message = await reply;
        if (isRequest(message) || !('id' in message) || message.id !== INITIALIZE_REQUEST_ID) {
            throw new Error('hubrpc::initialize: unexpected reply to handshake');
        }
        if ('error' in message) {
            throw new Error(`hubrpc::initialize rejected: ${message.error.message}`);
        }
        return {};
    }
    const first = await nextMessage(transport, timeoutMs, options.signal);
    if (!isRequest(first) || (first.method !== INITIALIZE_METHOD && first.method !== LINKRPC_INITIALIZE_METHOD_ALIAS)) {
        throw new Error('hubrpc::initialize: expected initialize as the first message');
    }
    const params = (first.params ?? {}) as Partial<InitializeParams>;
    if (!(await role.isTokenAccepted(params.token))) {
        void transport.send({
            jsonrpc: '2.0', id: first.id,
            error: { code: ErrorCode.invalidRequest, message: 'unauthenticated' },
        });
        throw new Error('hubrpc::initialize: unauthenticated');
    }
    const result: InitializeResult = { protocolVersion: INITIALIZE_PROTOCOL_VERSION };
    void transport.send({ jsonrpc: '2.0', id: first.id, result: result as unknown as JsonValue });
    return { token: params.token };
}

/** Detach after exactly one message, leaving buffered RPC messages for the channel. */
function nextMessage(transport: IMessageTransport, timeoutMs: number, signal?: AbortSignal): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            transport.setListener(undefined);
        };
        const abort = () => {
            cleanup();
            reject(new Error('hubrpc::initialize: handshake cancelled'));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('hubrpc::initialize: handshake timed out'));
        }, timeoutMs);
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        transport.setListener(message => { cleanup(); resolve(message); });
    });
}
