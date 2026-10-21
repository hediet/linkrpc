import { type Channel, ErrorCode, type IncomingCall, type IRequestHandler, type IRequestSender, type JsonValue, JsonRpcChannel, RpcError } from '@hediet/linkrpc';
import { connectNdjson, type HubChannel } from '@hediet/linkrpc/node';

/** A raw, unsigned LinkRPC channel and its lifetime. */
export interface RawConnection {
    readonly channel: Channel<undefined, unknown>;
    /** Resolves when the connection closed. */
    readonly closed: Promise<void>;
    close(): void;
}

export function fromHubChannel(channel: HubChannel): RawConnection {
    const closed = new Promise<void>(resolve => { channel.onClose(resolve); });
    return { channel, closed, close: () => channel.close() };
}

/** Connect to a hub's application endpoint over `stream` as a client (empty token). */
export async function connectOverStream(stream: NodeJS.ReadableStream & NodeJS.WritableStream & { destroy(): void; }): Promise<RawConnection> {
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const { transport } = await connectNdjson({
        input: stream,
        output: stream,
        onClose: () => {
            stream.destroy();
            resolveClosed();
        },
        initialize: { kind: 'client', token: '' },
    });
    const rpc = JsonRpcChannel.createWithClose(transport);
    return {
        channel: rpc.channel,
        closed,
        close: () => {
            rpc.close();
            stream.destroy();
            resolveClosed();
        },
    };
}

/**
 * Forward every request and notification verbatim to `target`, like
 * `linkrpc hub tunnel`: the caller's `$hubrpc` envelope stays in `params`, so
 * the far hub verifies the original signature. Streamed messages and
 * cancellation are bridged both ways.
 */
export function forwardTo(target: IRequestSender<unknown>): IRequestHandler<undefined> {
    return {
        handleRequest: call => _forwardRequest(target, call),
        handleNotification: call => {
            void Promise.resolve(target.sendNotification(call.method, call.params)).catch(() => { /* fire-and-forget */ });
        },
    };
}

async function _forwardRequest(
    target: IRequestSender<unknown>,
    call: IncomingCall<undefined>,
): Promise<{ result: JsonValue; } | { error: { code: number; message: string; data?: JsonValue; }; }> {
    const forwarded = target.sendRequestWithStream(call.method, call.params, {
        onStreamMessage: payload => { void call.stream.send(payload); },
    });
    call.stream.onMessage(payload => { void forwarded.send(payload); });
    const cancel = (): void => { void forwarded.cancel((call.signal.reason as Error | undefined)?.message); };
    if (call.signal.aborted) cancel();
    else call.signal.addEventListener('abort', cancel, { once: true });
    try {
        return { result: await forwarded.result };
    } catch (error) {
        if (error instanceof RpcError) return { error: { code: error.code, message: error.message, data: error.data } };
        return { error: { code: ErrorCode.internalError, message: error instanceof Error ? error.message : String(error) } };
    }
}
