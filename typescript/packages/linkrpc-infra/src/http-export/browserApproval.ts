/**
 * Browser approval for the http-export gateway.
 *
 * Each browser gets its own signing key, held by the gateway, and must have it approved once through
 * the Hub's consent flow (`hubAccess::requestAccess`), like any other consumer. The gateway then signs
 * that browser's `tcpForward` and port listing calls with the browser's key and granted capabilities,
 * so compute nodes authorize the browser, not the gateway.
 *
 * - The browser shows a code: the start of its key's principal ID. Approvers see the full principal
 *   ID in the request, which another requester cannot fake without that key.
 * - `localhost` holds the browser's session cookie; every service site (`<service>.localhost`) gets its
 *   own cookie through a single-use ticket handed over by `localhost`, since no cookie spans sites.
 * - Only browser requests need approval. Requests without `Sec-Fetch-*` and `Origin` headers (curl,
 *   scripts) keep using the gateway's own identity.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { KeypairSigningIdentity, type SerializedKeypairSigningIdentity, type SignedCapability, type SigningIdentity } from '@hediet/linkrpc';
import { computeNodePortsInterface, computeNodeTcpForwardInterface } from '../compute-node/index';
import { parseHttpExportHost, type ServiceReference } from './hostname';

/** The identity a request is forwarded with; absent for the gateway's own identity. */
export interface HttpExportCaller {
    readonly id: string;
    readonly signer: SigningIdentity;
    readonly capabilities: readonly SignedCapability[];
}

export type BrowserAccessResult =
    | { readonly status: 'granted'; readonly capabilities: readonly SignedCapability[] }
    | { readonly status: string; readonly reason?: string };

export interface BrowserAccessRequest {
    /** The browser's principal; the capability audience. */
    readonly principal: string;
    readonly name: string;
    readonly purpose: string;
    readonly permissions: readonly BrowserAccessPermission[];
}

export interface BrowserAccessPermission {
    readonly target: {
        readonly serviceId: { readonly prefix: string };
        readonly interfaceId: { readonly exact: string };
        readonly members: readonly { readonly exact: string }[];
    };
    readonly canInvoke: true;
}

export interface BrowserApprovalOptions {
    /** Sends `hubAccess::requestAccess` for another principal; resolves once an approver decided. */
    readonly requestAccess: (request: BrowserAccessRequest) => Promise<BrowserAccessResult>;
    /** Approved sessions survive restarts here. Contains private keys: keep it private to the user. */
    readonly stateFile?: string;
    /** Shown in the approval request, e.g. the gateway machine's name. */
    readonly gatewayName: string;
}

export interface BrowserApprovalServices {
    /** Resolves a hostname's service reference to its service ID. */
    readonly resolve: (reference: ServiceReference) => Promise<string | undefined>;
    /**
     * The service ID prefix a browser asks access for when it opens `target` (or `localhost` when
     * absent). It must not depend on how much of the directory has been discovered so far.
     */
    readonly scope: (target: string | undefined) => Promise<string>;
}

export const SESSION_COOKIE = 'linkrpc-gateway';
const STATE_COOKIE = 'linkrpc-gateway-state';
export const GATEWAY_PATH_PREFIX = '/.linkrpc/';
const LOGIN_PATH = '/.linkrpc/login';
const SESSION_PATH = '/.linkrpc/session';
const TICKET_TTL_MS = 30_000;
const STATE_TTL_SECONDS = 600;

type SessionStatus = 'pending' | 'approved' | 'denied';

interface Session {
    readonly id: string;
    readonly identity: KeypairSigningIdentity;
    status: SessionStatus;
    capabilities: readonly SignedCapability[];
    reason?: string;
    /** The service ID prefix the browser asked access for; unknown for sessions from older state files. */
    requestedScope?: string;
    /** The browser's `localhost` cookie, hashed. */
    readonly secretHash: string;
}

interface PersistedState {
    readonly version: 1;
    readonly sessions: readonly {
        readonly id: string;
        readonly secretHash: string;
        readonly identity: SerializedKeypairSigningIdentity;
        readonly capabilities: readonly SignedCapability[];
        readonly requestedScope?: string;
    }[];
    /** Hashed site cookie → session ID and site. */
    readonly siteTokens: readonly { readonly hash: string; readonly sessionId: string; readonly site: string }[];
}

