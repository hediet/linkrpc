/**
 * Local HTTP gateway from `*.localhost` hostnames to loopback ports of Hub compute nodes.
 * `localhost` lists services, `<service>.localhost` lists a service's ports, and
 * `<port>.<service>.localhost` proxies HTTP and WebSocket traffic through `tcpForward`.
 * There is no gateway credential or origin check: forwarded applications authenticate their own users
 * and decide which cross-site requests to accept.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ComputeNodeListeningPort } from '../compute-node/index';
import {
    formatHttpExportHost,
    HTTP_EXPORT_BASE_DOMAIN,
    parseHttpExportHost,
    resolveServiceReference,
    type ServiceReference,
} from './hostname';
import { HubTcpHttpAgent, HubTcpMultiplexer, type TcpForwardClient } from './tcpMultiplexer';

export * from './hostname';
export * from './tcpMultiplexer';

const POOL_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Connections a pool's HTTP agent may use; the rest of the multiplex budget stays free for WebSocket upgrades. */
const MAX_HTTP_SOCKETS = 8;
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

export interface HttpExportServiceList {
    readonly serviceIds: readonly string[];
    /** Whether every directory could be read; otherwise some services may be missing. */
    readonly complete: boolean;
}

export interface HttpExportOptions {
    readonly listen: readonly { readonly host: string; readonly port: number }[];
    readonly baseDomain?: string;
    readonly getTcpForward: (serviceId: string) => TcpForwardClient;
    readonly listServices: () => Promise<HttpExportServiceList>;
    /** Throws when the service cannot list its ports. */
    readonly listPorts: (serviceId: string) => Promise<readonly ComputeNodeListeningPort[]>;
    /** Request failures. Must not throw. */
    readonly onError: (error: Error) => void;
}

export interface HttpExport {
    /** Base URLs the gateway is reachable at. */
    readonly urls: readonly string[];
    close(): Promise<void>;
}

export async function startHttpExport(options: HttpExportOptions): Promise<HttpExport> {
    if (options.listen.length === 0) {
        throw new Error('Specify at least one listen address.');
    }
    const gateway = new HttpExportGateway(options);
    const servers: Server[] = [];
    try {
        for (const address of options.listen) {
            servers.push(await gateway.listen(address.host, address.port));
        }
    } catch (error) {
        await gateway.close(servers);
        throw error;
    }
    const address = servers[0].address();
    const port = address && typeof address === 'object' ? address.port : options.listen[0].port;
    const baseDomain = options.baseDomain ?? HTTP_EXPORT_BASE_DOMAIN;
    return {
        urls: [`http://${baseDomain}${port === 80 ? '' : `:${port}`}/`],
        close: () => gateway.close(servers),
    };
}

interface Pool {
    readonly multiplexer: HubTcpMultiplexer;
    readonly agent: HubTcpHttpAgent;
    leases: number;
    idleTimer: ReturnType<typeof setTimeout> | undefined;
}

class HttpExportGateway {
    private readonly _baseDomain: string;
    private readonly _pools = new Map<string, Pool>();
    private readonly _sockets = new Set<Duplex>();
    private _closing = false;

    constructor(private readonly _options: HttpExportOptions) {
        this._baseDomain = _options.baseDomain ?? HTTP_EXPORT_BASE_DOMAIN;
    }

