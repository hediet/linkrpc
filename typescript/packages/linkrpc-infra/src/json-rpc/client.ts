import type { InterfaceClient, JsonValue } from '@hediet/linkrpc';
import { jsonRpcConnectionInterface } from './interface';
import type { Disposable, JsonRpcTransport } from './transport';

type JsonRpcConnectionClient = InterfaceClient<typeof jsonRpcConnectionInterface>;
const MAX_RAW_FRAME_BACKLOG = 1_024;

export async function connectRawJsonRpcTransport(
    client: JsonRpcConnectionClient,
    params?: JsonValue,
): Promise<JsonRpcTransport> {
    const messageListeners = new Set<(frame: JsonValue) => void>();
    const closeListeners = new Set<(reason?: string) => void>();
    const backlog: JsonValue[] = [];
    let buffering = true;
    let closed = false;
    let closeReason: string | undefined;

    const finish = (reason?: string): void => {
        if (closed) return;
        closed = true;
        closeReason = reason;
        for (const listener of closeListeners) listener(reason);
    };

    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const call = client.connectRaw(
        params === undefined ? {} : { params },
        {
            onMessage: (event) => {
                if (event.type === 'ready') {
                    resolveReady();
                    return;
                }
                const frame = event.frame as JsonValue;
                if (buffering) {
                    if (backlog.length >= MAX_RAW_FRAME_BACKLOG) {
                        const reason = 'Raw JSON-RPC frame backlog exceeded';
                        finish(reason);
                        void call.cancel(reason);
                        return;
                    }
                    backlog.push(frame);
                    return;
                }
                for (const listener of messageListeners) listener(frame);
            },
        },
    );
    void call.then(
        ({ reason }) => finish(reason),
        (error) => {
            rejectReady(error);
            finish(error instanceof Error ? error.message : String(error));
        },
    );
    await ready;

    return {
        async send(frame): Promise<void> {
            if (closed) {
                throw new Error(`JSON-RPC transport is closed: ${closeReason ?? 'closed'}`);
            }
            await call.send({ frame });
        },
        onMessage(listener): Disposable {
            const registration = addListener(messageListeners, listener);
            if (buffering) {
                buffering = false;
                for (const frame of backlog.splice(0)) listener(frame);
            }
            return registration;
        },
        onClose(listener): Disposable {
            if (closed) {
                let disposed = false;
                queueMicrotask(() => {
                    if (!disposed) listener(closeReason);
                });
                return { dispose: () => { disposed = true; } };
            }
            return addListener(closeListeners, listener);
        },
        close(reason): void {
            finish(reason ?? 'cancelled');
            void call.cancel(reason);
        },
    };
}

function addListener<T>(listeners: Set<T>, listener: T): Disposable {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
}
