import * as readline from 'node:readline';
import type { JsonValue } from '@hediet/linkrpc';
import type { Disposable, JsonRpcTransport } from './transport';

export interface NdjsonJsonRpcTransportOptions {
    readonly input: NodeJS.ReadableStream;
    readonly output: NodeJS.WritableStream;
}

/** Adapt newline-delimited JSON-RPC stdio streams to a message transport. */
export function createNdjsonJsonRpcTransport(
    options: NdjsonJsonRpcTransportOptions,
): JsonRpcTransport {
    const messageListeners = new Set<(frame: JsonValue) => void>();
    const closeListeners = new Set<(reason?: string) => void>();
    const backlog: JsonValue[] = [];
    const lines = readline.createInterface({ input: options.input });
    let closed = false;

    const finish = (reason?: string): void => {
        if (closed) return;
        closed = true;
        lines.close();
        for (const listener of closeListeners) listener(reason);
    };

    lines.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let frame: JsonValue;
        try {
            frame = JSON.parse(trimmed) as JsonValue;
        } catch (error) {
            finish(`Invalid JSON-RPC NDJSON frame: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        if (messageListeners.size === 0) {
            backlog.push(frame);
            return;
        }
        for (const listener of messageListeners) listener(frame);
    });
    lines.on('close', () => finish('closed'));
    options.input.on('error', (error) => finish(error.message));
    options.output.on('error', (error) => finish(error.message));

    return {
        send(frame): Promise<void> {
            if (closed) return Promise.reject(new Error('JSON-RPC stdio transport is closed'));
            return new Promise<void>((resolve, reject) => {
                options.output.write(`${JSON.stringify(frame)}\n`, (error?: Error | null) => {
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
            closeListeners.add(listener);
            return { dispose: () => closeListeners.delete(listener) };
        },
        close(reason): void {
            finish(reason);
        },
    };
}
