import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { JsonValue } from '../protocol/jsonRpc';
import type { HttpHandleOptions } from '../http/server';

/** Shape added by Express/Connect; plain Node requests have none of these. */
interface MiddlewareRequest extends IncomingMessage {
    readonly originalUrl?: string;
    readonly body?: unknown;
}

/**
 * Mount a Web Request/Response handler on Node's HTTP server, or as Express/Connect
 * middleware. Routes are matched against the mount-relative `req.url`; a body already
 * consumed by e.g. `express.json()` is reused instead of re-reading the stream.
 */
export function httpRequestListener(
    handle: (request: Request, options: HttpHandleOptions) => Promise<Response>,
    onError: (error: unknown) => void = error => console.error('LinkRPC HTTP request failed', error),
): RequestListener {
    return (incoming, outgoing) => {
        void handleNodeRequest(incoming, outgoing, handle).catch(error => {
            if (incoming.aborted || outgoing.destroyed) return;
            onError(error);
            if (!outgoing.headersSent) {
                outgoing.writeHead(500, { 'Content-Type': 'text/plain' });
                outgoing.end('Internal server error');
            } else outgoing.destroy();
        });
    };
}

async function handleNodeRequest(
    incoming: MiddlewareRequest, outgoing: ServerResponse,
    handle: (request: Request, options: HttpHandleOptions) => Promise<Response>,
): Promise<void> {
    const abort = new AbortController();
    const onClose = () => {
        if (!outgoing.writableFinished) abort.abort(new Error('HTTP client disconnected'));
    };
    incoming.once('aborted', onClose);
    outgoing.once('close', onClose);
    try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            else if (value !== undefined) headers.set(name, value);
        }
        const init: RequestInit & { duplex: 'half' } = {
            method: incoming.method, headers, signal: abort.signal, duplex: 'half',
        };
        let parsedBody: JsonValue | undefined;
        if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
            if (!incoming.readableEnded) {
                init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
            } else if (incoming.body instanceof Uint8Array) {
                init.body = new Uint8Array(incoming.body);
            } else if (incoming.body !== undefined) {
                // body-parser reports an empty body as `{}`; keep "no params" distinct from `{}`.
                if (incoming.headers['content-length'] !== '0') parsedBody = incoming.body as JsonValue;
            } else if (incoming.headers['content-length'] !== '0') {
                throw new Error('Request body was consumed by earlier middleware without exposing req.body');
            }
        }
        const base = `http://${incoming.headers.host ?? 'localhost'}`;
        const request = new Request(new URL(incoming.originalUrl ?? incoming.url ?? '/', base), init);
        const response = await handle(request, { path: new URL(incoming.url ?? '/', base).pathname, parsedBody });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.flushHeaders();
        if (response.body) {
            await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), outgoing);
        } else outgoing.end();
    } finally {
        incoming.removeListener('aborted', onClose);
        outgoing.removeListener('close', onClose);
    }
}
