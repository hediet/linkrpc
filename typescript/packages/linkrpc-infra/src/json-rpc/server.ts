import type {
    InterfaceRegistration,
    JsonValue,
    LinkRpcConnection,
} from '@hediet/linkrpc';
import {
    jsonRpcConnectionInterface,
    type JsonRpcConnectionCloseReason,
} from './interface';
import type { JsonRpcTransport } from './transport';

export interface RegisterJsonRpcConnectionServiceOptions {
    readonly connection: LinkRpcConnection<unknown>;
    readonly serviceId?: string;
    readonly openTransport: (
        params: JsonValue | undefined,
        signal: AbortSignal,
    ) => Promise<JsonRpcTransport>;
}

/** Register a raw JSON-RPC transport factory on a LinkRPC connection. */
export function registerJsonRpcConnectionService(
    options: RegisterJsonRpcConnectionServiceOptions,
): InterfaceRegistration {
    return options.connection.register(
        jsonRpcConnectionInterface,
        {
            connectRaw: async ({ params }, _ctx, stream) => {
                const transport = await options.openTransport(
                    params as JsonValue | undefined,
                    stream.signal,
                );
                if (stream.signal.aborted) {
                    transport.close('cancelled');
                    return { reason: 'cancelled' as const };
                }

                let settle!: (reason: JsonRpcConnectionCloseReason) => void;
                const closed = new Promise<JsonRpcConnectionCloseReason>((resolve) => {
                    let settled = false;
                    settle = (reason) => {
                        if (settled) return;
                        settled = true;
                        resolve(reason);
                    };
                });
                const messages = transport.onMessage((frame) => {
                    void stream.send({ type: 'frame', frame }).catch(() => settle('remoteClosed'));
                });
                const closure = transport.onClose(() => settle('remoteClosed'));
                stream.onMessage(({ frame }) => {
                    void transport.send(frame as JsonValue).catch(() => settle('remoteClosed'));
                });
                await stream.send({ type: 'ready' });

                const reason = await Promise.race([
                    closed,
                    waitForAbort(stream.signal).then(() => 'cancelled' as const),
                ]);
                messages.dispose();
                closure.dispose();
                transport.close(reason);
                return { reason };
            },
        },
        options.serviceId === undefined ? {} : { serviceId: options.serviceId },
    );
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
    });
}