export type ApprovalDecision =
    | { readonly kind: 'forward'; readonly caller?: HttpExportCaller }
    | { readonly kind: 'handled' };

export class BrowserApproval {
    private readonly _sessions = new Map<string, Session>();
    private readonly _sessionsBySecret = new Map<string, Session>();
    private readonly _siteTokens = new Map<string, { readonly sessionId: string; readonly site: string }>();
    private readonly _tickets = new Map<string, { readonly sessionId: string; readonly site: string; readonly expiresAt: number }>();
    private _saving: Promise<void> = Promise.resolve();

    private constructor(
        private readonly _options: BrowserApprovalOptions,
        private readonly _baseDomain: string,
        private readonly _services: BrowserApprovalServices,
    ) { }

    static async create(options: BrowserApprovalOptions, baseDomain: string, services: BrowserApprovalServices): Promise<BrowserApproval> {
        const approval = new BrowserApproval(options, baseDomain, services);
        await approval._load();
        return approval;
    }

    /**
     * Decides how to serve a request. Browser requests without an approved session are redirected
     * to the approval page (navigations) or rejected; `handled` means a response was sent.
     */
    async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<ApprovalDecision> {
        const site = this._site(request);
        const path = new URL(request.url ?? '/', 'http://x').pathname;
        if (path === LOGIN_PATH && site === this._baseDomain) {
            await this._login(request, response);
            return { kind: 'handled' };
        }
        if (path === SESSION_PATH) {
            this._acceptTicket(request, response, site);
            return { kind: 'handled' };
        }
        const session = this._sessionFor(request, site, await this._targetService(request.headers.host ?? ''));
        if (session) {
            return { kind: 'forward', caller: callerOf(session) };
        }
        const kind = requestKind(request);
        if (kind === 'tool') {
            return { kind: 'forward' };
        }
        if (kind === 'navigation') {
            this._redirectToLogin(request, response, site);
        } else {
            sendPage(response, 401, 'Browser not approved', '<h1>This browser is not approved yet</h1><p>Open the page directly to approve it.</p>');
        }
        return { kind: 'handled' };
    }

    /** For WebSocket upgrades: the caller, `undefined` for tools, or `'rejected'`. */
    async authorizeUpgrade(request: IncomingMessage): Promise<HttpExportCaller | undefined | 'rejected'> {
        const session = this._sessionFor(request, this._site(request), await this._targetService(request.headers.host ?? ''));
        if (session) {
            return callerOf(session);
        }
        return requestKind(request) === 'tool' ? undefined : 'rejected';
    }

    private _site(request: IncomingMessage): string {
        const parsed = parseHttpExportHost(request.headers.host ?? '', this._baseDomain);
        const hostname = hostnameOf(request.headers.host ?? '');
        if (parsed?.kind === 'service') {
            const labels = hostname.split('.');
            return labels.length > this._baseDomain.split('.').length + 1 ? labels.slice(1).join('.') : hostname;
        }
        return hostname;
    }

    /** The service a `<port>.<service>` or `<service>` host addresses; `undefined` for `localhost`. */
    private async _targetService(host: string): Promise<string | undefined> {
        const parsed = parseHttpExportHost(host, this._baseDomain);
        return parsed?.kind === 'service' ? this._services.resolve(parsed.service) : undefined;
    }

    /** An approved session for `site` whose grant covers `serviceId` (when given). */
    private _sessionFor(request: IncomingMessage, site: string, serviceId: string | undefined): Session | undefined {
        const token = readCookie(request, SESSION_COOKIE);
        if (!token) {
            return undefined;
        }
        const session = site === this._baseDomain
            ? this._sessionsBySecret.get(hash(token))
            : (() => {
                const entry = this._siteTokens.get(hash(token));
                return entry?.site === site ? this._sessions.get(entry.sessionId) : undefined;
            })();
        return session?.status === 'approved' && hasFreshCapability(session) && (serviceId === undefined || covers(session, serviceId)) ? session : undefined;
    }

