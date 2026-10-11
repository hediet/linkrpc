import { Channel, type IRequestHandler, type IRequestSender } from '../connection/channel';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { isNotification, isResponse, type JsonRpcMessage, type JsonValue } from '../protocol/jsonRpc';
import type { IMessageTransport } from '../transport/messageTransport';
import { StreamDir, STREAM_METHOD } from '../connection/streaming';
import {
    CALL_HEADER, DEFAULT_MAX_BYTES, HttpRpcError, JSON_TYPE, NDJSON, STREAM_PATH,
    httpRoute, parseJson, parseStreamMessage, readBody, validateLimits,
} from './protocol';

export { httpRoute, HttpRpcError } from './protocol';

export interface HttpRequestContext<T> {
    readonly request: Request;
    readonly data: T;
    /** Only responses and request-scoped streams are supported on this peer. */
    readonly peer: LinkRpcConnection<HttpRequestContext<T>, unknown>;
}

/** Information the host already determined about a request. */
export interface HttpHandleOptions {
    /** Path relative to where the handler is mounted. Defaults to the request URL path. */
    readonly path?: string;
    /**
     * JSON body already parsed by host middleware (e.g. `express.json()`); the
     * request body stream is then not read. Undefined means "not parsed".
     */
    readonly parsedBody?: JsonValue;
}

export interface HttpServerOptions<T> {
    readonly context: (request: Request) => T | Promise<T>;
    readonly timeoutMs?: number;
    readonly maxFrameBytes?: number;
    readonly maxActiveCalls?: number;
    /** Optional additional authorization (e.g. revocation checks) for stream input. */
    readonly authorizeStream?: (request: Request, context: HttpRequestContext<T>) => void | Promise<void>;
}

export class HttpServer<T> {
    public static shared<T>(options: HttpServerOptions<T>): HttpServer<T> & {
        readonly connection: LinkRpcConnection<HttpRequestContext<T>, unknown>;
    } {
        let handler: IRequestHandler<HttpRequestContext<T>> | undefined;
        const channel = new Channel<HttpRequestContext<T>, unknown>(
            new HttpReceiveOnlySender(),
            value => { handler = value; },
        );
        const connection = new LinkRpcConnection(channel);
        const server = new HttpServer(options, connection, () => handler);
        connection.onDidClose(() => server.dispose());
        return Object.assign(server, { connection });
    }

    public static perRequest<T>(options: HttpServerOptions<T> & {
        readonly accept: (connection: LinkRpcConnection<HttpRequestContext<T>, unknown>) => void;
    }): HttpServer<T> {
        return new HttpServer(options, undefined, undefined, options.accept);
    }

    private readonly _calls = new Map<string, ServerCall<T>>();
    private _sharedRoutes: ReadonlyMap<string, ReturnType<LinkRpcConnection['listRegisteredMethods']>[number]> | undefined;
    private readonly _stopWatchingDirectory: (() => void) | undefined;
    private _closed = false;
    private _accepting = 0;

    private constructor(
        private readonly _options: HttpServerOptions<T>,
        private readonly _shared?: LinkRpcConnection<HttpRequestContext<T>, unknown>,
        private readonly _handler?: () => IRequestHandler<HttpRequestContext<T>> | undefined,
        private readonly _accept?: (connection: LinkRpcConnection<HttpRequestContext<T>, unknown>) => void,
    ) {
        validateLimits(_options);
        this._stopWatchingDirectory = _shared?.onDidChangeDirectory(() => {
            this._sharedRoutes = undefined;
        });
    }

