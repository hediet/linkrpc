import type {
    IMessageTransport,
    JsonRpcMessage,
    JsonValue,
} from '@hediet/linkrpc';
import type { Disposable, JsonRpcTransport } from './transport';

export interface CloseAwareMessageTransport<
    TIncoming = JsonRpcMessage,
    TOutgoing = JsonRpcMessage,
> extends IMessageTransport<TIncoming, TOutgoing> {
    readonly closed: boolean;
    readonly closeReason: string | undefined;
    onClose(listener: (reason?: string) => void): Disposable;
}

/** Adapt a parsed JSON-RPC transport to the transport consumed by LinkRpcConnection. */
export function adaptJsonRpcTransport(
    transport: JsonRpcTransport,
    options: { maxPendingMessages?: number } = {},
): CloseAwareMessageTransport<JsonRpcMessage, JsonRpcMessage> {
    const maxPendingMessages = options.maxPendingMessages ?? 1_024;
    if (!Number.isSafeInteger(maxPendingMessages) || maxPendingMessages < 1) {
        throw new Error('maxPendingMessages must be a positive safe integer');
    }
    let listener: ((message: JsonRpcMessage) => void) | undefined;
    const backlog: JsonRpcMessage[] = [];
    const closeListeners = new Set<(reason?: string) => void>();
    let closeReason: string | undefined;
    let disposed = false;
    const messages = transport.onMessage((frame) => {
        if (transport.closed || disposed) return;
        try {
            const message = assertJsonRpcMessage(frame);
            if (listener) listener(message);
            else if (backlog.length < maxPendingMessages) backlog.push(message);
            else transport.close(`JSON-RPC message backlog exceeded ${maxPendingMessages}`);
        } catch (error) {
            transport.close(error instanceof Error ? error.message : String(error));
        }
    });
    const closeSubscription = transport.onClose((reason) => {
        closeReason = reason;
        listener = undefined;
        backlog.length = 0;
        for (const closeListener of closeListeners) closeListener(reason);
        closeListeners.clear();
    });

    return {
        get closed(): boolean { return transport.closed; },
        get closeReason(): string | undefined { return closeReason; },
        send(message): Promise<void> {
            assertJsonRpcMessage(message);
            return transport.send(message as unknown as JsonValue);
        },
        setListener(value): void {
            if (disposed || transport.closed) return;
            listener = value;
            while (listener && backlog.length > 0) listener(backlog.shift()!);
        },
        onClose(closeListener): Disposable {
            if (transport.closed) {
                let disposed = false;
                queueMicrotask(() => { if (!disposed) closeListener(closeReason); });
                return { dispose: () => { disposed = true; } };
            }
            closeListeners.add(closeListener);
            return { dispose: () => closeListeners.delete(closeListener) };
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            messages.dispose();
            listener = undefined;
            backlog.length = 0;
            transport.close('disposed');
            closeSubscription.dispose();
            closeListeners.clear();
        },
    };
}

export function assertJsonRpcMessage(value: unknown): JsonRpcMessage {
    if (!isObject(value) || value.jsonrpc !== '2.0') {
        throw new Error('Invalid external JSON-RPC message: expected jsonrpc "2.0"');
    }
    const hasMethod = typeof value.method === 'string';
    const hasId = Object.prototype.hasOwnProperty.call(value, 'id');
    if (hasMethod) {
        if (hasId && !isRequestId(value.id)) {
            throw new Error('Invalid external JSON-RPC request id');
        }
        if ('params' in value && value.params === undefined) {
            throw new Error('Invalid external JSON-RPC params');
        }
        return value as unknown as JsonRpcMessage;
    }
    if (!hasId || !(value.id === null || isRequestId(value.id))) {
        throw new Error('Invalid external JSON-RPC response id');
    }
    const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
    if (hasResult === hasError) {
        throw new Error('Invalid external JSON-RPC response: expected exactly one of result or error');
    }
    if (hasError) {
        const error = value.error;
        if (!isObject(error) || typeof error.code !== 'number' || typeof error.message !== 'string') {
            throw new Error('Invalid external JSON-RPC error object');
        }
    }
    return value as unknown as JsonRpcMessage;
}

function isObject(value: unknown): value is Record<string, JsonValue> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