    private _redirectToLogin(request: IncomingMessage, response: ServerResponse, site: string): void {
        const current = `http://${request.headers.host}${request.url ?? '/'}`;
        const login = new URL(`http://${this._baseDomain}${portSuffix(request)}${LOGIN_PATH}`);
        login.searchParams.set('return', current);
        const headers: Record<string, string | string[]> = { location: login.href, 'cache-control': 'no-store' };
        if (site !== this._baseDomain) {
            const state = randomToken();
            login.searchParams.set('state', state);
            headers.location = login.href;
            headers['set-cookie'] = `${STATE_COOKIE}=${state}; Path=${SESSION_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`;
        }
        response.writeHead(302, headers);
        response.end();
    }

    private async _login(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const query = new URL(request.url ?? '/', 'http://x').searchParams;
        const returnUrl = this._validReturn(query.get('return'), request);
        const state = query.get('state') ?? undefined;
        const secret = readCookie(request, SESSION_COOKIE);
        let session = secret ? this._sessionsBySecret.get(hash(secret)) : undefined;
        const setCookie: string[] = [];
        const direct = request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'none' || request.headers['sec-fetch-site'] === 'same-origin';
        const target = await this._targetService(returnUrl.host);
        const wantedScope = await this._services.scope(target).catch(() => undefined);
        const uncovered = session?.status === 'approved' && (!hasFreshCapability(session) || (target !== undefined && !covers(session, target)));
        // An approver may grant less than requested; ask again automatically only for a different scope.
        const narrowed = uncovered && session?.requestedScope !== undefined && session.requestedScope === wantedScope;
        const retry = query.get('retry') === '1' && direct && (session?.status === 'denied' || narrowed);
        if (!session || retry || (uncovered && !narrowed)) {
            const created = await this._startSession(session, target, wantedScope);
            session = created.session;
            setCookie.push(`${SESSION_COOKIE}=${created.secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
        }
        if (session.status === 'approved' && !(narrowed && !retry)) {
            return this._handOff(response, session, returnUrl, state, setCookie);
        }
        const code = codeOf(session);
        const retryUrl = new URL(`http://${request.headers.host}${request.url}`);
        retryUrl.searchParams.set('retry', '1');
        const body = session.status === 'pending'
            ? `<h1>Waiting for approval</h1>
               <p class="code">${escapeHtml(code)}</p>
               <p>Approve this browser on any approver, e.g. <code>linkrpc hub approval ui</code>.
               Only approve a request whose principal starts with <code>id:key:${escapeHtml(code.replace('-', ''))}</code>.</p>
               <p class="note">It asks to open forwarded ports of <code>${escapeHtml(session.requestedScope ? `${session.requestedScope}/*` : 'all services')}</code> through ${escapeHtml(this._options.gatewayName)}. This page continues by itself.</p>`
            : session.status === 'approved'
                ? `<h1>Not approved for this machine</h1><p class="code">${escapeHtml(code)}</p>
                   <p>This browser was approved for fewer services than it asked for, which do not include <code>${escapeHtml(target ?? '')}</code>.</p>
                   <p><a href="${escapeHtml(retryUrl.href)}">Ask again</a></p>`
                : `<h1>Not approved</h1><p class="code">${escapeHtml(code)}</p>
                   <p>${escapeHtml(session.reason ?? 'The request was denied.')}</p>
                   <p><a href="${escapeHtml(retryUrl.href)}">Ask again</a></p>`;
        sendPage(response, 200, session.status === 'pending' ? `Approve ${code}` : 'Not approved', body, {
            ...(session.status === 'pending' ? { refresh: '2' } : {}),
            ...(setCookie.length ? { 'set-cookie': setCookie } : {}),
        });
    }

    private _handOff(response: ServerResponse, session: Session, returnUrl: URL, state: string | undefined, setCookie: readonly string[]): void {
        const headers: Record<string, string | readonly string[]> = { 'cache-control': 'no-store', ...(setCookie.length ? { 'set-cookie': setCookie } : {}) };
        const site = this._siteOfHost(returnUrl.host);
        if (site === this._baseDomain || !state) {
            response.writeHead(302, { ...headers, location: site === this._baseDomain ? returnUrl.href : `http://${this._baseDomain}${returnUrl.port ? `:${returnUrl.port}` : ''}/` });
            response.end();
            return;
        }
        const ticket = randomToken();
        this._tickets.set(ticket, { sessionId: session.id, site, expiresAt: Date.now() + TICKET_TTL_MS });
        const target = new URL(`http://${returnUrl.host}${SESSION_PATH}`);
        target.searchParams.set('ticket', ticket);
        target.searchParams.set('state', state);
        target.searchParams.set('return', `${returnUrl.pathname}${returnUrl.search}`);
        response.writeHead(302, { ...headers, location: target.href });
        response.end();
    }

    private _acceptTicket(request: IncomingMessage, response: ServerResponse, site: string): void {
        const query = new URL(request.url ?? '/', 'http://x').searchParams;
        const ticketId = query.get('ticket') ?? '';
        const ticket = this._tickets.get(ticketId);
        this._tickets.delete(ticketId);
        const state = readCookie(request, STATE_COOKIE);
        const returnPath = query.get('return') ?? '/';
        if (!ticket || ticket.expiresAt < Date.now() || ticket.site !== site || !state || state !== query.get('state') || !returnPath.startsWith('/') || returnPath.startsWith('//')) {
            sendPage(response, 403, 'Approval handoff failed', '<h1>Approval handoff failed</h1><p>Reload the page you came from to try again.</p>');
            return;
        }
        const token = randomToken();
        this._siteTokens.set(hash(token), { sessionId: ticket.sessionId, site });
        this._save();
        response.writeHead(302, {
            location: returnPath,
            'cache-control': 'no-store',
            'set-cookie': [
                `${SESSION_COOKIE}=${token}; Domain=${site}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000`,
                `${STATE_COOKIE}=; Path=${SESSION_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
            ],
        });
        response.end();
    }

    private async _startSession(previous: Session | undefined, target: string | undefined, scope: string | undefined): Promise<{ session: Session; secret: string }> {
        if (previous) {
            this._sessions.delete(previous.id);
            this._sessionsBySecret.delete(previous.secretHash);
        }
        const secret = randomToken();
        const session: Session = {
            id: randomToken(),
            identity: await KeypairSigningIdentity.generateNew(),
            status: 'pending',
            capabilities: [],
            secretHash: hash(secret),
            ...(scope === undefined ? {} : { requestedScope: scope }),
        };
        this._sessions.set(session.id, session);
        this._sessionsBySecret.set(session.secretHash, session);
        void this._request(session, target);
        return { session, secret };
    }

    private async _request(session: Session, target: string | undefined): Promise<void> {
        const code = codeOf(session);
        try {
            const prefix = session.requestedScope ?? await this._services.scope(target);
            session.requestedScope = prefix;
            const result = await this._options.requestAccess({
                principal: session.identity.publicSigningIdentity.principal,
                name: `Browser ${code} via http-export on ${this._options.gatewayName}`,
                purpose: `Open forwarded ports of ${prefix ? `${prefix}/*` : 'all'} compute nodes in a browser. The browser shows the code ${code}.`,
                permissions: [
                    permission(prefix, computeNodeTcpForwardInterface.info.id, 'multiplex'),
                    permission(prefix, computeNodePortsInterface.info.id, 'listListening'),
                ],
            });
            if (result.status === 'granted' && 'capabilities' in result && result.capabilities.length > 0) {
                session.capabilities = result.capabilities;
                session.status = 'approved';
                this._save();
            } else {
                session.status = 'denied';
                session.reason = 'reason' in result && result.reason ? `Denied: ${result.reason}` : undefined;
            }
        } catch (error) {
            session.status = 'denied';
            session.reason = `The approval request failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private _validReturn(value: string | null, request: IncomingMessage): URL {
        const fallback = new URL(`http://${this._baseDomain}${portSuffix(request)}/`);
        try {
            const url = new URL(value ?? '');
            return url.protocol === 'http:' && parseHttpExportHost(url.host, this._baseDomain) && url.port === fallback.port ? url : fallback;
        } catch {
            return fallback;
        }
    }

    private _siteOfHost(host: string): string {
        return this._site({ headers: { host } } as IncomingMessage);
    }

    private async _load(): Promise<void> {
        if (!this._options.stateFile) {
            return;
        }
        let state: PersistedState;
        try {
            state = JSON.parse(await readFile(this._options.stateFile, 'utf8'));
        } catch {
            return;
        }
        for (const entry of state.sessions ?? []) {
            const session: Session = {
                id: entry.id,
                identity: KeypairSigningIdentity.fromJson(entry.identity),
                status: 'approved',
                capabilities: entry.capabilities,
                secretHash: entry.secretHash,
                ...(entry.requestedScope === undefined ? {} : { requestedScope: entry.requestedScope }),
            };
            this._sessions.set(session.id, session);
            this._sessionsBySecret.set(session.secretHash, session);
        }
        for (const token of state.siteTokens ?? []) {
            if (this._sessions.has(token.sessionId)) {
                this._siteTokens.set(token.hash, { sessionId: token.sessionId, site: token.site });
            }
        }
    }

    private _save(): void {
        const file = this._options.stateFile;
        if (!file) {
            return;
        }
        const approved = [...this._sessions.values()].filter(session => session.status === 'approved');
        const state: PersistedState = {
            version: 1,
            sessions: approved.map(session => ({ id: session.id, secretHash: session.secretHash, identity: session.identity.toJson(), capabilities: session.capabilities, ...(session.requestedScope === undefined ? {} : { requestedScope: session.requestedScope }) })),
            siteTokens: [...this._siteTokens].filter(([, entry]) => this._sessions.get(entry.sessionId)?.status === 'approved').map(([tokenHash, entry]) => ({ hash: tokenHash, ...entry })),
        };
        this._saving = this._saving.then(async () => {
            await mkdir(dirname(file), { recursive: true });
            const temporary = `${file}.${process.pid}.tmp`;
            await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
            await rename(temporary, file);
        }).catch(() => { /* the next save retries */ });
    }
}

