export { WebSocketTransport } from '../transport/webSocketTransport';
import { openWebSocket as openNativeWebSocket } from '../transport/webSocketTransport';

export interface OpenWebSocketOptions {
    readonly headers?: Record<string, string>;
}

/** Node-only header extension. The web entry exposes the standard overload. */
export function openWebSocket(url: string, opts: OpenWebSocketOptions = {}): Promise<WebSocket> {
    if (!opts.headers || Object.keys(opts.headers).length === 0) return openNativeWebSocket(url);
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { headers: opts.headers } as unknown as string[]);
        const onOpen = () => {
            ws.removeEventListener('error', onError);
            resolve(ws);
        };
        const onError = () => {
            ws.removeEventListener('open', onOpen);
            reject(new Error('WebSocket connection failed'));
        };
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
    });
}
