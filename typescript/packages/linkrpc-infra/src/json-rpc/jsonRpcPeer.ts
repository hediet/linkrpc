import type { JsonValue } from '@hediet/linkrpc';
import type { Disposable, JsonRpcTransport } from "./transport";
import type { JsonRpcConnectionCloseReason } from './interface';

type JsonRpcId = string | number | null;

interface PendingRequest {
    resolve(value: JsonValue): void;
    reject(error: Error): void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

interface PendingReverseRequest {
    readonly id: JsonRpcId;
    readonly timer: ReturnType<typeof setTimeout>;
}

export interface JsonRpcErrorObject {
    readonly code: number;
    readonly message: string;
    readonly data?: JsonValue;
}

export class JsonRpcResponseError extends Error {
    public constructor(
        public readonly code: number,
        message: string,
        public readonly data?: JsonValue,
    ) {
        super(message);
        this.name = 'JsonRpcResponseError';
    }
}

export class JsonRpcConnectionClosedError extends Error {
    public constructor(public readonly reason: JsonRpcConnectionCloseReason) {
        super(`JSON-RPC connection closed: ${reason}`);
        this.name = 'JsonRpcConnectionClosedError';
    }
}

export type ReverseRequestPolicy = 'queue' | 'reject';

export type JsonRpcConnectionEvent =
    | {
        readonly type: 'notification';
        readonly sequence: number;
        readonly receivedAt: number;
        readonly method: string;
        readonly params?: JsonValue;
    }
    | {
        readonly type: 'request';
        readonly sequence: number;
        readonly receivedAt: number;
        readonly requestToken: string;
        readonly method: string;
        readonly params?: JsonValue;
        readonly autoRejectAt: number;
    };

export interface JsonRpcEventBatch {
    readonly events: JsonRpcConnectionEvent[];
    readonly next: number;
    readonly droppedBefore: number;
}

export interface JsonRpcPeerOptions {
    readonly reverseRequestPolicy?: ReverseRequestPolicy;
    readonly reverseRequestTimeoutMs?: number;
    readonly eventLimit?: number;
    readonly now?: () => number;
    readonly onActivity?: () => void;
}

interface EventWaiter {
    readonly after: number;
    readonly resolve: (batch: JsonRpcEventBatch) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly signal: AbortSignal;
    readonly onAbort: () => void;
}

export class JsonRpcPeer {
    private readonly _pending = new Map<string, PendingRequest>();
    private readonly _pendingReverse = new Map<string, PendingReverseRequest>();
    private readonly _events: JsonRpcConnectionEvent[] = [];
    private readonly _waiters = new Set<EventWaiter>();
    private readonly _subscriptions: Disposable[];
    private readonly _now: () => number;
    private readonly _reverseRequestPolicy: ReverseRequestPolicy;
    private readonly _reverseRequestTimeoutMs: number;
    private readonly _eventLimit: number;
    private _nextRequestId = 1;
    private _nextSequence = 1;
    private _closed = false;
    private _resolveClosed!: (reason: JsonRpcConnectionCloseReason) => void;

    public readonly closed = new Promise<JsonRpcConnectionCloseReason>((resolve) => {
        this._resolveClosed = resolve;
    });

    public constructor(
        private readonly _transport: JsonRpcTransport,
        private readonly _options: JsonRpcPeerOptions = {},
    ) {
        this._now = _options.now ?? Date.now;
        this._reverseRequestPolicy = _options.reverseRequestPolicy ?? 'reject';
        this._reverseRequestTimeoutMs = _options.reverseRequestTimeoutMs ?? 30_000;
        this._eventLimit = _options.eventLimit ?? 1_000;
        this._subscriptions = [
            _transport.onMessage((frame) => this._handleFrame(frame)),
            _transport.onClose(() => this._finish('remoteClosed')),
        ];
    }

    public get reverseRequestPolicy(): ReverseRequestPolicy {
        return this._reverseRequestPolicy;
    }

