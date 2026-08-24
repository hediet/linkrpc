import {
    ErrorCode,
    isNotification,
    isRequest,
    isResponse,
    type JsonRpcError,
    type JsonRpcMessage,
    type JsonRpcNotification,
    type JsonRpcRequest,
    type JsonValue,
    type RequestId,
} from '../protocol/jsonRpc';
import {
    STREAM_METHOD,
    StreamControlType,
    StreamDir,
    type StreamSendParams,
} from './streaming';
import {
    Channel,
    type MessageWithCtx,
    type ChannelTransport,
    type IncomingStream,
    type IRequestHandler,
    type IRequestSender,
    type RawStreamingCall,
    type Result,
    RpcError,
    type SendOpts,
    type StreamSendOpts,
    type WireMessageObserver,
    isInspectionCall,
} from './channel';
import {
    getLocalMessageContext,
    type LocalMessageContext,
    setLocalMessageContext,
} from '../transport/messageTransport';

/**
 * How often a streaming-enabled call emits a `toCallee` keepalive ping so a
 * routing hub's per-request idle timer never reaps the in-flight request.
 * Must stay comfortably below the hub's idle timeout (default 30 min).
 */
const KEEPALIVE_PING_INTERVAL_MS = 10 * 60_000;

/**
 * Minimal JSON-RPC 2.0 channel: correlates requests with responses,
 * dispatches incoming requests/notifications to a handler.
 *
 * Construct via {@link JsonRpcChannel.create}: it returns a
 * {@link Channel} factory which materialises the live channel once a
 * handler is supplied via `.connect(handler)`. The handler is fixed for
 * the channel's lifetime — no setter, no mid-flight swap.
 *
 * The outbound `TOutCtx` of the produced sender is `unknown` — this
 * channel ignores per-call ctx entirely. Decorators (e.g.
 * `SigningSender`) lift it to a concrete shape.
 */
export class JsonRpcChannel<TInCtx = undefined> implements IRequestSender<unknown> {
    /**
     * Wrap a transport in a {@link Channel}. The channel's sender is live
     * immediately; call {@link Channel.setRequestHandler} (or pass the channel
     * to {@link LinkRpcConnection}) to bind the inbound handler.
     */
    public static create<TInCtx = undefined>(transport: ChannelTransport<TInCtx>): Channel<TInCtx, unknown> {
        return this.createWithClose(transport).channel;
    }

    /** Wrap a transport and retain an explicit lifecycle hook for its owner. */
    public static createWithClose<TInCtx = undefined>(
        transport: ChannelTransport<TInCtx>,
    ): { channel: Channel<TInCtx, unknown>; close: () => void; } {
        const jrc = new JsonRpcChannel<TInCtx>(transport);
        const channel = new Channel<TInCtx, unknown>(
            jrc,
            (h) => jrc.setRequestHandler(h),
            (observer, classifier) => jrc.setWireMessageObserver(observer, classifier),
        );
        return { channel, close: () => jrc.close() };
    }

    private _nextId = 1;
    private readonly _pending = new Map<string, {
        resolve: (v: JsonValue) => void;
        reject: (err: Error) => void;
    }>();
    /**
     * Per-request callbacks invoked when a {@link STREAM_METHOD}
     * notification arrives with a matching `requestId`. Used in both
     * directions: outgoing-request callers register here keyed by the
     * id they sent; per-call incoming-request stream handles register
     * keyed by the id they observed. Entries are removed when the
     * corresponding request completes (response received for outgoing,
     * response sent for incoming).
     */
    private readonly _streamListeners = new Map<string, (payload: JsonValue) => void>();

    /**
     * Per-incoming-request handlers for reserved `control` messages
     * (cancel / ping / pong) arriving as stream notifications. Keyed
     * by the id observed; removed when the request settles.
     */
    private readonly _streamControl = new Map<
        string,
        (control: { type: string; reason?: string; nonce?: string; }) => void
    >();
    private readonly _incomingAborts = new Map<string, AbortController>();

    private _handler: IRequestHandler<TInCtx> | undefined;
    private _wireObserver: WireMessageObserver | undefined;
    private _isInspectionMethod: ((method: string) => boolean) | undefined;
    private readonly _outboundInspectionRequests = new Set<string>();
    private readonly _inboundInspectionRequests = new Set<string>();
    private _closeError: Error | undefined;

    public setRequestHandler(handler: IRequestHandler<TInCtx> | undefined): void {
        this._handler = handler;
    }

    public setWireMessageObserver(
        observer: WireMessageObserver | undefined,
        isInspectionMethod: ((method: string) => boolean) | undefined,
    ): void {
        this._wireObserver = observer;
        this._isInspectionMethod = observer === undefined ? undefined : isInspectionMethod;
        if (observer === undefined) {
            this._outboundInspectionRequests.clear();
            this._inboundInspectionRequests.clear();
        }
    }

