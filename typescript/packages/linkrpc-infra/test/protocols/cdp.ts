import type { JsonRpcMessage, JsonValue } from '@hediet/linkrpc';
import {
    assertJsonRpcMessage,
    type CloseAwareMessageTransport,
} from '../../src/json-rpc/messageTransport';
import type { Disposable } from '../../src/json-rpc/transport';

const OPEN_READY_STATE = 1;
const MAX_SESSION_BACKLOG = 1_024;

export interface CdpWebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: 'message' | 'close' | 'error', listener: EventListener): void;
    removeEventListener(type: 'message' | 'close' | 'error', listener: EventListener): void;
}

export interface CdpWebSocketTransport {
    /** The browser-level CDP session (frames without sessionId). */
    readonly root: CloseAwareMessageTransport<JsonRpcMessage, JsonRpcMessage>;
    /** A flattened Target session. The same id returns the same live transport. */
    session(sessionId: string): CloseAwareMessageTransport<JsonRpcMessage, JsonRpcMessage>;
    readonly closed: boolean;
    readonly closeReason: string | undefined;
    onClose(listener: (reason?: string) => void): Disposable;
    close(reason?: string): void;
}

/**
 * Adapt Chrome DevTools Protocol WebSocket object frames to JSON-RPC 2.0.
 * LinkRPC metadata and initialization are never injected.
 *
 * Session and manager `onClose` hooks can be connected to the `close` returned
 * by JsonRpcChannel.createWithClose so in-flight requests reject on peer loss.
 */