    listen(host: string, port: number): Promise<Server> {
        const server = createServer((request, response) => {
            void this._handleRequest(request, response).catch(error => this._fail(response, error));
        });
        server.on('upgrade', (request, socket, head) => {
            void this._handleUpgrade(request, socket, head).catch(error => {
                this._options.onError(normalizeError(error));
                socket.destroy();
            });
        });
        server.on('connection', socket => {
            this._sockets.add(socket);
            socket.on('close', () => this._sockets.delete(socket));
        });
        server.on('clientError', (_error, socket) => socket.destroy());
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.off('error', reject);
                server.on('error', error => this._options.onError(error));
                resolve(server);
            });
        });
    }

    async close(servers: readonly Server[]): Promise<void> {
        this._closing = true;
        for (const pool of this._pools.values()) {
            clearTimeout(pool.idleTimer);
            pool.agent.destroy();
            void pool.multiplexer.dispose();
        }
        this._pools.clear();
        await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
        for (const socket of this._sockets) {
            socket.destroy();
        }
    }

    private async _handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const host = request.headers.host ?? '';
        const parsed = parseHttpExportHost(host, this._baseDomain);
        if (!parsed) {
            return sendText(response, 421, `This gateway only serves ${this._baseDomain} and its subdomains.`);
        }
        if (parsed.kind === 'index') {
            return this._renderServices(request, response);
        }
        const serviceId = await this._resolveService(parsed.service);
        if (!serviceId) {
            return sendText(response, 404, 'Unknown service.');
        }
        if (parsed.params.port === undefined) {
            return this._renderPorts(request, response, serviceId);
        }
        await this._proxyHttp(request, response, serviceId, parsed.params.port);
    }

    private async _handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        const reject = (status: string): void => {
            socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        };
        const parsed = parseHttpExportHost(request.headers.host ?? '', this._baseDomain);
        if (!parsed || parsed.kind !== 'service' || parsed.params.port === undefined) {
            return reject('404 Not Found');
        }
        const serviceId = await this._resolveService(parsed.service);
        if (!serviceId) {
            return reject('404 Not Found');
        }
        const pool = this._acquirePool(serviceId, parsed.params.port);
        let released = false;
        const release = (): void => {
            if (!released) {
                released = true;
                this._releasePool(serviceId, parsed.params.port!, pool);
            }
        };
        socket.once('close', release);
        let upstream: Duplex;
        try {
            upstream = await pool.multiplexer.openSocket();
        } catch (error) {
            release();
            this._options.onError(normalizeError(error));
            return reject('502 Bad Gateway');
        }
        if (socket.destroyed) {
            upstream.destroy();
            return;
        }
        upstream.write(serializeRequestHead(request));
        if (head.length > 0) {
            upstream.write(head);
        }
        const closeBoth = (): void => {
            upstream.destroy();
            socket.destroy();
        };
        upstream.once('error', closeBoth);
        upstream.once('close', closeBoth);
        socket.once('error', closeBoth);
        socket.pipe(upstream).pipe(socket);
    }

    private async _proxyHttp(request: IncomingMessage, response: ServerResponse, serviceId: string, port: number): Promise<void> {
        const pool = this._acquirePool(serviceId, port);
        try {
            await new Promise<void>((resolve, reject) => {
                const upstreamRequest = httpRequest({
                    agent: pool.agent,
                    host: '127.0.0.1',
                    port,
                    method: request.method,
                    path: request.url,
                    headers: forwardedRequestHeaders(request),
                    setHost: false,
                }, upstreamResponse => {
                    response.writeHead(
                        upstreamResponse.statusCode ?? 502,
                        upstreamResponse.statusMessage,
                        forwardedResponseHeaders(upstreamResponse, port, request.headers.host ?? ''),
                    );
                    upstreamResponse.pipe(response);
                    upstreamResponse.once('end', resolve);
                    upstreamResponse.once('error', reject);
                });
                upstreamRequest.once('error', reject);
                response.once('close', () => {
                    if (!response.writableFinished) {
                        upstreamRequest.destroy();
                        resolve();
                    }
                });
                request.pipe(upstreamRequest);
            });
        } finally {
            this._releasePool(serviceId, port, pool);
        }
    }

    private _acquirePool(serviceId: string, port: number): Pool {
        const key = `${serviceId}\n${port}`;
        let pool = this._pools.get(key);
        if (!pool || pool.multiplexer.closed) {
            const multiplexer = new HubTcpMultiplexer(this._options.getTcpForward(serviceId), port, () => {
                if (this._pools.get(key)?.multiplexer === multiplexer) {
                    this._pools.delete(key);
                }
            });
            pool = { multiplexer, agent: new HubTcpHttpAgent(multiplexer, MAX_HTTP_SOCKETS), leases: 0, idleTimer: undefined };
            this._pools.set(key, pool);
        }
        clearTimeout(pool.idleTimer);
        pool.idleTimer = undefined;
        pool.leases++;
        return pool;
    }

    private _releasePool(serviceId: string, port: number, pool: Pool): void {
        pool.leases--;
        if (pool.leases > 0 || this._closing) {
            return;
        }
        pool.idleTimer = setTimeout(() => {
            const key = `${serviceId}\n${port}`;
            if (this._pools.get(key) === pool && pool.leases === 0) {
                this._pools.delete(key);
                pool.agent.destroy();
                void pool.multiplexer.dispose();
            }
        }, POOL_IDLE_TIMEOUT_MS);
        pool.idleTimer.unref?.();
    }

    private async _resolveService(reference: ServiceReference): Promise<string | undefined> {
        if (reference.kind === 'readable') {
            return reference.serviceId;
        }
        return resolveServiceReference(reference, (await this._options.listServices()).serviceIds);
    }

    private async _renderServices(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const list = await this._options.listServices();
        const services = [...list.serviceIds].sort().map(serviceId => ({ serviceId, url: this._url(request, formatHttpExportHost({ serviceId, params: {} }, this._baseDomain)) }));
        if (wantsJson(request)) {
            return sendJson(response, { services, complete: list.complete });
        }
        const items = services.map(service => `<li><a href="${escapeHtml(service.url)}">${escapeHtml(service.serviceId)}</a></li>`).join('');
        sendHtml(response, 'Forwardable services', `
            <h1>Forwardable services</h1>
            ${list.complete ? '' : '<p class="note">Some directories could not be read; this list may be incomplete.</p>'}
            ${services.length ? `<ul>${items}</ul>` : '<p>No reachable service offers TCP forwarding.</p>'}
            <p class="note">Open <code>&lt;port&gt;.&lt;service&gt;.${escapeHtml(this._baseDomain)}</code> to forward a port.</p>`);
    }

    private async _renderPorts(request: IncomingMessage, response: ServerResponse, serviceId: string): Promise<void> {
        let ports: readonly ComputeNodeListeningPort[] | undefined;
        let error: string | undefined;
        try {
            ports = await this._options.listPorts(serviceId);
        } catch (e) {
            error = normalizeError(e).message;
        }
        const entries = (ports ?? []).map(port => ({
            ...port,
            url: this._url(request, formatHttpExportHost({ serviceId, params: { port: port.port } }, this._baseDomain)),
        }));
        if (wantsJson(request)) {
            return sendJson(response, { serviceId, ports: entries, ...(error === undefined ? {} : { error }) });
        }
        const rows = entries.map(port => `<tr><td><a href="${escapeHtml(port.url)}">${port.port}</a></td>`
            + `<td>${escapeHtml(port.processName ?? '')}${port.pid === undefined ? '' : ` <span class="note">(${port.pid})</span>`}</td>`
            + `<td class="note">${escapeHtml(port.addresses.join(', '))}</td></tr>`).join('');
        sendHtml(response, serviceId, `
            <p><a href="${escapeHtml(this._url(request, this._baseDomain))}">All services</a></p>
            <h1>${escapeHtml(serviceId)}</h1>
            ${error === undefined ? '' : `<p class="note">Listening ports are unavailable: ${escapeHtml(error)}</p>`}
            ${entries.length ? `<table><tr><th>Port</th><th>Process</th><th>Bound to</th></tr>${rows}</table>` : ''}
            <p class="note">Any loopback port can be opened as <code>&lt;port&gt;.${escapeHtml(formatHttpExportHost({ serviceId, params: {} }, this._baseDomain))}</code>.</p>`);
    }

    private _url(request: IncomingMessage, hostname: string): string {
        const port = /:(\d+)$/.exec(request.headers.host ?? '')?.[1];
        return `http://${hostname}${port && port !== '80' ? `:${port}` : ''}/`;
    }

    private _fail(response: ServerResponse, error: unknown): void {
        const normalized = normalizeError(error);
        this._options.onError(normalized);
        if (!response.headersSent) {
            sendText(response, 502, `Forwarding failed: ${normalized.message}`);
        } else {
            response.destroy();
        }
    }
}

