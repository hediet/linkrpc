import {
    ErrorCode,
    type IncomingCall,
    type IRequestHandler,
    type JsonValue,
} from "@hediet/linkrpc";
import type { CliConnection } from "@hediet/linkrpc-client";
import type { StaticHubSchema } from "../staticHubSchema";
import { StaticHubReflection } from "./staticHubReflection";
import { createForwardingHandler } from "./tunnel";

export const BROKER_INTERFACE_ID = "hubrpc.connectionBroker";
export const BROKER_STATUS_METHOD = `${BROKER_INTERFACE_ID}::status`;
export const BROKER_READ_NOTIFICATIONS_METHOD = `${BROKER_INTERFACE_ID}::readNotifications`;
export const BROKER_DISCONNECT_METHOD = `${BROKER_INTERFACE_ID}::disconnect`;

export interface ConnectionBrokerOptions {
    readonly id: string;
    readonly remoteEndpoint: string;
    readonly mode: "linkrpc" | "raw";
    readonly startedAt: number;
    readonly timeoutMs: number;
    readonly ttlMs: number;
    readonly notificationLimit?: number;
    readonly now?: () => number;
    readonly onStop?: (reason: BrokerStopReason) => void;
    readonly staticHubSchema?: StaticHubSchema;
}

export type BrokerStopReason = "disconnect" | "timeout" | "ttl" | "disposed";

export interface BufferedNotification {
    readonly sequence: number;
    readonly receivedAt: number;
    readonly method: string;
    readonly params?: JsonValue;
}

interface NotificationReadResult {
    readonly notifications: readonly BufferedNotification[];
    readonly next: number;
    readonly droppedBefore: number;
}

interface NotificationWaiter {
    readonly after: number;
    readonly resolve: (result: NotificationReadResult) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly signal: AbortSignal;
    readonly onAbort: () => void;
}

export class ConnectionBroker {
    private readonly _now: () => number;
    private readonly _notificationLimit: number;
    private readonly _notifications: BufferedNotification[] = [];
    private readonly _waiters = new Set<NotificationWaiter>();
    private readonly _remoteForwarder: IRequestHandler;
    private readonly _staticReflection: StaticHubReflection | undefined;
    private readonly _startedAt: number;
    private _nextNotificationSequence = 1;
    private readonly _locals = new Set<CliConnection>();
    private _timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    private _ttlTimer: ReturnType<typeof setTimeout> | undefined;
    private _lastActivityAt: number;
    private _resolveStopped!: (reason: BrokerStopReason) => void;
    private _disposed = false;

    public readonly stopped = new Promise<BrokerStopReason>((resolve) => {
        this._resolveStopped = resolve;
    });
    public stoppedReason: BrokerStopReason | undefined;

    constructor(
        private readonly _remote: CliConnection,
        private readonly _options: ConnectionBrokerOptions,
    ) {
        this._now = _options.now ?? Date.now;
        this._notificationLimit = _options.notificationLimit ?? 1_000;
        this._startedAt = _options.startedAt;
        this._lastActivityAt = _options.startedAt;
        this._remoteForwarder = createForwardingHandler(_remote);
        this._staticReflection = _options.staticHubSchema === undefined
            ? undefined
            : new StaticHubReflection(_options.staticHubSchema);
        this._remote.setRequestHandler({
            handleRequest: (call) => this._handleRemoteRequest(call),
            handleNotification: (call) => this._bufferNotification(call),
        });
        this._resetTimeout();
        this._ttlTimer = setTimeout(
            () => this._stop("ttl"),
            Math.max(0, this._options.ttlMs - (this._now() - this._startedAt)),
        );
        this._ttlTimer.unref?.();
    }

    public attach(local: CliConnection): void {
        if (this._disposed) {
            throw new Error("connection broker is stopped");
        }
        this._locals.add(local);
        local.setRequestHandler({
            handleRequest: (call) => this._handleLocalRequest(call),
            handleNotification: (call) => this._handleLocalNotification(call),
        });
        this.recordActivity();
    }

    public detach(local: CliConnection): void {
        if (!this._locals.delete(local)) return;
        local.setRequestHandler(undefined);
    }

    public recordActivity(): void {
        if (this._disposed) return;
        this._lastActivityAt = this._now();
        this._resetTimeout();
    }

    public dispose(): void {
        this._stop("disposed");
    }

    private async _handleLocalRequest(call: IncomingCall) {
        this.recordActivity();
        switch (call.method) {
            case BROKER_STATUS_METHOD:
                return { result: this._status() as unknown as JsonValue };
            case BROKER_READ_NOTIFICATIONS_METHOD:
                return {
                    result: await this._readNotifications(call.params, call.signal) as unknown as JsonValue,
                };
            case BROKER_DISCONNECT_METHOD:
                setTimeout(() => this._stop("disconnect"), 0);
                return { result: { disconnected: true } };
            default:
                if (call.method.startsWith(`${BROKER_INTERFACE_ID}::`)) {
                    return {
                        error: {
                            code: ErrorCode.methodNotFound,
                            message: `Unknown connection broker method: ${call.method}`,
                        },
                    };
                }
                const reflected = this._staticReflection?.tryHandleRequest(call);
                if (reflected !== undefined) {
                    return reflected;
                }
                return this._remoteForwarder.handleRequest(call);
        }
    }

