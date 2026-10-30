import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { JsonValue } from '@hediet/linkrpc';
import { parseEndpointUri } from '@hediet/linkrpc/node';
import type { JsonRpcTransport } from './transport';

const maxFrameBytes = 100 * 1024 * 1024;

/**
 * WebSocket close codes. Clients get the reason instead of a bare 1006 when a
 * route cannot be opened or its upstream fails.
 */
const closeCodes = { normal: 1000, goingAway: 1001, internalError: 1011 } as const;

export interface JsonRpcExportRoute {
    readonly serviceId: string;
    readonly path: string;
}

export interface JsonRpcWebSocketExportOptions {
    readonly targetEndpoint: string;
    readonly token?: string;
    /** Accepted query parameter names; defaults to tkn and token. Bearer headers are always accepted. */
    readonly tokenQueryParameters?: readonly string[];
    readonly routes: readonly JsonRpcExportRoute[];
    readonly openTransport: (serviceId: string, signal: AbortSignal) => Promise<JsonRpcTransport>;
    /** Connection failures. Must not throw. */
    readonly onError: (error: Error) => void;
}

export interface JsonRpcWebSocketExport {
    /** Bound base URL, without credentials. */
    readonly endpoint: string;
    close(): Promise<void>;
}

/** Validate before opening the source Hub connection or binding a listener. */
export function validateJsonRpcExport(options: Pick<JsonRpcWebSocketExportOptions, 'targetEndpoint' | 'token' | 'tokenQueryParameters' | 'routes'>): {
    readonly url: URL;
    readonly token: string;
    readonly tokenQueryParameters: readonly string[];
} {
    if (!options.targetEndpoint.startsWith('listen:')) {
        throw new Error('JSON-RPC export requires a listen:ws:// target endpoint.');
    }
    let target: ReturnType<typeof parseEndpointUri>;
    try {
        target = parseEndpointUri(options.targetEndpoint.slice('listen:'.length));
    } catch {
        throw new Error('Invalid JSON-RPC export target endpoint.');
    }
    if (target.kind !== 'ws') throw new Error('JSON-RPC export currently supports WebSocket listeners only.');
    const url = new URL(target.url);
    if (url.protocol !== 'ws:') throw new Error('Terminate TLS outside the export listener; use listen:ws://.');
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
        throw new Error('The target endpoint must be a base URL; specify routes with --path.');
    }
    const token = options.token ?? target.token;
    if (!token) throw new Error('JSON-RPC export requires --target-token or a token in the target endpoint.');
    const tokenQueryParameters = options.tokenQueryParameters ?? ['tkn', 'token'];
    if (tokenQueryParameters.some(name => !/^[A-Za-z0-9_.~-]+$/.test(name))
        || new Set(tokenQueryParameters).size !== tokenQueryParameters.length) {
        throw new Error('Token query parameter names must be nonempty, unique URL-safe names.');
    }
    if (!options.routes.length) throw new Error('Specify at least one --serviceId / --path pair.');
    const paths = new Set<string>();
    for (const route of options.routes) {
        if (!route.serviceId.trim()) throw new Error('Service IDs must not be empty.');
        if (!/^\/[A-Za-z0-9._~/-]*$/.test(route.path)
            || route.path.split('/').some(part => part === '.' || part === '..')) {
            throw new Error(`Invalid export path '${route.path}'; use an absolute URL path without query or fragment.`);
        }
        if (paths.has(route.path)) throw new Error(`Duplicate export path '${route.path}'.`);
        paths.add(route.path);
    }
    return { url, token, tokenQueryParameters };
}

/**
 * Serve independent raw JSON-RPC connections over one authenticated WebSocket listener.
 * Like personal-bot's JSON-RPC gateway, routes select a transport factory, not a shared session.
 */
