import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';
import type { IRequestSender, RawStreamingCall, SendOpts, StreamSendOpts } from '../connection/channel';
import { isNotification, isRequest, isResponse, type JsonRpcMessage, type JsonValue } from '../protocol/jsonRpc';
import type { IMessageTransport } from '../transport/messageTransport';
import { STREAM_METHOD } from '../connection/streaming';
import {
    CALL_HEADER, DEFAULT_MAX_BYTES, HttpRpcError, JSON_TYPE, NDJSON, STREAM_PATH,
    httpRoute, parseResponseMessage, readBody, readLines, validateLimits,
} from './protocol';

export { httpRoute, HttpRpcError } from './protocol';

export interface HttpClientOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
    readonly credentials?: RequestCredentials;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxFrameBytes?: number;
    readonly maxPendingStreamMessages?: number;
}

/** No network connection or handshake is needed until the first call. */
export function connectHttp(baseUrl: string | URL, options: HttpClientOptions = {}): LinkRpcConnection<undefined, unknown> {
    return new LinkRpcConnection(new HttpClient(baseUrl, options));
}

class HttpClient implements IRequestSender<unknown> {
    private readonly _calls = new Set<() => void>();
    private _closed = false;
    private readonly _abort = () => this.close();

    constructor(private readonly _url: string | URL, private readonly _options: HttpClientOptions) {
        validateLimits(_options);
        if (_options.signal?.aborted) this.close();
        else _options.signal?.addEventListener('abort', this._abort, { once: true });
    }

    public sendRequest(method: string, params: JsonValue | undefined, opts?: SendOpts<unknown>): Promise<JsonValue> {
        const call = this._create();
        return call.finish(call.channel.sender.sendRequest(method, params, opts));
    }

    public sendNotification(method: string, params: JsonValue | undefined, opts?: SendOpts<unknown>): Promise<void> {
        const call = this._create();
        return call.channel.sender.sendNotification(method, params, opts).finally(call.release);
    }

    public sendRequestWithStream(method: string, params: JsonValue | undefined, opts?: StreamSendOpts<unknown>): RawStreamingCall {
        const call = this._create();
        const stream = call.channel.sender.sendRequestWithStream(method, params, opts);
        return { ...stream, result: call.finish(stream.result) };
    }

    public close(): void {
        this._closed = true;
        this._options.signal?.removeEventListener('abort', this._abort);
        for (const release of this._calls) release();
    }

    private _create() {
        if (this._closed) throw new Error('HTTP connection is closed');
        const transport = new HttpCallTransport(this._url, this._options);
        const { channel, close } = JsonRpcChannel.createWithClose(transport);
        transport.onFailure = error => close(error);
        const release = () => {
            this._calls.delete(release);
            close();
        };
        this._calls.add(release);
        const finish = (result: Promise<JsonValue>) => result.then(async value => {
            await transport.drainInput();
            release();
            return value;
        }, error => {
            release();
            throw error;
        });
        return { channel, release, finish };
    }
}

class HttpCallTransport implements IMessageTransport {
    public onFailure: (error: Error) => void = () => {};
    private _listener: ((message: JsonRpcMessage) => void) | undefined;
    private readonly _abort = new AbortController();
    private readonly _fetch: typeof globalThis.fetch;
    private readonly _base: URL;
    private readonly _maxBytes: number;
    private readonly _timer: ReturnType<typeof setTimeout>;
    private _handle: string | undefined;
    private _ready!: () => void;
    private readonly _handleReady = new Promise<void>(resolve => { this._ready = resolve; });
    private _headers: Headers | undefined;
    private _tail = Promise.resolve();
    private _pending = 0;
    private _finished = false;

    constructor(baseUrl: string | URL, private readonly _options: HttpClientOptions) {
        this._base = new URL(baseUrl, typeof location === 'undefined' ? undefined : location.href);
        if (!['http:', 'https:'].includes(this._base.protocol) || this._base.search || this._base.hash) {
            throw new Error('HTTP base URL must be an http(s) URL without query or fragment');
        }
        this._fetch = _options.fetch ?? globalThis.fetch;
        this._maxBytes = _options.maxFrameBytes ?? DEFAULT_MAX_BYTES;
        this._timer = setTimeout(() => {
            const error = new HttpRpcError('HTTP call timed out', 408);
            this.onFailure(error);
        }, _options.timeoutMs ?? 300_000);
    }

    public setListener(listener: ((message: JsonRpcMessage) => void) | undefined): void {
        this._listener = listener;
    }

