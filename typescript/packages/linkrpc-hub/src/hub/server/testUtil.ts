import type { IMessageTransport, JsonRpcMessage } from '@hediet/linkrpc';
import { TransportPair } from '@hediet/linkrpc';
import type { ITransportServer, Transport } from '@hediet/linkrpc/hub/common';

/** A {@link Transport} wrapping an in-memory link, with a real close signal. */
export class FakeTransport implements Transport {
    private readonly _closeHandlers: (() => void)[] = [];
    private _closed = false;

    constructor(private readonly _inner: IMessageTransport) {}

    public send(message: JsonRpcMessage): void | Promise<void> {
        return this._inner.send(message);
    }

    public setListener(listener: ((message: JsonRpcMessage) => void) | undefined): void {
        this._inner.setListener(listener);
    }

    public onDidClose(handler: () => void): void {
        if (this._closed) {
            queueMicrotask(handler);
            return;
        }
        this._closeHandlers.push(handler);
    }

    public dispose(): void {
        if (this._closed) return;
        this._closed = true;
        this._inner.dispose();
        for (const handler of this._closeHandlers) {
            handler();
        }
        this._closeHandlers.length = 0;
    }
}

/** A manually-driven {@link ITransportServer} for tests. */
export class FakeTransportServer<T extends Transport> implements ITransportServer<T> {
    private _handler: ((transport: T) => void) | undefined;
    public disposed = false;

    public setConnectionHandler(handler: (transport: T) => void): void {
        this._handler = handler;
    }

    public emit(transport: T): void {
        this._handler?.(transport);
    }

    public dispose(): void {
        this.disposed = true;
    }
}

/**
 * Make a back-to-back pair: a {@link FakeTransport} to feed into a server (the
 * "hub side") and the raw peer transport for the test to act as the client.
 */
export function fakeConnection(): { server: FakeTransport; peer: IMessageTransport; } {
    const pair = new TransportPair();
    return { server: new FakeTransport(pair.a), peer: pair.b };
}

export async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
}