    public async handle(request: Request, options: HttpHandleOptions = {}): Promise<Response> {
        if (this._closed) return new Response('HTTP server is closed', { status: 503 });
        const url = new URL(request.url);
        const path = options.path ?? url.pathname;
        if (!path.startsWith('/') || /[?#]/.test(path)) throw new Error('HTTP route path must start with "/" and contain no query or fragment');
        let call: ServerCall<T> | undefined;
        let reserved = false;
        try {
            if (path === STREAM_PATH) return await this._input(request, options.parsedBody);
            if (this._calls.size + this._accepting >= (this._options.maxActiveCalls ?? 1024)) {
                throw new HttpRpcError('Too many active HTTP calls', 503);
            }
            this._accepting++;
            reserved = true;
            const data = await this._options.context(request);
            request.signal.throwIfAborted();
            if (this._closed) throw new HttpRpcError('HTTP server is closed', 503);
            call = new ServerCall(request, data, this._options, () => this._calls.delete(call!.handle));
            this._calls.set(call.handle, call);
            this._accepting--;
            reserved = false;
            if (this._shared) {
                const handler = this._handler?.();
                if (!handler) throw new Error('Shared connection has no request handler');
                call.channel.setRequestHandler(handler);
            } else {
                this._accept!(call.peer);
            }
            const connection = this._shared ?? call.peer;
            const routes = this._getRoutes(connection);
            const entry = routes.get(`${request.method} ${path}`);
            if (!entry) {
                const methods = [...routes.keys()].filter(key => key.endsWith(' ' + path)).map(key => key.split(' ')[0]);
                call.dispose();
                return new Response('RPC route not found', {
                    status: methods.length ? 405 : 404,
                    headers: methods.length ? { Allow: methods.join(', ') } : undefined,
                });
            }
            const maxBytes = this._options.maxFrameBytes ?? DEFAULT_MAX_BYTES;
            let params: JsonValue | undefined;
            if (request.method === 'GET') {
                if ([...url.searchParams.keys()].some(key => key !== 'params') || url.searchParams.getAll('params').length > 1) {
                    throw new HttpRpcError('Expected a single params query parameter', 400);
                }
                const text = url.searchParams.get('params') ?? '';
                if (new TextEncoder().encode(text).length > maxBytes) throw new HttpRpcError('Params too large', 413);
                params = text === '' ? undefined : parseJson(text);
            } else {
                assertJsonContentType(request);
                params = await this._readJson(request, options.parsedBody, call.signal);
            }
            const definition = entry.definition;
            const streaming = definition.kind === 'request'
                && (definition.clientStreamSchema !== undefined || definition.serverStreamSchema !== undefined);
            return await call.start(
                definition.kind === 'notification'
                    ? { jsonrpc: '2.0', method: entry.method, params }
                    : { jsonrpc: '2.0', id: 1, method: entry.method, params },
                streaming,
            );
        } catch (error) {
            call?.dispose(error);
            if (error instanceof HttpRpcError) return new Response(error.message, { status: error.status });
            // Application authentication and configuration failures belong to the HTTP host's error handler.
            throw error;
        } finally {
            if (reserved) this._accepting--;
        }
    }

    public dispose(): void {
        if (this._closed) return;
        this._closed = true;
        this._stopWatchingDirectory?.();
        this._sharedRoutes = undefined;
        for (const call of this._calls.values()) call.dispose();
        this._shared?.close();
    }

    private _getRoutes(connection: LinkRpcConnection<HttpRequestContext<T>, unknown>) {
        if (connection === this._shared && this._sharedRoutes) return this._sharedRoutes;
        const routes = new Map<string, ReturnType<typeof connection.listRegisteredMethods>[number]>();
        for (const entry of connection.listRegisteredMethods()) {
            const route = httpRoute(entry.method);
            const key = `${route.method} ${route.path}`;
            if (routes.has(key)) throw new Error(`Ambiguous HTTP route: ${key}`);
            routes.set(key, entry);
        }
        if (connection === this._shared) this._sharedRoutes = routes;
        return routes;
    }

    private async _readJson(request: Request, parsedBody: JsonValue | undefined, signal: AbortSignal): Promise<JsonValue | undefined> {
        const maxBytes = this._options.maxFrameBytes ?? DEFAULT_MAX_BYTES;
        if (parsedBody !== undefined) {
            // Host parsers have their own limits; still enforce the configured RPC frame limit.
            if (new TextEncoder().encode(JSON.stringify(parsedBody)).length > maxBytes) {
                throw new HttpRpcError('Body too large', 413);
            }
            return parsedBody;
        }
        const text = await readBody(request.body, maxBytes, signal);
        return text === '' ? undefined : parseJson(text);
    }

    private async _input(request: Request, parsedBody: JsonValue | undefined): Promise<Response> {
        if (request.method !== 'POST') return new Response('Use POST', { status: 405, headers: { Allow: 'POST' } });
        const call = this._calls.get(request.headers.get(CALL_HEADER) ?? '');
        if (!call) throw new HttpRpcError('Unknown or completed HTTP call', 410);
        for (const header of ['authorization', 'cookie', 'origin']) {
            if (request.headers.get(header) !== call.context.request.headers.get(header)) {
                throw new HttpRpcError('Stream credentials do not match the call', 403);
            }
        }
        await this._options.authorizeStream?.(request, call.context);
        assertJsonContentType(request);
        if (call.inputPending) throw new HttpRpcError('Concurrent stream input is not supported', 409);
        call.inputPending = true;
        try {
            call.input(parseStreamMessage(await this._readJson(request, parsedBody, call.signal), StreamDir.toCallee));
            return new Response(null, { status: 204 });
        } catch (error) {
            if (call.signal.aborted) throw new HttpRpcError('HTTP call no longer accepts input', 410);
            throw error;
        } finally {
            call.inputPending = false;
        }
    }
}

class ServerCall<T> implements IMessageTransport<JsonRpcMessage & { context: HttpRequestContext<T> }, JsonRpcMessage> {
    public readonly handle = crypto.randomUUID();
    public readonly channel: Channel<HttpRequestContext<T>, unknown>;
    public readonly peer: LinkRpcConnection<HttpRequestContext<T>, unknown>;
    public readonly context: HttpRequestContext<T>;
    public inputPending = false;
    private _listener: ((message: JsonRpcMessage & { context: HttpRequestContext<T> }) => void) | undefined;
    private readonly _timer: ReturnType<typeof setTimeout>;
    private readonly _closeChannel: () => void;
    private _closed = false;
    private _streaming = false;
    private _started = false;
    private _queuedBytes = 0;
    private _writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    private _respond: ((response: Response) => void) | undefined;
    private readonly _abort = () => this.dispose(new HttpRpcError('HTTP client disconnected', 499));
    private readonly _lifetime = new AbortController();
    public get signal(): AbortSignal { return this._lifetime.signal; }

    constructor(
        request: Request, data: T, private readonly _options: HttpServerOptions<T>,
        private readonly _onClose: () => void,
    ) {
        const { channel, close } = JsonRpcChannel.createWithClose<HttpRequestContext<T>>(this);
        this.channel = channel;
        this._closeChannel = close;
        this.peer = new LinkRpcConnection(channel.withSender(() => new HttpReceiveOnlySender()));
        this.peer.onDidClose(() => this.dispose());
        this.context = { request, data, peer: this.peer };
        this._timer = setTimeout(() => this.dispose(new HttpRpcError('HTTP call timed out', 408)), _options.timeoutMs ?? 300_000);
        request.signal.addEventListener('abort', this._abort, { once: true });
    }

    public setListener(listener: typeof this._listener): void { this._listener = listener; }

    public start(message: JsonRpcMessage, streaming: boolean): Promise<Response> {
        if (this._closed) throw new HttpRpcError('HTTP call closed during setup', 410);
        this._started = true;
        this._streaming = streaming;
        const headers = {
            'Content-Type': streaming ? NDJSON : JSON_TYPE,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...(streaming ? { [CALL_HEADER]: this.handle, 'X-Accel-Buffering': 'no' } : {}),
        };
        if (streaming) {
            const stream = new TransformStream<Uint8Array, Uint8Array>();
            this._writer = stream.writable.getWriter();
            void this._writer.closed.catch(error => this.dispose(error));
            const response = new Response(stream.readable, { headers });
            this._listener?.({ ...message, context: this.context });
            return Promise.resolve(response);
        }
        const response = new Promise<Response>(resolve => {
            this._respond = resolve;
            this._listener?.({ ...message, context: this.context });
        });
        if (isNotification(message)) {
            this._respond?.(new Response(null, { status: 204 }));
            this.dispose();
        }
        return response;
    }

    public input(message: JsonRpcMessage): void {
        if (this._closed || !this._started || !this._streaming) throw new HttpRpcError('HTTP call no longer accepts input', 410);
        this._listener?.({ ...message, context: this.context });
    }

    public async send(message: JsonRpcMessage): Promise<void> {
        if (this._closed) throw new Error('HTTP call is closed');
        const terminal = isResponse(message);
        if (!terminal && !(isNotification(message) && message.method === STREAM_METHOD)) {
            throw new Error('Incoming HTTP requests do not support reverse calls or notifications');
        }
        const text = JSON.stringify(message);
        const chunk = new TextEncoder().encode(text + '\n');
        const maxBytes = this._options.maxFrameBytes ?? DEFAULT_MAX_BYTES;
        if (chunk.length - 1 > maxBytes || this._queuedBytes + chunk.length > maxBytes * 4) {
            const error = new HttpRpcError('HTTP response buffer limit exceeded', 413);
            this.dispose(error);
            throw error;
        }
        if (this._streaming) {
            this._queuedBytes += chunk.length;
            try {
                await this._writer!.write(chunk);
                if (terminal) await this._writer!.close();
            } catch (error) {
                this.dispose(error);
                throw error;
            } finally {
                this._queuedBytes -= chunk.length;
            }
        } else {
            if (!terminal) throw new Error('Unary HTTP response cannot carry stream messages');
            this._respond?.(new Response(text, { headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' } }));
        }
        if (terminal) this.dispose();
    }

    public dispose(reason: unknown = new Error('HTTP call closed')): void {
        if (this._closed) return;
        this._closed = true;
        this._lifetime.abort(reason);
        clearTimeout(this._timer);
        this.context.request.signal.removeEventListener('abort', this._abort);
        this._onClose();
        this._closeChannel();
        this.peer.close();
        this._respond?.(new Response('HTTP call closed', { status: reason instanceof HttpRpcError ? reason.status : 503 }));
        if (this._writer) void this._writer.abort(reason).catch(() => {
            // Reader cancellation may already have errored the writable side.
        });
    }
}

function assertJsonContentType(request: Request): void {
    if (request.headers.get('content-type')?.split(';')[0].trim() !== JSON_TYPE) {
        throw new HttpRpcError('Expected application/json', 415);
    }
}

class HttpReceiveOnlySender implements IRequestSender<unknown> {
    public sendRequest(): never { throw new Error('Incoming HTTP requests do not support reverse calls'); }
    public sendNotification(): never { throw new Error('Incoming HTTP requests do not support reverse notifications'); }
    public sendRequestWithStream(): never { throw new Error('Incoming HTTP requests do not support reverse calls'); }
    public close(): void {}
}
