/**
 * Local HTTP gateway from `*.localhost` hostnames to loopback ports of Hub compute nodes.
 * `localhost` lists services, `<service>.localhost` lists a service's ports, and
 * `<port>.<service>.localhost` proxies HTTP and WebSocket traffic through `tcpForward`.
 * There is no gateway credential or origin check for forwarded ports: forwarded applications authenticate
 * their own users and decide which cross-site requests to accept. The gateway's own pages, which list
 * process command lines, only answer top-level navigations, same-origin requests, and non-browser clients.
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
import { BrowserApproval, type BrowserApprovalOptions, type HttpExportCaller } from './browserApproval';
import { HubTcpHttpAgent, HubTcpMultiplexer, type TcpForwardClient } from './tcpMultiplexer';
import {
    type ForwardTarget,
    gatewayPortSuffix,
    relayUpgradeResponse,
    serializeHead,
    translateRequestHeaders,
    translateResponseHeaders,
} from './originTranslation';

export * from './browserApproval';
export * from './hostname';
export * from './originTranslation';
export * from './tcpMultiplexer';

const POOL_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Connections a pool's HTTP agent may use; the rest of the multiplex budget stays free for WebSocket upgrades. */
const MAX_HTTP_SOCKETS = 8;

export interface HttpExportServiceList {
    readonly serviceIds: readonly string[];
    /** Whether every directory could be read; otherwise some services may be missing. */
    readonly complete: boolean;
}

export interface HttpExportOptions {
    readonly listen: readonly { readonly host: string; readonly port: number }[];
    readonly baseDomain?: string;
    /** `caller` is set for approved browsers; absent means the gateway's own identity. */
    readonly getTcpForward: (serviceId: string, caller?: HttpExportCaller) => TcpForwardClient;
    readonly listServices: () => Promise<HttpExportServiceList>;
    /** Throws when the service cannot list its ports. */
    readonly listPorts: (serviceId: string, caller?: HttpExportCaller) => Promise<readonly ComputeNodeListeningPort[]>;
    /** Require browsers to be approved through the Hub's consent flow. Absent: no approval (anyone local may browse). */
    readonly approval?: BrowserApprovalOptions;
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
    const baseDomain = options.baseDomain ?? HTTP_EXPORT_BASE_DOMAIN;
    const approval = options.approval
        ? await BrowserApproval.create(options.approval, baseDomain, async () => commonServicePrefix((await options.listServices()).serviceIds))
        : undefined;
    const gateway = new HttpExportGateway(options, approval);
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