    public async request(method: string, params?: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
        this._requireOpen();
        const id = this._nextRequestId++;
        const key = idKey(id);
        const result = new Promise<JsonValue>((resolve, reject) => {
            const pending: PendingRequest = { resolve, reject, signal };
            this._pending.set(key, pending);
            if (signal !== undefined) {
                pending.onAbort = () => {
                    if (!this._pending.delete(key)) return;
                    reject(signal.reason instanceof Error ? signal.reason : new Error('JSON-RPC request cancelled'));
                };
                if (signal.aborted) {
                    pending.onAbort();
                    return;
                }
                signal.addEventListener('abort', pending.onAbort, { once: true });
            }
        });
        if (!this._pending.has(key)) return result;
        try {
            await this._send({
                jsonrpc: '2.0',
                id,
                method,
                ...(params === undefined ? {} : { params }),
            });
        } catch (error) {
            const pending = this._pending.get(key);
            if (pending !== undefined) {
                this._pending.delete(key);
                this._detachAbort(pending);
                pending.reject(asError(error));
            }
        }
        return result;
    }

    public async notify(method: string, params?: JsonValue): Promise<void> {
        this._requireOpen();
        await this._send({
            jsonrpc: '2.0',
            method,
            ...(params === undefined ? {} : { params }),
        });
    }

    public readEvents(after: number, waitMs: number, signal: AbortSignal): Promise<JsonRpcEventBatch> {
        const immediate = this._collectEvents(after);
        if (immediate.events.length > 0 || waitMs === 0 || this._closed || signal.aborted) {
            return Promise.resolve(immediate);
        }
        return new Promise<JsonRpcEventBatch>((resolve) => {
            const waiter: EventWaiter = {
                after,
                resolve,
                timer: setTimeout(() => this._settleWaiter(waiter), waitMs),
                signal,
                onAbort: () => this._settleWaiter(waiter),
            };
            waiter.timer.unref?.();
            signal.addEventListener('abort', waiter.onAbort, { once: true });
            this._waiters.add(waiter);
        });
    }

    public async respond(
        requestToken: string,
        response: { result: JsonValue; } | { error: JsonRpcErrorObject; },
    ): Promise<void> {
        this._requireOpen();
        const pending = this._pendingReverse.get(requestToken);
        if (pending === undefined) {
            throw new Error(`Unknown or expired JSON-RPC request token: ${requestToken}`);
        }
        this._pendingReverse.delete(requestToken);
        clearTimeout(pending.timer);
        if ('result' in response) {
            await this._send({
                jsonrpc: '2.0',
                id: pending.id,
                result: response.result,
            });
        } else {
            await this._send({
                jsonrpc: '2.0',
                id: pending.id,
                error: {
                    code: response.error.code,
                    message: response.error.message,
                    ...(response.error.data === undefined ? {} : { data: response.error.data }),
                },
            });
        }
    }

    public async close(reason: JsonRpcConnectionCloseReason = 'closed'): Promise<void> {
        if (this._closed) return;
        const reverse = [...this._pendingReverse.entries()];
        this._pendingReverse.clear();
        for (const [, pending] of reverse) clearTimeout(pending.timer);
        this._finish(reason);
        await Promise.allSettled(
            reverse.map(([, pending]) => this._sendError(pending.id, -32000, `JSON-RPC connection closing: ${reason}`)),
        );
        this._transport.close(reason);
    }

    private _handleFrame(frame: JsonValue): void {
        this._options.onActivity?.();
        if (!isRecord(frame) || frame.jsonrpc !== '2.0') return;

        if (typeof frame.method === 'string') {
            if ('id' in frame && isJsonRpcId(frame.id)) {
                this._handleReverseRequest(frame.id, frame.method, frame.params);
            } else {
                this._appendEvent({
                    type: 'notification',
                    sequence: this._nextSequence++,
                    receivedAt: this._now(),
                    method: frame.method,
                    ...('params' in frame ? { params: frame.params } : {}),
                });
            }
            return;
        }

        if (!('id' in frame) || !isJsonRpcId(frame.id)) return;
        const key = idKey(frame.id);
        const pending = this._pending.get(key);
        if (pending === undefined) return;
        this._pending.delete(key);
        this._detachAbort(pending);
        if ('error' in frame && isErrorObject(frame.error)) {
            pending.reject(new JsonRpcResponseError(frame.error.code, frame.error.message, frame.error.data));
            return;
        }
        if ('result' in frame) {
            pending.resolve(frame.result);
            return;
        }
        pending.reject(new Error('Malformed JSON-RPC response'));
    }

