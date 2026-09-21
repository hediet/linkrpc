import type { JsonRpcMessage, JsonValue } from '../protocol/jsonRpc';
import type { IMessageTransport } from '../transport/messageTransport';

export class Channel<TInCtx = undefined, TOutCtx = undefined> {
    constructor(
        public readonly sender: IRequestSender<TOutCtx>,
        private readonly _setHandler: (h: IRequestHandler<TInCtx> | undefined) => void,
        private readonly _setWireObserver?: (observer: WireMessageObserver | undefined) => void,
    ) { }

    /** Bind the inbound request/notification handler. May be called before or after construction of {@link LinkRpcConnection}. */
    public setRequestHandler(handler: IRequestHandler<TInCtx> | undefined): void {
        this._setHandler(handler);
    }

    /**
     * Install the endpoint inspection observer at the JSON-RPC wire boundary.
     * Intended for {@link LinkRpcConnection}; ordinary consumers should use the
     * public `hubrpc.traffic` service instead.
     */
    public setWireMessageObserver(observer: WireMessageObserver | undefined): void {
        this._setWireObserver?.(observer);
    }

    /**
     * Compose this channel with a sender-side decorator (typically the
     * signing layer). The decorator wraps {@link sender} only; the
     * {@link setRequestHandler} binding is shared with the original channel
     * so the receive side is bound exactly once regardless of decoration depth.
     */
    public withSender<TNewOutCtx>(
        decorate: (raw: IRequestSender<TOutCtx>) => IRequestSender<TNewOutCtx>,
    ): Channel<TInCtx, TNewOutCtx> {
        return new Channel<TInCtx, TNewOutCtx>(
            decorate(this.sender),
            this._setHandler,
            this._setWireObserver,
        );
    }
}

export type WireMessageDirection = 'inbound' | 'outbound';
export type WireMessageObserver = (
    direction: WireMessageDirection,
    message: JsonRpcMessage,
) => void;

export interface IRequestHandler<TInCtx = undefined> {
    handleRequest(call: IncomingCall<TInCtx>): Promise<Result>;
    handleNotification(call: IncomingCall<TInCtx>): void;
}

/**
 * Inbound call observed by an {@link IRequestHandler}. `TInCtx` is the
 * per-call out-of-band context the transport attached on the receiving
 * side (e.g. the hub stamps `Participant` on overlay-bound messages).
 * For wire transports it's `undefined`.
 */
export interface IncomingCall<TInCtx = undefined> {
    method: string;
    params: JsonValue | undefined;
    /** Out-of-band context attached by the transport, if any. */
    context: TInCtx;
    /**
     * Per-call streaming handle. Both directions live on this object,
     * scoped to the request's lifetime. The inbound listener is auto-
     * detached when the handler's response settles. For notifications
     * (no request id) the handle is a no-op stub.
     */
    stream: IncomingStream;
    /**
     * Aborts when the caller cancels this in-flight request (a
     * `toCallee` `cancel` control), or when the hub cancels it on the
     * caller's behalf (caller disconnect / idle timeout). The handler
     * should observe this and settle promptly — typically by throwing,
     * which surfaces as a `cancelled` error response. For notifications
     * this never aborts.
     */
    signal: AbortSignal;
}

/**
 * Per-call streaming handle attached to {@link IncomingCall.stream}.
 * Scoped to a single in-flight request; the channel automatically
 * detaches the inbound listener when the handler's response settles.
 *
 * For notifications (which have no request id), `requestId` is
 * `undefined`, `send` is a no-op, and `onMessage` is a no-op.
 */
export interface IncomingStream {
    /** Emit a server→client stream notification correlated with this call. */
    send(payload: JsonValue): Promise<void>;
    /**
     * Register a listener for client→server stream messages correlated
     * with this call. Pass `undefined` to detach. Replaces any prior
     * listener. The channel detaches the listener automatically when
     * the handler's response settles.
     */
    onMessage(listener: ((payload: JsonValue) => void) | undefined): void;
    /**
     * Liveness probe toward the caller: emit a `toCaller` ping and
     * resolve once the caller's `pong` (matching nonce) returns. Rejects
     * if the request settles first. Independent of the channel's
     * automatic keepalive ping.
     */
    ping(): Promise<void>;
}

export type Result =
    | { result: JsonValue; }
    | { error: { code: number; message: string; data?: JsonValue; }; };