    constructor(private readonly _options: HttpExportOptions, private readonly _approval: BrowserApproval | undefined) {
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
        let caller: HttpExportCaller | undefined;
        if (this._approval) {
            const decision = await this._approval.handleRequest(request, response);
            if (decision.kind === 'handled') {
                return;
            }
            caller = decision.caller;
        }
        if (parsed.kind === 'service' && parsed.params.port !== undefined) {
            const serviceId = await this._resolveService(parsed.service);
            if (!serviceId) {
                return sendText(response, 404, 'Unknown service.');
            }
            return this._proxyHttp(request, response, serviceId, parsed.params.port, caller);
        }
        const rejection = gatewayPageRejection(request);
        if (rejection) {
            return sendGatewayText(response, rejection.status, rejection.message);
        }
        if (parsed.kind === 'index') {
            return this._renderServices(request, response);
        }
        const serviceId = await this._resolveService(parsed.service);
        if (!serviceId) {
            return sendGatewayText(response, 404, 'Unknown service.');
        }
        return this._renderPorts(request, response, serviceId, caller);
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
        const caller = this._approval?.authorizeUpgrade(request);
        if (caller === 'rejected') {
            return reject('401 Unauthorized');
        }
        const target = this._target(request, serviceId, parsed.params.port);
        const requestHead = serializeHead(
            `${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`,
            await translateRequestHeaders(request.rawHeaders, target, reference => this._resolveService(reference), { keepUpgradeHeaders: true }),
        );
        const pool = this._acquirePool(serviceId, parsed.params.port, caller);
        let released = false;
        const release = (): void => {
            if (!released) {
                released = true;
                this._releasePool(poolKey(serviceId, parsed.params.port!, caller), pool);
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
        upstream.write(requestHead);
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
        socket.pipe(upstream);
        relayUpgradeResponse(upstream, socket, target);
    }

    private async _proxyHttp(request: IncomingMessage, response: ServerResponse, serviceId: string, port: number, caller: HttpExportCaller | undefined): Promise<void> {
        const target = this._target(request, serviceId, port);
        const headers = await translateRequestHeaders(request.rawHeaders, target, reference => this._resolveService(reference), { keepUpgradeHeaders: false });
        const pool = this._acquirePool(serviceId, port, caller);
        try {
            await new Promise<void>((resolve, reject) => {
                const upstreamRequest = httpRequest({
                    agent: pool.agent,
                    host: '127.0.0.1',
                    port,
                    method: request.method,
                    path: request.url,
                    headers,
                    setHost: false,
                }, upstreamResponse => {
                    response.writeHead(
                        upstreamResponse.statusCode ?? 502,
                        upstreamResponse.statusMessage,
                        translateResponseHeaders(upstreamResponse.rawHeaders, target, { keepUpgradeHeaders: false }),
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
            this._releasePool(poolKey(serviceId, port, caller), pool);
        }
    }

    private _target(request: IncomingMessage, serviceId: string, port: number): ForwardTarget {
        return { serviceId, port, baseDomain: this._baseDomain, gatewayPortSuffix: gatewayPortSuffix(request.headers.host) };
    }

    private _acquirePool(serviceId: string, port: number, caller: HttpExportCaller | undefined): Pool {
        const key = poolKey(serviceId, port, caller);
        let pool = this._pools.get(key);
        if (!pool || pool.multiplexer.closed) {
            const multiplexer = new HubTcpMultiplexer(this._options.getTcpForward(serviceId, caller), port, () => {
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

    private _releasePool(key: string, pool: Pool): void {
        pool.leases--;
        if (pool.leases > 0 || this._closing) {
            return;
        }
        pool.idleTimer = setTimeout(() => {
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

    private async _renderPorts(request: IncomingMessage, response: ServerResponse, serviceId: string, caller: HttpExportCaller | undefined): Promise<void> {
        let ports: readonly ComputeNodeListeningPort[] | undefined;
        let error: string | undefined;
        try {
            ports = await this._options.listPorts(serviceId, caller);
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
            + `<td>${escapeHtml(port.processName ?? '')}${port.pid === undefined ? '' : ` <span class="note">(${port.pid})</span>`}`
            + `${port.commandLine === undefined ? '' : `<div>${renderCommandLine(port.commandLine)}</div>`}`
            + `${port.cwd === undefined ? '' : `<div class="note">in <code>${escapeHtml(port.cwd)}</code></div>`}</td>`
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

function poolKey(serviceId: string, port: number, caller: HttpExportCaller | undefined): string {
    return `${caller?.id ?? ''}\n${serviceId}\n${port}`;
}

/** The longest whole-segment prefix shared by all service IDs, e.g. `hediet` for `hediet/devbox/compute` and `hediet/tablet/compute`. */
export function commonServicePrefix(serviceIds: readonly string[]): string {
    if (serviceIds.length === 0) {
        return '';
    }
    let prefix = serviceIds[0].split('/').slice(0, -1);
    for (const serviceId of serviceIds.slice(1)) {
        const segments = serviceId.split('/');
        let shared = 0;
        while (shared < prefix.length && shared < segments.length - 1 && prefix[shared] === segments[shared]) {
            shared++;
        }
        prefix = prefix.slice(0, shared);
    }
    return prefix.join('/');
}

function wantsJson(request: IncomingMessage): boolean {
    return /\bapplication\/json\b/.test(request.headers.accept ?? '') || new URL(request.url ?? '/', 'http://x').searchParams.get('format') === 'json';
}

/**
 * The gateway's own pages list services, ports, and process command lines, which may contain
 * secrets. Other origins, including forwarded apps of the same machine, must not read or frame
 * them: only top-level navigations, same-origin requests, and non-browser clients are served.
 */
function gatewayPageRejection(request: IncomingMessage): { status: number; message: string } | undefined {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return { status: 405, message: 'Gateway pages only support GET.' };
    }
    const site = request.headers['sec-fetch-site'];
    const mode = request.headers['sec-fetch-mode'];
    const destination = request.headers['sec-fetch-dest'];
    const navigation = mode === 'navigate' && (destination === 'document' || destination === undefined);
    if (site !== undefined && site !== 'none' && site !== 'same-origin' && !navigation) {
        return { status: 403, message: 'Gateway pages can only be opened directly, not fetched or embedded by other sites.' };
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${request.headers.host}`) {
        return { status: 403, message: 'Gateway pages do not answer cross-origin requests.' };
    }
    return undefined;
}

const GATEWAY_PAGE_HEADERS = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
};

function sendGatewayText(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { ...GATEWAY_PAGE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    response.end(`${text}\n`);
}

function sendText(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`${text}\n`);
}

function sendJson(response: ServerResponse, value: unknown): void {
    response.writeHead(200, { ...GATEWAY_PAGE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
    response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, title: string, body: string): void {
    response.writeHead(200, { ...GATEWAY_PAGE_HEADERS, 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
        + '<style>body{font:14px system-ui,sans-serif;margin:2em;color-scheme:light dark}'
        + 'td,th{padding:.2em 1em .2em 0;text-align:left;vertical-align:top}.note{opacity:.7}'
        + '.cmd{font-size:12px;white-space:pre-wrap;word-break:break-all}details[open]>summary .cmd{display:none}</style>'
        + body);
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

const COMMAND_LINE_PREVIEW_LENGTH = 160;

/** Long command lines (e.g. Electron's) collapse to a preview that expands without script. */
function renderCommandLine(commandLine: string): string {
    if (commandLine.length <= COMMAND_LINE_PREVIEW_LENGTH) {
        return `<code class="cmd">${escapeHtml(commandLine)}</code>`;
    }
    return `<details><summary><code class="cmd">${escapeHtml(commandLine.slice(0, COMMAND_LINE_PREVIEW_LENGTH))}…</code></summary>`
        + `<code class="cmd">${escapeHtml(commandLine)}</code></details>`;
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
