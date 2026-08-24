import type { JsonRpcMessage } from '../protocol/jsonRpc';
import { describe, expect, it } from 'vitest';
import {
    type MessageEndpoint,
    type MessageLikeEvent,
    WindowMessageTransport,
} from './windowMessageTransport';

const notification: JsonRpcMessage = { jsonrpc: '2.0', method: 'test' };

describe('WindowMessageTransport', () => {
    it('exchanges JSON-RPC directly with legacy window-message clients', () => {
        const hostWindow = new FakeWindow();
        const appWindow = new FakeWindow();
        hostWindow.connectTo(appWindow);
        appWindow.connectTo(hostWindow);
        const host = new WindowMessageTransport(hostWindow, appWindow);
        const app = new WindowMessageTransport(appWindow, hostWindow);
        const atHost: JsonRpcMessage[] = [];
        const atApp: JsonRpcMessage[] = [];
        host.setListener((message) => atHost.push(message));
        app.setListener((message) => atApp.push(message));

        host.send(notification);
        app.send(notification);

        expect(atHost).toEqual([notification]);
        expect(atApp).toEqual([notification]);
        expect(hostWindow.postedOrigins).toEqual(['*']);
        expect(appWindow.postedOrigins).toEqual(['*']);
    });

    it('ignores JSON-RPC messages from other windows', () => {
        const hostWindow = new FakeWindow();
        const appWindow = new FakeWindow();
        const unrelatedWindow = new FakeWindow();
        const host = new WindowMessageTransport(hostWindow, appWindow);
        const received: JsonRpcMessage[] = [];
        host.setListener((message) => received.push(message));

        hostWindow.dispatch({ data: notification, source: unrelatedWindow });

        expect(received).toEqual([]);
    });
});

class FakeWindow implements MessageEndpoint {
    public readonly postedOrigins: string[] = [];
    private readonly _listeners = new Set<(event: MessageLikeEvent) => void>();
    private _peer: FakeWindow | undefined;

    connectTo(peer: FakeWindow): void {
        this._peer = peer;
    }

    postMessage(message: unknown, targetOrigin = '/'): void {
        this.postedOrigins.push(targetOrigin);
        this.dispatch({ data: message, source: this._peer });
    }

    addEventListener(_type: 'message', listener: (event: MessageLikeEvent) => void): void {
        this._listeners.add(listener);
    }

    removeEventListener(_type: 'message', listener: (event: MessageLikeEvent) => void): void {
        this._listeners.delete(listener);
    }

    dispatch(event: MessageLikeEvent): void {
        for (const listener of this._listeners) listener(event);
    }
}