function permission(prefix: string, interfaceId: string, member: string): BrowserAccessPermission {
    return { target: { serviceId: { prefix }, interfaceId: { exact: interfaceId }, members: [{ exact: member }] }, canInvoke: true };
}

/** The first eight characters of the key, as approvers see them in the principal `id:key:<key>`. */
export function codeOf(session: { readonly identity: SigningIdentity }): string {
    const key = session.identity.publicSigningIdentity.principal.replace(/^id:key:/, '');
    return `${key.slice(0, 4)}-${key.slice(4, 8)}`;
}

function callerOf(session: Session): HttpExportCaller {
    return { id: session.id, signer: session.identity, capabilities: session.capabilities };
}

function hasFreshCapability(session: Session): boolean {
    const now = Date.now();
    return session.capabilities.some(capability => capability.expiresAtMs === undefined || capability.expiresAtMs > now + 5_000);
}

/** Whether the session's grant addresses `serviceId`; prefixes match whole `/` segments, as the Hub matches them. */
function covers(session: Session, serviceId: string): boolean {
    return session.capabilities.some(capability => capability.permissions.some(permission => {
        const pattern = permission.target.serviceId;
        if ('exact' in pattern) {
            return pattern.exact === serviceId;
        }
        return pattern.prefix === '' || serviceId === pattern.prefix || serviceId.startsWith(`${pattern.prefix}/`);
    }));
}