export function createCdpWebSocketTransport(socket: CdpWebSocketLike): CdpWebSocketTransport {
    const sessions = new Map<string | undefined, SessionTransport>();
    const closeListeners = new Set<(reason?: string) => void>();
    const requests = new Map<number, {
        readonly sessionId: string | undefined;
        readonly originalId: string | number;
    }>();
    let nextWireId = 1;
    let closed = false;
    let closeReason: string | undefined;
    let receiveQueue = Promise.resolve();

    const deleteSessionRequests = (sessionId: string | undefined): void => {
        for (const [wireId, request] of requests) {
            if (request.sessionId === sessionId) requests.delete(wireId);
        }
    };

    const disposeSession = (
        sessionId: string | undefined,
        session: SessionTransport,
    ): void => {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        deleteSessionRequests(sessionId);
    };

    const getSession = (sessionId: string | undefined): SessionTransport => {
        if (closed) throw new Error(closeReason ?? 'CDP WebSocket transport is closed');
        let result = sessions.get(sessionId);
        if (!result) {
            result = new SessionTransport(
                (message) => send(sessionId, message),
                () => disposeSession(sessionId, result!),
                (reason) => terminate(reason),
            );
            sessions.set(sessionId, result);
        }
        return result;
    };

    const allocateWireId = (): number => {
        if (!Number.isSafeInteger(nextWireId)) {
            throw new Error('CDP wire request id space exhausted');
        }
        return nextWireId++;
    };

    const send = (sessionId: string | undefined, message: JsonRpcMessage): void => {
        if (closed) throw new Error(closeReason ?? 'CDP WebSocket transport is closed');
        if (socket.readyState !== OPEN_READY_STATE) throw new Error('CDP WebSocket is not open');
        assertJsonRpcMessage(message as unknown as JsonValue);
        const frame = { ...(message as unknown as Record<string, JsonValue>) };
        delete frame.jsonrpc;
        if (sessionId !== undefined) frame.sessionId = sessionId;
        let wireId: number | undefined;
        if ('method' in frame && 'id' in frame) {
            wireId = allocateWireId();
            requests.set(wireId, { sessionId, originalId: frame.id as string | number });
            frame.id = wireId;
        }
        try {
            socket.send(JSON.stringify(frame));
        } catch (error) {
            if (wireId !== undefined) requests.delete(wireId);
            throw error;
        }
    };

    const detachSocketListeners = (): void => {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onClose);
        socket.removeEventListener('error', onError);
    };

    const finish = (reason: string, closeSocket: boolean): void => {
        if (closed) return;
        closed = true;
        closeReason = reason;
        detachSocketListeners();
        requests.clear();
        for (const session of [...sessions.values()]) session.remoteClose(reason);
        sessions.clear();
        for (const listener of closeListeners) listener(reason);
        closeListeners.clear();
        if (closeSocket) socket.close();
    };

    function terminate(reason: string): void {
        finish(reason, true);
    }

    const receiveText = (text: string): void => {
        if (closed) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            terminate(`Invalid CDP JSON frame: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        if (!isRecord(parsed)) {
            terminate('Invalid CDP frame: expected an object');
            return;
        }
        const frame = { ...parsed } as Record<string, JsonValue>;
        const rawSessionId = frame.sessionId;
        if (rawSessionId !== undefined && typeof rawSessionId !== 'string') {
            terminate('Invalid CDP frame: sessionId must be a string');
            return;
        }
        delete frame.sessionId;
        frame.jsonrpc = '2.0';

        let targetSession = rawSessionId as string | undefined;
        if (!('method' in frame)) {
            if (typeof frame.id !== 'number' || !Number.isSafeInteger(frame.id) || frame.id < 1) {
                terminate('Invalid CDP response: unknown request id');
                return;
            }
            const pending = requests.get(frame.id);
            if (!pending) {
                // A disposed session or failed send can still have a reply in flight.
                if (frame.id < nextWireId) return;
                terminate(`Invalid CDP response: unknown request id ${String(frame.id)}`);
                return;
            }
            requests.delete(frame.id);
            if (targetSession !== undefined && targetSession !== pending.sessionId) {
                terminate('Invalid CDP response: sessionId does not match request');
                return;
            }
            targetSession = pending.sessionId;
            frame.id = pending.originalId;
        }
        try {
            getSession(targetSession).deliver(assertJsonRpcMessage(frame as JsonValue));
        } catch (error) {
            terminate(error instanceof Error ? error.message : String(error));
        }
    };

    const onMessage: EventListener = (event): void => {
        receiveQueue = receiveQueue.then(async () => {
            const data = getEventData(event);
            if (typeof data === 'string') receiveText(data);
            else if (data instanceof ArrayBuffer) receiveText(new TextDecoder().decode(data));
            else if (ArrayBuffer.isView(data)) receiveText(new TextDecoder().decode(data));
            else if (typeof Blob !== 'undefined' && data instanceof Blob) receiveText(await data.text());
            else terminate('Invalid CDP WebSocket frame: expected text');
        }).catch((error) => terminate(`Invalid CDP WebSocket frame: ${String(error)}`));
    };
    const onClose: EventListener = (): void => finish('CDP WebSocket closed', false);
    const onError: EventListener = (event): void => {
        const message = getEventMessage(event);
        terminate(message ? `CDP WebSocket error: ${message}` : 'CDP WebSocket error');
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);

    const root = getSession(undefined);
    return {
        root,
        session(sessionId): CloseAwareMessageTransport<JsonRpcMessage, JsonRpcMessage> {
            if (!sessionId) throw new Error('CDP sessionId must not be empty');
            return getSession(sessionId);
        },
        get closed(): boolean { return closed; },
        get closeReason(): string | undefined { return closeReason; },
        onClose(listener): Disposable {
            if (closed) return notifyClosed(listener, closeReason);
            closeListeners.add(listener);
            return { dispose: () => closeListeners.delete(listener) };
        },
        close(reason): void {
            finish(reason ?? 'CDP WebSocket transport closed', true);
        },
    };
}

class SessionTransport implements CloseAwareMessageTransport<JsonRpcMessage, JsonRpcMessage> {
    private listener: ((message: JsonRpcMessage) => void) | undefined;
    private readonly backlog: JsonRpcMessage[] = [];
    private readonly closeListeners = new Set<(reason?: string) => void>();
    private closedValue = false;
    private closeReasonValue: string | undefined;

    public constructor(
        private readonly sendMessage: (message: JsonRpcMessage) => void,
        private readonly onDispose: () => void,
        private readonly onBacklogOverflow: (reason: string) => void,
    ) {}

    public get closed(): boolean { return this.closedValue; }
    public get closeReason(): string | undefined { return this.closeReasonValue; }

    public send(message: JsonRpcMessage): void {
        if (this.closedValue) throw new Error(this.closeReasonValue ?? 'CDP session transport is closed');
        this.sendMessage(message);
    }

    public setListener(listener: ((message: JsonRpcMessage) => void) | undefined): void {
        this.listener = listener;
        while (this.listener && this.backlog.length > 0) this.listener(this.backlog.shift()!);
    }

    public onClose(listener: (reason?: string) => void): Disposable {
        if (this.closedValue) return notifyClosed(listener, this.closeReasonValue);
        this.closeListeners.add(listener);
        return { dispose: () => this.closeListeners.delete(listener) };
    }

    public dispose(): void {
        if (this.closedValue) return;
        this.finish('CDP session transport disposed');
        this.onDispose();
    }

    public deliver(message: JsonRpcMessage): void {
        if (this.closedValue) return;
        if (this.listener) {
            this.listener(message);
            return;
        }
        if (this.backlog.length >= MAX_SESSION_BACKLOG) {
            this.onBacklogOverflow(`CDP session message backlog exceeded ${MAX_SESSION_BACKLOG}`);
            return;
        }
        this.backlog.push(message);
    }

    public remoteClose(reason: string): void {
        this.finish(reason);
    }

    private finish(reason: string): void {
        if (this.closedValue) return;
        this.closedValue = true;
        this.closeReasonValue = reason;
        this.listener = undefined;
        this.backlog.length = 0;
        for (const listener of this.closeListeners) listener(reason);
        this.closeListeners.clear();
    }
}

function notifyClosed(
    listener: (reason?: string) => void,
    reason: string | undefined,
): Disposable {
    let disposed = false;
    queueMicrotask(() => { if (!disposed) listener(reason); });
    return { dispose: () => { disposed = true; } };
}

function getEventData(event: Event): unknown {
    return 'data' in event ? (event as Event & { readonly data: unknown }).data : undefined;
}

function getEventMessage(event: Event): string | undefined {
    return 'message' in event && typeof (event as Event & { readonly message: unknown }).message === 'string'
        ? (event as Event & { readonly message: string }).message
        : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