    private _handleReverseRequest(id: JsonRpcId, method: string, params: JsonValue | undefined): void {
        if (this._reverseRequestPolicy === 'reject') {
            this._sendErrorOrClose(id, -32601, `Unsupported server request: ${method}`);
            return;
        }
        const requestToken = globalThis.crypto.randomUUID();
        const autoRejectAt = this._now() + this._reverseRequestTimeoutMs;
        const timer = setTimeout(() => {
            if (!this._pendingReverse.delete(requestToken)) return;
            this._sendErrorOrClose(id, -32001, `Server request timed out: ${method}`);
        }, this._reverseRequestTimeoutMs);
        timer.unref?.();
        this._pendingReverse.set(requestToken, { id, timer });
        this._appendEvent({
            type: 'request',
            sequence: this._nextSequence++,
            receivedAt: this._now(),
            requestToken,
            method,
            ...(params === undefined ? {} : { params }),
            autoRejectAt,
        });
    }

    private _appendEvent(event: JsonRpcConnectionEvent): void {
        this._events.push(event);
        while (this._events.length > this._eventLimit) {
            const dropped = this._events.shift();
            if (dropped?.type !== 'request') continue;
            const pending = this._pendingReverse.get(dropped.requestToken);
            if (pending === undefined) continue;
            this._pendingReverse.delete(dropped.requestToken);
            clearTimeout(pending.timer);
            this._sendErrorOrClose(pending.id, -32002, `Server request queue overflow: ${dropped.method}`);
        }
        for (const waiter of [...this._waiters]) {
            if (event.sequence > waiter.after) this._settleWaiter(waiter);
        }
    }

    private _collectEvents(after: number): JsonRpcEventBatch {
        const events = this._events.filter((event) => event.sequence > after);
        return {
            events,
            next: events.at(-1)?.sequence ?? after,
            droppedBefore: this._events[0]?.sequence ?? this._nextSequence,
        };
    }

    private _settleWaiter(waiter: EventWaiter): void {
        if (!this._waiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.resolve(this._collectEvents(waiter.after));
    }

    private _finish(reason: JsonRpcConnectionCloseReason): void {
        if (this._closed) return;
        this._closed = true;
        for (const subscription of this._subscriptions) subscription.dispose();
        for (const pending of this._pending.values()) {
            this._detachAbort(pending);
            pending.reject(new JsonRpcConnectionClosedError(reason));
        }
        this._pending.clear();
        for (const pending of this._pendingReverse.values()) clearTimeout(pending.timer);
        this._pendingReverse.clear();
        for (const waiter of [...this._waiters]) this._settleWaiter(waiter);
        this._resolveClosed(reason);
    }

    private _detachAbort(pending: PendingRequest): void {
        if (pending.signal !== undefined && pending.onAbort !== undefined) {
            pending.signal.removeEventListener('abort', pending.onAbort);
        }
    }

    private _requireOpen(): void {
        if (this._closed) throw new JsonRpcConnectionClosedError('closed');
    }

    private async _send(frame: JsonValue): Promise<void> {
        this._options.onActivity?.();
        await this._transport.send(frame);
    }

    private _sendError(id: JsonRpcId, code: number, message: string, data?: JsonValue): Promise<void> {
        return this._send({
            jsonrpc: '2.0',
            id,
            error: {
                code,
                message,
                ...(data === undefined ? {} : { data }),
            },
        });
    }

    private _sendErrorOrClose(id: JsonRpcId, code: number, message: string, data?: JsonValue): void {
        void this._sendError(id, code, message, data).catch(() => this._finish('remoteClosed'));
    }
}

function idKey(id: JsonRpcId): string {
    return `${typeof id}:${String(id)}`;
}

function isJsonRpcId(value: JsonValue | undefined): value is JsonRpcId {
    return value === null || typeof value === 'string' || typeof value === 'number';
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function isErrorObject(value: JsonValue | undefined): value is {
    code: number;
    message: string;
    data?: JsonValue;
} {
    return isRecord(value) && typeof value.code === 'number' && typeof value.message === 'string';
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
