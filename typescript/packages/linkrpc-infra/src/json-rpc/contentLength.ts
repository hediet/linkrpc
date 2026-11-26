import type { JsonValue } from '@hediet/linkrpc';
import type { Disposable, JsonRpcTransport } from './transport';

const MAX_FRAME_BACKLOG = 1_024;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1_024;
const DEFAULT_MAX_BODY_BYTES = 64 * 1_024 * 1_024;
const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');

export interface ContentLengthJsonRpcTransportOptions {
    readonly input: NodeJS.ReadableStream;
    readonly output: NodeJS.WritableStream;
    readonly maxHeaderBytes?: number;
    readonly maxBodyBytes?: number;
}

/**
 * Adapt Content-Length framed JSON-RPC streams (as used by LSP and DAP)
 * to a {@link JsonRpcTransport}.
 */
export function createContentLengthJsonRpcTransport(
    options: ContentLengthJsonRpcTransportOptions,
): JsonRpcTransport {
    const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
        throw new Error('maxHeaderBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
        throw new Error('maxBodyBytes must be a positive safe integer');
    }

    const messageListeners = new Set<(frame: JsonValue) => void>();
    const closeListeners = new Set<(reason?: string) => void>();
    const backlog: JsonValue[] = [];
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let expectedBodyBytes: number | undefined;
    let closed = false;
    let closeReason: string | undefined;

    const finish = (reason?: string): void => {
        if (closed) return;
        closed = true;
        closeReason = reason;
        options.input.off('data', onData);
        options.input.off('end', onEnd);
        options.input.off('close', onClose);
        options.input.off('error', onError);
        options.output.off('error', onError);
        buffer = Buffer.alloc(0);
        expectedBodyBytes = undefined;
        for (const listener of closeListeners) listener(reason);
        closeListeners.clear();
    };

    const emitFrame = (frame: JsonValue): void => {
        if (messageListeners.size === 0) {
            if (backlog.length >= MAX_FRAME_BACKLOG) {
                finish('JSON-RPC Content-Length frame backlog exceeded');
                return;
            }
            backlog.push(frame);
            return;
        }
        for (const listener of messageListeners) listener(frame);
    };

    const processBuffer = (): void => {
        while (!closed) {
            if (expectedBodyBytes === undefined) {
                const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
                if (headerEnd === -1) {
                    if (buffer.length > maxHeaderBytes) {
                        finish(`JSON-RPC header exceeded ${maxHeaderBytes} bytes`);
                    }
                    return;
                }
                if (headerEnd > maxHeaderBytes) {
                    finish(`JSON-RPC header exceeded ${maxHeaderBytes} bytes`);
                    return;
                }
                const headerText = buffer.subarray(0, headerEnd).toString('ascii');
                const contentLength = parseContentLength(headerText);
                if (contentLength === undefined) {
                    finish('Invalid JSON-RPC headers: missing or invalid Content-Length');
                    return;
                }
                if (contentLength > maxBodyBytes) {
                    finish(`JSON-RPC body exceeded ${maxBodyBytes} bytes`);
                    return;
                }
                buffer = buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
                expectedBodyBytes = contentLength;
            }

            if (buffer.length < expectedBodyBytes) {
                return;
            }

            const bodyBytes = buffer.subarray(0, expectedBodyBytes);
            buffer = buffer.subarray(expectedBodyBytes);
            expectedBodyBytes = undefined;

            let frame: JsonValue;
            try {
                frame = JSON.parse(bodyBytes.toString('utf8')) as JsonValue;
            } catch (error) {
                finish(`Invalid JSON-RPC Content-Length body: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            emitFrame(frame);
        }
    };

    const onData = (chunk: string | Buffer): void => {
        if (closed) return;
        const next = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        buffer = buffer.length === 0 ? next : Buffer.concat([buffer, next]);
        processBuffer();
    };

    const onEnd = (): void => finish('closed');
    const onClose = (): void => finish('closed');
    const onError = (error: Error): void => finish(error.message);

    options.input.on('data', onData);
    options.input.on('end', onEnd);
    options.input.on('close', onClose);
    options.input.on('error', onError);
    options.output.on('error', onError);

    return {
        get closed(): boolean {
            return closed;
        },
        send(frame): Promise<void> {
            if (closed) {
                return Promise.reject(new Error('JSON-RPC Content-Length transport is closed'));
            }
            const body = JSON.stringify(frame);
            const bodyBytes = Buffer.byteLength(body, 'utf8');
            const payload = `Content-Length: ${bodyBytes}\r\n\r\n${body}`;
            return new Promise<void>((resolve, reject) => {
                options.output.write(payload, 'utf8', (error?: Error | null) => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        },
        onMessage(listener): Disposable {
            messageListeners.add(listener);
            for (const frame of backlog.splice(0)) listener(frame);
            return { dispose: () => messageListeners.delete(listener) };
        },
        onClose(listener): Disposable {
            if (closed) {
                let disposed = false;
                queueMicrotask(() => {
                    if (!disposed) listener(closeReason);
                });
                return { dispose: () => { disposed = true; } };
            }
            closeListeners.add(listener);
            return { dispose: () => closeListeners.delete(listener) };
        },
        close(reason): void {
            finish(reason);
        },
    };
}

function parseContentLength(headerText: string): number | undefined {
    let contentLength: number | undefined;
    for (const line of headerText.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        if (name !== 'content-length') continue;
        const rawValue = line.slice(colon + 1).trim();
        if (!/^\d+$/.test(rawValue)) return undefined;
        const parsed = Number(rawValue);
        if (!Number.isSafeInteger(parsed)) return undefined;
        contentLength = parsed;
    }
    return contentLength;
}
