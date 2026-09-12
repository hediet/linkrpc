import type { JsonRpcMessage, JsonValue } from '@hediet/linkrpc';
import {
    HeaderDelimitedTransport,
    type HeaderDelimitedTransportOptions,
} from '@hediet/linkrpc/node';
import type { Readable, Writable } from 'node:stream';
import { adaptJsonRpcTransport } from '../../src/json-rpc/messageTransport';
import type { Disposable, JsonRpcTransport } from '../../src/json-rpc/transport';

export interface LspJsonRpcTransportOptions extends HeaderDelimitedTransportOptions {
    readonly input: Readable;
    readonly output: Writable;
}

/**
 * A Language Server Protocol Content-Length transport.
 *
 * The streams remain owned by the caller and are not ended or destroyed by
 * close(). Framing, validation, limits, and truncation handling are provided
 * by core's HeaderDelimitedTransport.
 */
export function createLspJsonRpcTransport(
    options: LspJsonRpcTransportOptions,
): JsonRpcTransport {
    const messageListeners = new Set<(frame: JsonValue) => void>();
    const closeListeners = new Set<(reason?: string) => void>();
    let closeReason: string | undefined;
    const framed = new HeaderDelimitedTransport(
        options.input,
        options.output,
        (reason) => {
            closeReason = toLspCloseReason(reason);
            for (const listener of closeListeners) listener(closeReason);
        },
        options,
    );
    const dispatch = (message: JsonRpcMessage): void => {
        for (const listener of messageListeners) {
            listener(message as unknown as JsonValue);
        }
    };

    return {
        get closed(): boolean { return framed.closed; },
        send(frame): Promise<void> {
            return framed.send(frame as unknown as JsonRpcMessage);
        },
        onMessage(listener): Disposable {
            messageListeners.add(listener);
            if (messageListeners.size === 1) framed.setListener(dispatch);
            return {
                dispose(): void {
                    messageListeners.delete(listener);
                    if (messageListeners.size === 0) framed.setListener(undefined);
                },
            };
        },
        onClose(listener): Disposable {
            if (framed.closed) {
                let disposed = false;
                queueMicrotask(() => { if (!disposed) listener(closeReason ?? framed.closeReason); });
                return { dispose: () => { disposed = true; } };
            }
            closeListeners.add(listener);
            return { dispose: () => closeListeners.delete(listener) };
        },
        close(reason): void {
            framed.close(reason ?? 'LSP transport closed');
        },
    };
}

function toLspCloseReason(reason: string | undefined): string | undefined {
    return reason
        ?.replace(/^Invalid header-delimited frame:/, 'Invalid LSP frame:')
        .replace(/^Invalid header-delimited JSON payload:/, 'Invalid LSP JSON payload:')
        .replace(/^Truncated header-delimited frame$/, 'Truncated LSP frame')
        .replace(/^Header-delimited input closed$/, 'LSP input closed')
        .replace(/^Header-delimited input error:/, 'LSP input error:')
        .replace(/^Header-delimited output error:/, 'LSP output error:');
}

/** Create a LinkRPC-compatible transport for an LSP stream. No handshake is sent. */
export function createLspMessageTransport(options: LspJsonRpcTransportOptions) {
    return adaptJsonRpcTransport(createLspJsonRpcTransport(options));
}

export interface LspChildProcessStreams {
    readonly stdin: Writable;
    readonly stdout: Readable;
}

/** Adapt child stdio without taking ownership of, terminating, or waiting for the child. */
export function createLspChildProcessTransport(
    child: LspChildProcessStreams,
    options: HeaderDelimitedTransportOptions = {},
) {
    return createLspMessageTransport({ ...options, input: child.stdout, output: child.stdin });
}
