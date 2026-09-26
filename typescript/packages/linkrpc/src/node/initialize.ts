import {
    type IMessageTransport,
    type MessageTransportTrace,
    traceMessageTransport,
} from '../transport/messageTransport';
import { runInitializeHandshake, type InitializeRole } from '../transport/initialize';
import { NdjsonTransport } from './ndjsonTransport';

export * from '../transport/initialize';

export interface ConnectNdjsonOptions {
    readonly input: NodeJS.ReadableStream;
    readonly output: NodeJS.WritableStream;
    readonly onClose?: () => void;
    /** Complete initialization before exposing the transport. */
    readonly initialize?: InitializeRole;
    /** Includes handshake messages; may contain credentials. */
    readonly trace?: MessageTransportTrace;
    readonly handshakeTimeoutMs?: number;
}

export interface ConnectedNdjson {
    readonly transport: IMessageTransport;
    readonly token?: string;
}

/** Construct NDJSON and complete the shared transport initialization handshake. */
export async function connectNdjson(opts: ConnectNdjsonOptions): Promise<ConnectedNdjson> {
    const role = opts.initialize;
    let rejectClosedHandshake: ((error: Error) => void) | undefined;
    const closedDuringHandshake = role
        ? new Promise<never>((_resolve, reject) => { rejectClosedHandshake = reject; })
        : undefined;
    const baseTransport = new NdjsonTransport(opts.input, opts.output, () => {
        try {
            opts.onClose?.();
        } finally {
            rejectClosedHandshake?.(new Error('hubrpc::initialize: transport closed during handshake'));
        }
    });
    const transport = opts.trace === undefined
        ? baseTransport
        : traceMessageTransport(baseTransport, opts.trace);
    if (!role) return { transport };
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
