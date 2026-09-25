import type {
    InterfaceRegistration,
    JsonValue,
    LinkRpcConnection,
} from '@hediet/linkrpc';
import { jsonRpcConnectionInterface } from './interface';
import type { JsonRpcTransport } from './transport';

export interface RegisterJsonRpcConnectionServiceOptions {
    readonly connection: LinkRpcConnection<unknown>;
    readonly serviceId?: string;
    readonly openTransport: (
        params: JsonValue | undefined,
        signal: AbortSignal,
    ) => Promise<JsonRpcTransport>;
}

type RawCloseReason = 'cancelled' | 'closed' | 'disposed' | 'remoteClosed';

/** Register a raw JSON-RPC transport factory on a LinkRPC connection. */
export function registerJsonRpcConnectionService(
    options: RegisterJsonRpcConnectionServiceOptions,
): InterfaceRegistration {
    const active = new Set<JsonRpcTransport>();
    let disposed = false;
    const registration = options.connection.register(
        jsonRpcConnectionInterface,
        {
            connectRaw: async ({ params }, _ctx, stream) => {
                const transport = await options.openTransport(
                    params as JsonValue | undefined,
                    stream.signal,
                );
                if (disposed) {
                    transport.close('disposed');
                    return { reason: 'disposed' as const };
                }
                active.add(transport);
                if (stream.signal.aborted) {
                    active.delete(transport);
                    transport.close('cancelled');
                    return { reason: 'cancelled' as const };
                }
                if (transport.closed) {
                    active.delete(transport);
                    throw new Error('JSON-RPC transport closed before it was ready');
                }

                let settle!: (reason: RawCloseReason) => void;
                const closed = new Promise<RawCloseReason>((resolve) => {
                    let settled = false;
                    settle = (reason) => {
                        if (settled) return;
                        settled = true;
                        resolve(reason);
                    };
                });
                let outbound = Promise.resolve();
                const messages = transport.onMessage((frame) => {
                    outbound = outbound
                        .then(() => stream.send({ type: 'frame', frame }))
                        .catch(() => settle('remoteClosed'));
                });
                const closure = transport.onClose(() => settle('remoteClosed'));
                let inbound = Promise.resolve();
                stream.onMessage(({ frame }) => {
                    inbound = inbound
                        .then(() => transport.send(frame as JsonValue))
                        .catch(() => settle('remoteClosed'));
                });
                await stream.send({ type: 'ready' });

                const abort = waitForAbort(stream.signal);
                const reason = await Promise.race([
                    closed,
                    abort.promise.then(() => 'cancelled' as const),
                ]);
                abort.dispose();
                messages.dispose();
                closure.dispose();
                active.delete(transport);
                transport.close(reason);
                return { reason };
            },
        },
        options.serviceId === undefined ? {} : { serviceId: options.serviceId },
    );
    return {
        dispose(): void {
            if (disposed) return;
            disposed = true;
            registration.dispose();
            for (const transport of active) transport.close('disposed');
            active.clear();
        },
    };
}

function waitForAbort(signal: AbortSignal): { promise: Promise<void>; dispose(): void; } {
    if (signal.aborted) return { promise: Promise.resolve(), dispose() {} };
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    const onAbort = (): void => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    return {
        promise,
        dispose(): void {
            signal.removeEventListener('abort', onAbort);
        },
    };
}