/**
 * What callers use to send. The {@link Channel} factory binds an
 * {@link IRequestHandler} at construction (immutable for the channel's
 * lifetime) and hands the caller back an `IRequestSender`.
 *
 * `TOutCtx` is the per-call context bag this sender understands. For
 * the base {@link JsonRpcChannel} it's `undefined` (the channel
 * doesn't read any overrides). Decorators like `SigningSender`
 * parametrise it on their own ctx shape.
 */
export interface IRequestSender<TOutCtx = undefined> {
    sendRequest(method: string, params: JsonValue | undefined, opts?: SendOpts<TOutCtx>): Promise<JsonValue>;
    sendNotification(method: string, params: JsonValue | undefined, opts?: SendOpts<TOutCtx>): Promise<void>;
    /**
     * Issue a request that participates in the streaming sub-protocol.
     * Returns synchronously with the wire request id, the result
     * promise, and a `send` for emitting client→server stream messages.
     */
    sendRequestWithStream(method: string, params: JsonValue | undefined, opts?: StreamSendOpts<TOutCtx>): RawStreamingCall;
    close(): void;
}

/**
 * Handle for a request issued via
 * {@link IRequestSender.sendRequestWithStream}. `send` emits
 * client→server stream messages correlated with this call. `result`
 * resolves with the call's response.
 */
export interface RawStreamingCall {
    readonly result: Promise<JsonValue>;
    /** Emit a client→server (`toCallee`) stream message correlated with this call. */
    send(payload: JsonValue): void;
    /**
     * Ask the callee to abort this in-flight request (a `toCallee`
     * `cancel` control). Advisory: the request settles via its normal
     * response (typically a `cancelled` error). `reason` is an open-set
     * diagnostic string (see `StreamControlReason`).
     */
    cancel(reason?: string): void;
    /**
     * Stop tracking this request locally and reject {@link result}. This does
     * not notify the callee; call {@link cancel} first when remote work should
     * also be cancelled. Safe to call after the request has already settled.
     */
    dispose?(reason?: string): void;
    /**
     * Liveness probe toward the callee: emit a `toCallee` ping and
     * resolve once the callee's `pong` (matching nonce) returns. Rejects
     * if the request settles first. Independent of the channel's
     * automatic keepalive ping.
     */
    ping(): Promise<void>;
}

/**
 * Per-send options.
 *
 * `interfaceHash` is interface-level call metadata: the schema hash of
 * the interface a typed proxy is calling. It is independent of
 * `TOutCtx` — the connection stamps it from the interface definition,
 * the base {@link JsonRpcChannel} ignores it, and signing decorators
 * bake it into the `$hubrpc` envelope.
 *
 * `ctx` is the sender's `TOutCtx`-typed override / extension bag for
 * per-call decorator overrides (e.g. `signerOverride`, `capsOverride`).
 * The base {@link JsonRpcChannel} ignores `ctx` entirely; decorators
 * like `SigningSender` interpret it.
 */
export interface SendOpts<TOutCtx = undefined> {
    readonly ctx?: TOutCtx;
    /** Interface schema hash for this call (interface-level metadata). */
    readonly interfaceHash?: string;
}

export interface StreamSendOpts<TOutCtx = undefined> extends SendOpts<TOutCtx> {
    readonly onStreamMessage?: (payload: JsonValue) => void;
}

/**
 * Convenience: the transport type a {@link JsonRpcChannel} expects.
 * Outbound is plain `JsonRpcMessage` — the base channel does not
 * attach context to outgoing wire messages.
 */
export type ChannelTransport<TInCtx = undefined> = IMessageTransport<MessageWithCtx<TInCtx>>;

/**
 * Type of incoming messages on the channel's transport. With
 * `TInCtx = undefined` (default) this is just `JsonRpcMessage`. With a
 * concrete `TInCtx`, the transport carries a `context` field alongside
 * the message — out-of-band, never sent over a wire, set by the
 * in-process producer.
 */
export type MessageWithCtx<TInCtx> = [TInCtx] extends [undefined] ? JsonRpcMessage :
    JsonRpcMessage & { context: TInCtx; };

export class RpcError extends Error {
    public readonly data?: JsonValue;
    public readonly hasData: boolean;

    constructor(
        message: string,
        public readonly code: number,
        data?: JsonValue,
        /** Whether this error was decoded from a peer response. */
        public readonly origin: 'local' | 'remote' | 'transport' = 'local',
        hasData = data !== undefined,
    ) {
        super(message);
        this.name = 'RpcError';
        this.hasData = hasData;
        if (hasData) this.data = data;
    }
}