    private constructor(private readonly _transport: ChannelTransport<TInCtx>) {
        this._transport.setListener((m) => this._onMessage(m));
    }

    public async sendRequest(
        method: string,
        params: JsonValue | undefined,
        opts?: SendOpts<unknown>,
    ): Promise<JsonValue> {
        this._throwIfClosed();
        const id = this._nextId++;
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method };
        if (params !== undefined) req.params = params;
        const promise = new Promise<JsonValue>((resolve, reject) => {
            this._pending.set(String(id), { resolve, reject });
        });
        this._observeOutbound(req, opts);
        try {
            await this._transport.send(req);
        } catch (error) {
            this._pending.delete(String(id));
            this._observeSendFailure(id, error);
            throw error;
        }
        return promise;
    }

    public async sendNotification(
        method: string,
        params: JsonValue | undefined,
        opts?: SendOpts<unknown>,
    ): Promise<void> {
        this._throwIfClosed();
        const n: JsonRpcNotification = { jsonrpc: '2.0', method };
        if (params !== undefined) n.params = params;
        this._observeOutbound(n, opts);
        await this._transport.send(n);
    }

    public sendRequestWithStream(
        method: string,
        params: JsonValue | undefined,
        opts?: StreamSendOpts<unknown>,
    ): RawStreamingCall {
        this._throwIfClosed();
        const id = this._nextId++;
        const key = String(id);
        let resolveResult!: (v: JsonValue) => void;
        let rejectResult!: (err: Error) => void;
        const result = new Promise<JsonValue>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });
        this._pending.set(key, { resolve: resolveResult, reject: rejectResult });
        if (opts?.onStreamMessage) {
            this._streamListeners.set(key, opts.onStreamMessage);
        }
        // Symmetric ping/pong for this call. We emit controls `toCallee`,
        // so an inbound ping is answered with a `toCallee` pong.
        const pinger = this._makePinger(id, StreamDir.toCallee);
        this._streamControl.set(key, pinger.onControl);
        // Keepalive: a streaming-enabled call emits a periodic `toCallee`
        // ping so the hub's per-request idle timer never reaps it. Cleared
        // once the call settles (in either direction). Fire-and-forget: the
        // peer's pong (no matching nonce) is ignored.
        const ping = setInterval(() => {
            void this._sendStream(id, StreamDir.toCallee, {
                control: { type: StreamControlType.ping },
            });
        }, KEEPALIVE_PING_INTERVAL_MS);
        (ping as { unref?: () => void; }).unref?.();
        const stopPing = (): void => {
            clearInterval(ping);
            pinger.dispose();
            this._streamControl.delete(key);
        };
        const dispose = (reason = 'streaming request disposed'): void => {
            if (!this._pending.delete(key)) return;
            this._streamListeners.delete(key);
            stopPing();
            rejectResult(new RpcError(reason, ErrorCode.cancelled));
        };
        result.then(stopPing, stopPing);
        (async () => {
            const req: JsonRpcRequest = { jsonrpc: '2.0', id, method };
            if (params !== undefined) req.params = params;
            this._observeOutbound(req, opts);
            await this._transport.send(req);
        })().catch((err) => {
            // Send-time failure: clear bookkeeping and surface on result.
            this._pending.delete(key);
            this._streamListeners.delete(key);
            this._observeSendFailure(id, err);
            stopPing();
            rejectResult(err instanceof Error ? err : new Error(String(err)));
        });
        return {
            result,
            send: (payload) => this._sendStream(id, StreamDir.toCallee, { payload }),
            cancel: (reason) =>
                this._sendStream(id, StreamDir.toCallee, {
                    control: reason !== undefined ?
                        { type: StreamControlType.cancel, reason } :
                        { type: StreamControlType.cancel },
                }),
            dispose,
            ping: pinger.ping,
        };
    }

    /**
     * Build the symmetric ping/pong machinery for one in-flight request.
     *
     * `outboundDir` is the direction *this* side emits controls in
     * (`toCallee` for the caller, `toCaller` for the callee). A received
     * ping is answered with a pong in that same direction, echoing the
     * ping's nonce; a received pong resolves the matching outstanding
     * {@link ping} probe.
     */
    private _makePinger(requestId: RequestId, outboundDir: StreamDir): {
        ping: () => Promise<void>;
        onControl: (control: { type: string; nonce?: string; }) => void;
        dispose: () => void;
    } {
        const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; }>();
        let nextNonce = 1;
        const ping = (): Promise<void> => {
            const nonce = `${requestId}:${nextNonce++}`;
            const p = new Promise<void>((resolve, reject) => pending.set(nonce, { resolve, reject }));
            void this._sendStream(requestId, outboundDir, {
                control: { type: StreamControlType.ping, nonce },
            });
            return p;
        };
        const onControl = (control: { type: string; nonce?: string; }): void => {
            if (control.type === StreamControlType.ping) {
                // Auto-answer: echo the nonce back the way our controls travel.
                void this._sendStream(requestId, outboundDir, {
                    control: { type: StreamControlType.pong, nonce: control.nonce },
                });
            } else if (control.type === StreamControlType.pong && control.nonce !== undefined) {
                const waiter = pending.get(control.nonce);
                if (waiter) {
                    pending.delete(control.nonce);
                    waiter.resolve();
                }
            }
        };
        const dispose = (): void => {
            const err = new RpcError('Request settled before pong', ErrorCode.cancelled);
            for (const w of pending.values()) w.reject(err);
            pending.clear();
        };
        return { ping, onControl, dispose };
    }

    /**
     * Emit a stream notification ({@link STREAM_METHOD}) associated with
     * an in-flight request. Internal: outgoing-side callers reach this
     * via {@link RawStreamingCall.send} / `cancel`; incoming-side handlers
     * reach it via {@link IncomingStream.send}.
     */
    private async _sendStream(
        requestId: RequestId,
        dir: StreamDir,
        fields: {
            payload?: JsonValue;
            control?: { type: StreamControlType; reason?: string; nonce?: string; };
        },
    ): Promise<void> {
        this._throwIfClosed();
        const params: StreamSendParams = { requestId, dir, ...fields };
        const n: JsonRpcNotification = {
            jsonrpc: '2.0',
            method: STREAM_METHOD,
            params: params as unknown as JsonValue,
        };
        this._observeOutbound(n);
        await this._transport.send(n);
    }

    public close(): void {
        if (this._closeError) return;
        const error = new RpcError('Connection closed', ErrorCode.peerDisconnected);
        this._closeError = error;
        for (const abort of this._incomingAborts.values()) abort.abort(error);
        this._incomingAborts.clear();
        this._transport.dispose();
        for (const p of this._pending.values()) p.reject(error);
        this._pending.clear();
        this._streamListeners.clear();
        this._streamControl.clear();
    }

    private _throwIfClosed(): void {
        if (this._closeError) throw this._closeError;
    }

    private _onMessage(m: MessageWithCtx<TInCtx>): void {
        // `context` is present iff TInCtx ≠ undefined; the channel itself
        // doesn't care which case we're in and just forwards whatever the
        // transport delivered.
        const ctx = (m as { context?: TInCtx; }).context as TInCtx;
        this._observeInbound(m);
        if (isResponse(m)) {
            if (m.id === null) return;
            const key = String(m.id);
            const pending = this._pending.get(key);
            if (!pending) return;
            this._pending.delete(key);
            // Outgoing-request stream listener (if any) is scoped to the
            // request's lifetime; drop it when the response arrives.
            this._streamListeners.delete(key);
            if ('error' in m) {
                const e = m.error;
                const err = new RpcError(e.message, e.code, e.data);
                pending.reject(err);
            } else {
                pending.resolve(m.result);
            }
            return;
        }
        if (isRequest(m)) {
            void this._handleRequest(m, ctx).catch(() => {
                // A response can lose its transport after the request handler
                // has completed; there is no caller left to receive that error.
            });
            return;
        }
        if (isNotification(m)) {
            if (m.method === STREAM_METHOD) {
                this._handleStreamNotification(m);
                return;
            }
            this._handleNotification(m, ctx);
            return;
        }
    }

    private _handleStreamNotification(m: JsonRpcNotification): void {
        const params = m.params as StreamSendParams | undefined;
        if (!params) return;
        const requestId = params.requestId;
        if (requestId === undefined) return;
        const key = String(requestId);
        // Reserved control (cancel / ping): routed to the per-request
        // control handler, never to the app payload listener.
        if (params.control) {
            this._streamControl.get(key)?.(params.control);
            return;
        }
        const listener = this._streamListeners.get(key);
        if (!listener) return;
        listener(params.payload as JsonValue);
    }

    private async _handleRequest(m: JsonRpcRequest, context: TInCtx): Promise<void> {
        const key = String(m.id);
        // Symmetric ping/pong for this call. The handler emits controls
        // `toCaller`, so an inbound ping is answered with a `toCaller` pong.
        const pinger = this._makePinger(m.id, StreamDir.toCaller);
        const stream: IncomingStream = {
            send: (payload) => this._sendStream(m.id, StreamDir.toCaller, { payload }),
            onMessage: (listener) => {
                if (listener) this._streamListeners.set(key, listener);
                else this._streamListeners.delete(key);
            },
            ping: pinger.ping,
            markInspectionLifecycle: () => {
                if (this._wireObserver !== undefined) {
                    this._inboundInspectionRequests.add(key);
                }
            },
        };
        // A `toCallee` cancel control trips the handler's AbortSignal;
        // ping/pong are liveness only and handled by the pinger.
        const abort = new AbortController();
        this._incomingAborts.set(key, abort);
        this._streamControl.set(key, (control) => {
            if (control.type === StreamControlType.cancel) {
                abort.abort(new RpcError(control.reason ?? 'cancelled', ErrorCode.cancelled));
            } else {
                pinger.onControl(control);
            }
        });

        let result: Result;
        try {
            if (!this._handler) {
                result = {
                    error: {
                        code: ErrorCode.methodNotFound,
                        message: `No handler registered on this endpoint (method: ${m.method}).`,
                    },
                };
            } else {
                try {
                    result = await this._handler.handleRequest({
                        method: m.method,
                        params: m.params,
                        context,
                        stream,
                        signal: abort.signal,
                    });
                } catch (e) {
                    result = {
                        error: {
                            code: ErrorCode.internalError,
                            message: e instanceof Error ? e.message : String(e),
                        },
                    };
                }
            }
        } finally {
            // Auto-detach the inbound stream listener + control: the handler is done.
            this._streamListeners.delete(key);
            this._streamControl.delete(key);
            this._incomingAborts.delete(key);
            pinger.dispose();
        }
        if ('result' in result) {
            const response = {
                jsonrpc: '2.0',
                id: m.id,
                result: result.result,
            } as const;
            this._observeOutbound(response);
            await this._transport.send(response);
        } else {
            const resp: JsonRpcError = {
                jsonrpc: '2.0',
                id: m.id,
                error: result.error,
            };
            this._observeOutbound(resp);
            await this._transport.send(resp);
        }
    }

    private _handleNotification(m: JsonRpcNotification, context: TInCtx): void {
        if (!this._handler) return;
        try {
            this._handler.handleNotification({
                method: m.method,
                params: m.params,
                context,
                stream: _NOOP_STREAM,
                signal: _NEVER_ABORT,
            });
        } catch {
            // Notifications have no response; swallow exceptions to avoid
            // killing the transport.
        }
    }

    private _observeInbound(message: JsonRpcMessage): void {
        const observer = this._wireObserver;
        if (observer === undefined) return;

        let inspection = false;
        if (isRequest(message)) {
            inspection = this._isInspectionMethod?.(message.method) === true;
            if (inspection) this._inboundInspectionRequests.add(String(message.id));
        } else if (isResponse(message)) {
            if (message.id !== null) {
                const key = String(message.id);
                inspection = this._outboundInspectionRequests.delete(key);
            }
        } else if (message.method === STREAM_METHOD) {
            inspection = this._isInspectionStream(message);
        } else {
            inspection = this._isInspectionMethod?.(message.method) === true;
        }

        if (!inspection) observer('inbound', message);
    }

    private _observeOutbound(
        message: JsonRpcMessage,
        opts?: SendOpts<unknown>,
    ): void {
        if (isRequest(message) && isInspectionCall(opts)) {
            setLocalMessageContext(message, {
                ...getLocalMessageContext(message),
                inspection: true,
            } satisfies LocalMessageContext);
        }
        const observer = this._wireObserver;
        if (observer === undefined) return;

        let inspection = false;
        if (isRequest(message)) {
            inspection = isInspectionCall(opts);
            if (inspection) {
                this._outboundInspectionRequests.add(String(message.id));
            }
        } else if (isResponse(message)) {
            if (message.id !== null) {
                const key = String(message.id);
                inspection = this._inboundInspectionRequests.delete(key);
            }
        } else if (message.method === STREAM_METHOD) {
            inspection = this._isInspectionStream(message);
        } else {
            inspection = isInspectionCall(opts);
        }

        if (!inspection) observer('outbound', message);
    }

    private _observeSendFailure(requestId: RequestId, error: unknown): void {
        if (this._wireObserver === undefined) {
            this._outboundInspectionRequests.delete(String(requestId));
            return;
        }
        this._observeInbound({
            jsonrpc: '2.0',
            id: requestId,
            error: {
                code: ErrorCode.peerDisconnected,
                message: error instanceof Error ? error.message : String(error),
            },
        });
    }

    private _isInspectionStream(message: JsonRpcNotification): boolean {
        const params = message.params as StreamSendParams | undefined;
        if (params?.requestId === undefined) return false;
        const key = String(params.requestId);
        return this._outboundInspectionRequests.has(key)
            || this._inboundInspectionRequests.has(key);
    }
}

/** Stub stream handle for notifications, which carry no request id. */
const _NOOP_STREAM: IncomingStream = {
    send: () => Promise.resolve(),
    onMessage: () => { },
    ping: () => Promise.resolve(),
    markInspectionLifecycle: () => { },
};

/** A signal that never aborts — handed to notification handlers. */
const _NEVER_ABORT: AbortSignal = new AbortController().signal;
