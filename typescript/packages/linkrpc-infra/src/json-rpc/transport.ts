import type { JsonValue } from '@hediet/linkrpc';

export interface Disposable {
    dispose(): void;
}

/** A message-oriented transport carrying already parsed JSON-RPC frames. */
export interface JsonRpcTransport {
    readonly closed: boolean;
    send(frame: JsonValue): Promise<void>;
    onMessage(listener: (frame: JsonValue) => void): Disposable;
    onClose(listener: (reason?: string) => void): Disposable;
    close(reason?: string): void;
}

export function connectJsonRpcTransports(
    left: JsonRpcTransport,
    right: JsonRpcTransport,
): Disposable {
    let disposed = false;
    const subscriptions = [
        left.onMessage((frame) => {
            void right.send(frame).catch((error) => closeBoth(String(error)));
        }),
        right.onMessage((frame) => {
            void left.send(frame).catch((error) => closeBoth(String(error)));
        }),
        left.onClose((reason) => closeBoth(reason)),
        right.onClose((reason) => closeBoth(reason)),
    ];
    const closeBoth = (reason?: string): void => {
        if (disposed) return;
        disposed = true;
        for (const subscription of subscriptions) subscription.dispose();
        left.close(reason);
        right.close(reason);
    };
    return {
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const subscription of subscriptions) subscription.dispose();
        },
    };
}

export class JsonRpcTransportPair {
    public readonly a: JsonRpcTransport;
    public readonly b: JsonRpcTransport;

    public constructor() {
        const a = new InMemoryJsonRpcTransport();
        const b = new InMemoryJsonRpcTransport();
        a.peer = b;
        b.peer = a;
        this.a = a;
        this.b = b;
    }
}

class InMemoryJsonRpcTransport implements JsonRpcTransport {
    public peer!: InMemoryJsonRpcTransport;
    private readonly _messageListeners = new Set<(frame: JsonValue) => void>();
    private readonly _closeListeners = new Set<(reason?: string) => void>();
    private readonly _backlog: JsonValue[] = [];
    private _closed = false;
    private _closeReason: string | undefined;

    public send(frame: JsonValue): Promise<void> {
        if (this._closed || this.peer._closed) {
            return Promise.reject(new Error('JSON-RPC transport is closed'));
        }
        queueMicrotask(() => this.peer._deliver(structuredClone(frame)));
        return Promise.resolve();
    }

    public get closed(): boolean {
        return this._closed;
    }

    public onMessage(listener: (frame: JsonValue) => void): Disposable {
        this._messageListeners.add(listener);
        for (const frame of this._backlog.splice(0)) listener(frame);
        return { dispose: () => this._messageListeners.delete(listener) };
    }

    public onClose(listener: (reason?: string) => void): Disposable {
        if (this._closed) {
            let disposed = false;
            queueMicrotask(() => {
                if (!disposed) listener(this._closeReason);
            });
            return { dispose: () => { disposed = true; } };
        }
        this._closeListeners.add(listener);
        return { dispose: () => this._closeListeners.delete(listener) };
    }

    public close(reason?: string): void {
        if (this._closed) return;
        this._closed = true;
        this._closeReason = reason;
        for (const listener of this._closeListeners) listener(reason);
        this.peer._remoteClosed(reason);
    }

    private _deliver(frame: JsonValue): void {
        if (this._closed) return;
        if (this._messageListeners.size === 0) {
            this._backlog.push(frame);
            return;
        }
        for (const listener of this._messageListeners) listener(frame);
    }

    private _remoteClosed(reason?: string): void {
        if (this._closed) return;
        this._closed = true;
        this._closeReason = reason;
        for (const listener of this._closeListeners) listener(reason);
    }
}
