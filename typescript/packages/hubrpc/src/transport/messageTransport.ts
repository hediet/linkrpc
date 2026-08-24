import type { JsonRpcMessage } from '../protocol/jsonRpc';
import { IDisposable } from '../disposable';

export interface IMessageTransport<TIncoming = JsonRpcMessage, TOutgoing = JsonRpcMessage> {
    send(message: TOutgoing): void | Promise<void>;
    /**
     * Sets the listener for incoming messages. Setting `undefined` detaches.
     * The transport buffers messages received before a listener is attached
     * and delivers them the next tick when one is set.
     * Forgetting to set a listener will cause the queue to leak.
     */
    setListener(listener: ((message: TIncoming) => void) | undefined): void;
    dispose(): void;
}

export type MessageWithContext<TCtx> = JsonRpcMessage & { context: TCtx; };

export type MessageTransportWithContext<TCtx> = IMessageTransport<JsonRpcMessage, MessageWithContext<TCtx>>;

export interface LocalMessageContext {
    readonly inspection?: true;
}

const localMessageContextBrand = Symbol.for('@vscode/hubrpc.localMessageContext');

/** Attach branded local context without adding it to serialized JSON-RPC. */
export function setLocalMessageContext<TMessage extends JsonRpcMessage, TContext extends object>(
    message: TMessage,
    context: TContext,
): TMessage & { context: TContext; } {
    Object.defineProperties(message, {
        context: {
            configurable: true,
            enumerable: false,
            value: context,
        },
        [localMessageContextBrand]: {
            configurable: true,
            enumerable: false,
            value: true,
        },
    });
    return message as TMessage & { context: TContext; };
}

/** Read context attached locally by {@link setLocalMessageContext}. */
export function getLocalMessageContext<TContext extends object = LocalMessageContext>(
    message: JsonRpcMessage,
): TContext | undefined {
    const branded = message as JsonRpcMessage & { readonly context?: TContext; };
    return (message as unknown as Record<PropertyKey, unknown>)[localMessageContextBrand] === true
        ? branded.context
        : undefined;
}

export type MessageTransportDirection = 'send' | 'receive';
export type MessageTransportTrace = (
    direction: MessageTransportDirection,
    message: JsonRpcMessage,
) => void;

/**
 * Observe every message crossing a transport without changing its buffering or
 * lifecycle behavior.
 */
export function traceMessageTransport(
    transport: IMessageTransport,
    trace: MessageTransportTrace,
): IMessageTransport {
    return {
        send(message): void | Promise<void> {
            trace('send', message);
            return transport.send(message);
        },
        setListener(listener): void {
            transport.setListener(listener === undefined
                ? undefined
                : (message) => {
                    trace('receive', message);
                    listener(message);
                });
        },
        dispose(): void {
            transport.dispose();
        },
    };
}

/**
 * Pipe two transports together: every message one receives is forwarded to
 * the other's `send`. Returns a disposable that detaches both listeners.
 *
 * Neither transport is disposed — the caller owns their lifecycle. This is
 * the building block for relays (e.g. bridging a `WindowMessageTransport`
 * for an iframe to a multiplexer channel).
 */
export function connectTransports<T extends JsonRpcMessage>(
    a: IMessageTransport<T>,
    b: IMessageTransport<T>,
): IDisposable {
    a.setListener((m) => void b.send(m));
    b.setListener((m) => void a.send(m));
    return {
        dispose(): void {
            a.setListener(undefined);
            b.setListener(undefined);
        },
    };
}


/**
 * Two in-memory transports wired back-to-back. Useful for tests and for
 * same-process bridges.
 *
 * Generic in the per-direction payload type so asymmetric pairs (e.g. one
 * side sends plain `JsonRpcMessage`, the other side sends
 * `JsonRpcMessage & { context: Participant }`) are expressible at the type
 * level. At runtime both halves just hand objects through by reference.
 */
export class TransportPair<TFromA = JsonRpcMessage, TFromB = JsonRpcMessage> {
    public readonly a: IMessageTransport<TFromB, TFromA>;
    public readonly b: IMessageTransport<TFromA, TFromB>;

    constructor() {
        const aT = new _InMemoryTransport<TFromB, TFromA>();
        const bT = new _InMemoryTransport<TFromA, TFromB>();
        aT._peer = bT as unknown as _InMemoryTransport<TFromA, TFromB>;
        bT._peer = aT as unknown as _InMemoryTransport<TFromB, TFromA>;
        this.a = aT;
        this.b = bT;
    }
}

class _InMemoryTransport<TIn, TOut> implements IMessageTransport<TIn, TOut> {
    public _peer!: _InMemoryTransport<TOut, TIn>;
    private _listener: ((m: TIn) => void) | undefined;
    private readonly _buffer: TIn[] = [];
    private _closed = false;

    send(message: TOut): void {
        if (this._closed || this._peer._closed) return;
        // Deliver asynchronously to mimic a real transport — keeps tests honest
        // about ordering and prevents unintended sync reentrancy.
        this._peer._deliver(message);
    }

    setListener(listener: ((m: TIn) => void) | undefined): void {
        this._listener = listener;
        if (listener) {
            while (this._buffer.length > 0 && this._listener) {
                const m = this._buffer.shift()!;
                this._listener(m);
            }
        }
    }

    dispose(): void {
        this._closed = true;
    }

    _deliver(m: TIn): void {
        if (this._listener) this._listener(m);
        else this._buffer.push(m);
    }
}