/** Navigations may be redirected to approve; other browser requests are rejected; tools pass. */
function requestKind(request: IncomingMessage): 'navigation' | 'browser' | 'tool' {
    const mode = request.headers['sec-fetch-mode'];
    if (mode === 'navigate' && (request.headers['sec-fetch-dest'] ?? 'document') === 'document') {
        return 'navigation';
    }
    return mode !== undefined || request.headers['sec-fetch-site'] !== undefined || request.headers.origin !== undefined ? 'browser' : 'tool';
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
    for (const part of (request.headers.cookie ?? '').split(';')) {
        const separator = part.indexOf('=');
        if (separator > 0 && part.slice(0, separator).trim() === name) {
            return part.slice(separator + 1).trim();
        }
    }
    return undefined;
}

function hostnameOf(host: string): string {
    return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function portSuffix(request: IncomingMessage): string {
    const port = /:(\d+)$/.exec(request.headers.host ?? '')?.[1];
    return port && port !== '80' ? `:${port}` : '';
}

function randomToken(): string {
    return randomBytes(24).toString('base64url');
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('base64url');
}

function sendPage(response: ServerResponse, status: number, title: string, body: string, headers: Record<string, string | readonly string[]> = {}): void {
    response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        ...headers,
    });
    response.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
        + '<style>body{font:15px system-ui,sans-serif;margin:3em auto;max-width:42em;color-scheme:light dark}'
        + '.code{font:600 2.4em ui-monospace,monospace;letter-spacing:.08em;margin:.4em 0}.note{opacity:.7}</style>'
        + body);
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}