    public send(message: JsonRpcMessage): Promise<void> {
        if (isNotification(message) && message.method === STREAM_METHOD) return this._sendInput(message);
        return this._request(message);
    }

    public dispose(): void {
        this._finished = true;
        clearTimeout(this._timer);
        this._ready();
        this._abort.abort();
    }

    public drainInput(): Promise<void> { return this._tail; }

    private _url(path: string): URL {
        const url = new URL(this._base.href);
        // A root base URL normalizes to "/", which would otherwise produce "//route".
        url.pathname = this._base.pathname.replace(/\/$/, '') + path;
        return url;
    }

    private async _request(message: JsonRpcMessage): Promise<void> {
        if (!isRequest(message) && !isNotification(message)) throw new Error('HTTP client cannot send unsolicited responses');
        const route = httpRoute(message.method);
        const url = this._url(route.path);
        const serialized = message.params === undefined ? undefined : JSON.stringify(message.params);
        if (serialized !== undefined && new TextEncoder().encode(serialized).length > this._maxBytes) {
            throw new HttpRpcError('Request body too large', 413);
        }
        if (route.method === 'GET' && serialized !== undefined) url.searchParams.set('params', serialized);
        this._headers = new Headers(typeof this._options.headers === 'function'
            ? await this._options.headers() : this._options.headers);
        this._headers.set('Content-Type', JSON_TYPE);
        this._headers.set('Accept', `${JSON_TYPE}, ${NDJSON}`);
        try {
            const response = await this._fetch(url, {
                method: route.method, headers: this._headers,
                body: route.method === 'GET' ? undefined : serialized,
                signal: this._abort.signal, credentials: this._options.credentials, redirect: 'error',
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new HttpRpcError(`HTTP request failed: ${response.status} ${response.statusText}`, response.status);
            }
            this._handle = response.headers.get(CALL_HEADER) ?? undefined;
            this._ready();
            if (isNotification(message)) {
                await response.body?.cancel();
                if (response.status !== 204) throw new HttpRpcError('Expected HTTP 204 for notification', 502);
                return;
            }
            const contentType = response.headers.get('content-type')?.split(';')[0].trim();
            if (contentType === NDJSON) {
                if (!response.body || !this._handle) throw new HttpRpcError('Missing HTTP stream body or call handle', 502);
                let final: JsonRpcMessage | undefined;
                for await (const line of readLines(response.body, this._maxBytes)) {
                    if (final) throw new HttpRpcError('Message after final response', 502);
                    const incoming = parseResponseMessage(line);
                    if (isResponse(incoming)) final = incoming;
                    else this._listener?.(incoming);
                }
                if (!final) throw new HttpRpcError('HTTP stream ended without a final response', 502);
                this._listener?.(final);
            } else if (contentType === JSON_TYPE) {
                const incoming = parseResponseMessage(await readBody(response.body, this._maxBytes));
                if (!isResponse(incoming)) throw new HttpRpcError('Expected final RPC response', 502);
                this._listener?.(incoming);
            } else {
                await response.body?.cancel();
                throw new HttpRpcError('Unsupported HTTP response content type', 502);
            }
        } finally {
            this._finished = true;
            this._ready();
        }
    }

    private _sendInput(message: JsonRpcMessage): Promise<void> {
        if (this._pending >= (this._options.maxPendingStreamMessages ?? 64)) {
            return Promise.reject(new HttpRpcError('Too many pending stream messages', 429));
        }
        const body = JSON.stringify(message);
        if (new TextEncoder().encode(body).length > this._maxBytes) {
            return Promise.reject(new HttpRpcError('Stream message too large', 413));
        }
        this._pending++;
        const operation = this._tail.then(async () => {
            await this._handleReady;
            if (this._finished || !this._handle) throw new Error('HTTP call is no longer accepting stream messages');
            const url = this._url(STREAM_PATH);
            const headers = new Headers(this._headers);
            headers.set(CALL_HEADER, this._handle);
            const response = await this._fetch(url, {
                method: 'POST', headers, body,
                signal: this._abort.signal, credentials: this._options.credentials, redirect: 'error',
            });
            await response.body?.cancel();
            if (response.status !== 204) throw new HttpRpcError(`HTTP stream input failed: ${response.status}`, response.status);
        }).finally(() => { this._pending--; });
        this._tail = operation.catch(error => {
            if (!this._finished) this.onFailure(error instanceof Error ? error : new Error(String(error)));
        });
        return operation;
    }
}