export async function startJsonRpcWebSocketExport(options: JsonRpcWebSocketExportOptions): Promise<JsonRpcWebSocketExport> {
    const { url, token, tokenQueryParameters } = validateJsonRpcExport(options);
    const routes = new Map(options.routes.map(route => [route.path, route.serviceId]));
    const server = createServer((_request, response) => {
        response.writeHead(404);
        response.end();
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });
    const connections = new Set<Socket>();
    const closers = new Set<() => void>();
    let closing = false;
    server.on('connection', socket => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
        if (closing) socket.destroy();
    });
    server.on('clientError', (error, socket) => {
        options.onError(error);
        socket.destroy();
    });
    server.on('upgrade', (request, socket, head) => {
        const reject = (status: string): void => {
            socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        };
        let requestUrl: URL;
        try {
            requestUrl = new URL(request.url ?? '/', 'http://localhost');
        } catch {
            return reject('400 Bad Request');
        }
        const serviceId = routes.get(requestUrl.pathname);
        if (!serviceId) return reject('404 Not Found');
        const credentials = tokenQueryParameters.flatMap(name => requestUrl.searchParams.getAll(name));
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
            if (request.rawHeaders[index].toLowerCase() !== 'authorization') continue;
            const bearer = /^Bearer +(\S+)$/i.exec(request.rawHeaders[index + 1]);
            if (!bearer) return reject('401 Unauthorized');
            credentials.push(bearer[1]);
        }
        if (credentials.length !== 1) return reject('401 Unauthorized');
        const supplied = credentials[0];
        const expectedBytes = Buffer.from(token);
        const suppliedBytes = Buffer.from(supplied);
        if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
            return reject('401 Unauthorized');
        }
        if (closing || closers.size >= 100) return reject('503 Service Unavailable');
        sockets.handleUpgrade(request, socket, head, ws => {
            const close = attach(ws, serviceId, options, () => closers.delete(close));
            closers.add(close);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, ''), () => {
            server.off('error', reject);
            resolve();
        });
    }).catch(error => {
        sockets.close();
        throw error;
    });
    server.on('error', options.onError);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket listener has no TCP address.');
    url.port = String(address.port);
    let closed: Promise<void> | undefined;
    return {
        endpoint: url.toString(),
        close(): Promise<void> {
            if (closed) return closed;
            closing = true;
            for (const close of [...closers]) close();
            sockets.close();
            closed = new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
                for (const socket of connections) socket.destroy();
            });
            return closed;
        },
    };
}

function attach(
    socket: WebSocket,
    serviceId: string,
    options: JsonRpcWebSocketExportOptions,
    onClose: () => void,
): () => void {
    const maxQueuedBytes = 2 * maxFrameBytes;
    let closed = false;
    let remote: JsonRpcTransport | undefined;
    let queuedBytes = 0;
    let queuedFrames = 0;
    let pending = Promise.resolve();
    const controller = new AbortController();
    const subscriptions: { dispose(): void }[] = [];
    const close = (code: number, reason: string): void => {
        if (closed) return;
        closed = true;
        controller.abort();
        clearTimeout(openTimeout);
        for (const subscription of subscriptions) subscription.dispose();
        remote?.close('WebSocket export connection closed');
        if (socket.readyState === WebSocket.OPEN) socket.close(code, _closeReason(reason));
        else socket.terminate();
        onClose();
    };
    const fail = (error: unknown): void => {
        if (closed) return;
        options.onError(new Error(`JSON-RPC export route '${serviceId}' failed`, { cause: error }));
        close(closeCodes.internalError, `route '${serviceId}' failed: ${error instanceof Error ? error.message : String(error)}`);
    };
    const openTimeout = setTimeout(() => fail(new Error('Transport factory timed out')), 30_000);
    const opened = Promise.resolve().then(() => options.openTransport(serviceId, controller.signal));
    const register = (subscription: { dispose(): void }): void => {
        if (closed) subscription.dispose();
        else subscriptions.push(subscription);
    };
    void opened.then(transport => {
        clearTimeout(openTimeout);
        remote = transport;
        if (closed) {
            transport.close('WebSocket client disconnected before transport opened');
            return;
        }
        register(transport.onClose(reason => {
            if (reason && !closed) options.onError(new Error(`JSON-RPC export route '${serviceId}' closed upstream`));
            if (reason) close(closeCodes.internalError, `route '${serviceId}' closed upstream: ${reason}`);
            else close(closeCodes.normal, '');
        }));
        register(transport.onMessage(frame => {
            if (closed) return;
            const text = JSON.stringify(frame);
            if (Buffer.byteLength(text) > maxFrameBytes || socket.bufferedAmount + Buffer.byteLength(text) > maxQueuedBytes) {
                fail(new Error('WebSocket output queue exceeded'));
                return;
            }
            socket.send(text, error => { if (error) fail(error); });
        }));
    }).catch(fail);
    socket.on('error', fail);
    socket.on('close', () => close(closeCodes.normal, ''));
    socket.on('message', data => {
        if (closed) return;
        const text = data.toString();
        const bytes = Buffer.byteLength(text);
        queuedBytes += bytes;
        queuedFrames++;
        if (queuedBytes > maxQueuedBytes || queuedFrames > 1024) {
            fail(new Error('JSON-RPC input queue exceeded'));
            return;
        }
        let frame: JsonValue;
        try {
            frame = JSON.parse(text);
        } catch {
            fail(new Error('Invalid JSON WebSocket message'));
            return;
        }
        pending = pending.then(async () => {
            const transport = await opened;
            if (!closed) await transport.send(frame);
        }).catch(fail).finally(() => {
            queuedBytes -= bytes;
            queuedFrames--;
        });
    });
    return () => close(closeCodes.goingAway, 'JSON-RPC export closing');
}

/** Reasons are limited to 123 bytes by the WebSocket protocol. */
function _closeReason(reason: string): string {
    let result = reason;
    while (Buffer.byteLength(result) > 123) result = result.slice(0, -1);
    return result;
}