    private _handleLocalNotification(call: IncomingCall): void {
        this.recordActivity();
        if (call.method.startsWith(`${BROKER_INTERFACE_ID}::`)) {
            return;
        }
        this._remoteForwarder.handleNotification(call);
    }

    private _handleRemoteRequest(call: IncomingCall) {
        this.recordActivity();
        if (this._locals.size !== 1) {
            return Promise.resolve({
                error: {
                    code: ErrorCode.peerDisconnected,
                    message: this._locals.size === 0
                        ? "No local broker client is attached"
                        : "Cannot route a reverse request while multiple local broker clients are attached",
                },
            });
        }
        const local = this._locals.values().next().value!;
        return createForwardingHandler(local).handleRequest(call);
    }

    private _bufferNotification(call: IncomingCall): void {
        this.recordActivity();
        const notification: BufferedNotification = {
            sequence: this._nextNotificationSequence++,
            receivedAt: this._now(),
            method: call.method,
            ...(call.params === undefined ? {} : { params: call.params }),
        };
        this._notifications.push(notification);
        if (this._notifications.length > this._notificationLimit) {
            this._notifications.splice(0, this._notifications.length - this._notificationLimit);
        }
        this._settleReadyWaiters();
    }

    private _status(): JsonValue {
        return {
            id: this._options.id,
            mode: this._options.mode,
            remoteEndpoint: this._options.remoteEndpoint,
            startedAt: this._startedAt,
            lastActivityAt: this._lastActivityAt,
            timeoutMs: this._options.timeoutMs,
            ttlMs: this._options.ttlMs,
            notificationCount: this._notifications.length,
            nextNotificationSequence: this._nextNotificationSequence,
            localClientCount: this._locals.size,
        };
    }

    private _readNotifications(
        params: JsonValue | undefined,
        signal: AbortSignal,
    ): Promise<NotificationReadResult> {
        const parsed = parseReadParams(params);
        const immediate = this._collectNotifications(parsed.after);
        if (immediate.notifications.length > 0 || parsed.waitMs === 0) {
            return Promise.resolve(immediate);
        }
        return new Promise<NotificationReadResult>((resolve) => {
            const waiter: NotificationWaiter = {
                after: parsed.after,
                resolve,
                timer: setTimeout(() => this._settleWaiter(waiter), parsed.waitMs),
                signal,
                onAbort: () => this._settleWaiter(waiter),
            };
            waiter.timer.unref?.();
            signal.addEventListener("abort", waiter.onAbort, { once: true });
            this._waiters.add(waiter);
        });
    }

    private _collectNotifications(after: number): NotificationReadResult {
        const notifications = this._notifications.filter((item) => item.sequence > after);
        const next = notifications.at(-1)?.sequence ?? after;
        return {
            notifications,
            next,
            droppedBefore: this._notifications[0]?.sequence ?? this._nextNotificationSequence,
        };
    }

    private _settleReadyWaiters(): void {
        for (const waiter of [...this._waiters]) {
            if (this._notifications.some((item) => item.sequence > waiter.after)) {
                this._settleWaiter(waiter);
            }
        }
    }

    private _settleWaiter(waiter: NotificationWaiter): void {
        if (!this._waiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this._collectNotifications(waiter.after));
    }

    private _resetTimeout(): void {
        if (this._timeoutTimer !== undefined) {
            clearTimeout(this._timeoutTimer);
        }
        this._timeoutTimer = setTimeout(() => this._stop("timeout"), this._options.timeoutMs);
        this._timeoutTimer.unref?.();
    }

    private _stop(reason: BrokerStopReason): void {
        if (this._disposed) return;
        this._disposed = true;
        this.stoppedReason = reason;
        if (this._timeoutTimer !== undefined) clearTimeout(this._timeoutTimer);
        if (this._ttlTimer !== undefined) clearTimeout(this._ttlTimer);
        for (const waiter of [...this._waiters]) {
            this._settleWaiter(waiter);
        }
        for (const local of this._locals) {
            local.close();
        }
        this._locals.clear();
        this._remote.close();
        this._resolveStopped(reason);
        this._options.onStop?.(reason);
    }
}

function parseReadParams(params: JsonValue | undefined): { after: number; waitMs: number; } {
    if (params === undefined) return { after: 0, waitMs: 0 };
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw new Error("readNotifications params must be an object");
    }
    const after = "after" in params ? params.after : 0;
    const waitMs = "waitMs" in params ? params.waitMs : 0;
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
        throw new Error("readNotifications after must be a non-negative integer");
    }
    if (
        typeof waitMs !== "number"
        || !Number.isSafeInteger(waitMs)
        || waitMs < 0
        || waitMs > 30_000
    ) {
        throw new Error("readNotifications waitMs must be an integer between 0 and 30000");
    }
    return { after, waitMs };
}