function forwardedRequestHeaders(request: IncomingMessage): string[] {
    const headers: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index];
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
            headers.push(name, request.rawHeaders[index + 1]);
        }
    }
    headers.push('X-Forwarded-Proto', 'http');
    if (request.headers.host) {
        headers.push('X-Forwarded-Host', request.headers.host);
    }
    return headers;
}

/** Keeps response headers, rewriting redirects that point at the target's own loopback address. */
function forwardedResponseHeaders(response: IncomingMessage, port: number, exportedHost: string): string[] {
    const headers: string[] = [];
    const loopbackOrigin = new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port}(?=/|$)`, 'i');
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index];
        let value = response.rawHeaders[index + 1];
        if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
            continue;
        }
        if (name.toLowerCase() === 'location' && exportedHost) {
            value = value.replace(loopbackOrigin, `http://${exportedHost}`);
        }
        headers.push(name, value);
    }
    return headers;
}

function serializeRequestHead(request: IncomingMessage): Buffer {
    const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
    }
    lines.push('', '');
    return Buffer.from(lines.join('\r\n'), 'latin1');
}

function wantsJson(request: IncomingMessage): boolean {
    return /\bapplication\/json\b/.test(request.headers.accept ?? '') || new URL(request.url ?? '/', 'http://x').searchParams.get('format') === 'json';
}

function sendText(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`${text}\n`);
}

function sendJson(response: ServerResponse, value: unknown): void {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, title: string, body: string): void {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
        + '<style>body{font:14px system-ui,sans-serif;margin:2em;color-scheme:light dark}'
        + 'td,th{padding:.2em 1em .2em 0;text-align:left}.note{opacity:.7}</style>'
        + body);
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
