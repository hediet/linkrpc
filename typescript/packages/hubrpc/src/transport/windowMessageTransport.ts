import type { JsonRpcMessage } from '../protocol/jsonRpc';
import type { IMessageTransport } from './messageTransport';

/**
 * Minimal shape of `window` we need. Kept as a structural type so this module
 * works in any environment that provides postMessage / message events.
 */
export interface MessageEndpoint {
    postMessage(message: unknown, targetOrigin?: string): void;
    addEventListener(type: 'message', listener: (event: MessageLikeEvent) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageLikeEvent) => void): void;
}

export interface MessageLikeEvent {
    data: unknown;
    source?: unknown;
}

/**
 * IMessageTransport for two `window`-like endpoints exchanging JSON-RPC
 * messages via `postMessage`. Outgoing messages go to `their`; incoming
 * `message` events are filtered to those whose `source` is `their`.
 *
 * Typical pairings:
 *   - Editor in iframe: `new WindowMessageTransport(window, window.parent)`
 *   - Host wrapping an iframe: `new WindowMessageTransport(window, iframe.contentWindow)`
 */
export class WindowMessageTransport implements IMessageTransport {
    private _listener: ((m: JsonRpcMessage) => void) | undefined;
    private readonly _buffer: JsonRpcMessage[] = [];
    private _closed = false;
    private readonly _handler = (event: MessageLikeEvent): void => {
        if (this._filterSource && event.source !== this._their) return;
        const data = event.data;
        if (!isJsonRpcMessage(data)) return;
        if (this._listener) this._listener(data);
        else this._buffer.push(data);
    };

    constructor(
        private readonly _our: MessageEndpoint,
        private readonly _their: MessageEndpoint,
        private readonly _filterSource = true,
    ) {
        if (_our === _their) throw new Error('WindowMessageTransport: cannot connect to self');
        _our.addEventListener('message', this._handler);
    }

    send(message: JsonRpcMessage): void {
        if (this._closed) return;
        this._their.postMessage(message, '*');
    }

    setListener(listener: ((message: JsonRpcMessage) => void) | undefined): void {
        this._listener = listener;
        if (listener) {
            while (this._buffer.length > 0 && this._listener) {
                listener(this._buffer.shift()!);
            }
        }
    }

    dispose(): void {
        if (this._closed) return;
        this._closed = true;
        this._our.removeEventListener('message', this._handler);
    }
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { jsonrpc?: unknown; }).jsonrpc === '2.0'
    );
}
