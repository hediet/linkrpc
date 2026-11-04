/**
 * Browser approval for the http-export gateway.
 *
 * Each browser gets its own signing key, held by the gateway. Before a browser opens ports of a
 * service, it chooses a port range for that service, and an approver grants that range through the
 * Hub's consent flow (`hubAccess::requestAccess`), like any other consumer. The capability names the
 * exact service and bounds the forwarded and listed ports, so compute nodes enforce the range, not
 * just the gateway. The gateway signs the browser's `tcpForward` and port listing calls with the
 * browser's key and that service's capabilities. A browser holds one grant per service: asking for
 * another range of the same service replaces it.
 *
 * - The browser shows a code: the start of its key's principal ID. Approvers see the full principal
 *   ID in the request, which another requester cannot fake without that key.
 * - `localhost` holds the browser's session cookie; every service site (`<service>.localhost`) gets its
 *   own cookie through a single-use ticket handed over by `localhost`, since no cookie spans sites.
 * - Only browser requests need approval. Requests without `Sec-Fetch-*` and `Origin` headers (curl,
 *   scripts) keep using the gateway's own identity, so the list of services needs no approval either.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { KeypairSigningIdentity, type ParamMatcher, type SerializedKeypairSigningIdentity, type SignedCapability, type SigningIdentity } from '@hediet/linkrpc';
import { findCoveringCapabilities, type HubAccessPermission } from '@hediet/linkrpc/hub/common';
import { computeNodePortsInterface, computeNodeTcpForwardInterface, type ComputeNodePortRange } from '../compute-node/index';
import { parseHttpExportHost, type ServiceReference } from './hostname';
import { FORWARDED_HOST } from './tcpMultiplexer';

/** The identity a request is forwarded with; absent for the gateway's own identity. */
export interface HttpExportCaller {
    readonly id: string;
    readonly signer: SigningIdentity;
    readonly capabilities: readonly SignedCapability[];
    /** The ports of the service this caller may open and list. */
    readonly portRange: ComputeNodePortRange;
}

export type BrowserAccessResult =
    | { readonly status: 'granted'; readonly capabilities: readonly SignedCapability[] }
    | { readonly status: string; readonly reason?: string };

export interface BrowserAccessRequest {
    /** The browser's principal; the capability audience. */
    readonly principal: string;
    readonly name: string;
    readonly purpose: string;
    readonly permissions: readonly HubAccessPermission[];
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
}

export const SESSION_COOKIE = 'linkrpc-gateway';
const STATE_COOKIE = 'linkrpc-gateway-state';
export const GATEWAY_PATH_PREFIX = '/.linkrpc/';
const LOGIN_PATH = '/.linkrpc/login';
const SESSION_PATH = '/.linkrpc/session';
const TICKET_TTL_MS = 30_000;
const STATE_TTL_SECONDS = 600;
const MAX_FORM_BYTES = 8_192;
const MAX_PORT = 65_535;

interface Session {
    readonly id: string;
    readonly identity: KeypairSigningIdentity;
    /** The browser's `localhost` cookie, hashed. */
    readonly secretHash: string;
    /** The browser's grant per service ID. */
    readonly grants: Map<string, Grant>;
}

interface Grant {
    readonly id: string;
    readonly serviceId: string;
    readonly portRange: ComputeNodePortRange;
    status: 'pending' | 'approved' | 'denied';
    capabilities: readonly SignedCapability[];
    reason?: string;
}

interface PersistedState {
    readonly version: 2;
    readonly sessions: readonly {
        readonly id: string;
        readonly secretHash: string;
        readonly identity: SerializedKeypairSigningIdentity;
        readonly grants: readonly {
            readonly id: string;
            readonly serviceId: string;
            readonly portRange: ComputeNodePortRange;
            readonly capabilities: readonly SignedCapability[];
        }[];
    }[];
    /** Hashed site cookie → session ID and site. */
    readonly siteTokens: readonly { readonly hash: string; readonly sessionId: string; readonly site: string }[];
}

/** What a request addresses: a port of a service, or the list of its ports when `port` is absent. */
interface Target {
    readonly serviceId: string;
    readonly port?: number;
}

/** Form field values, kept as typed so an invalid entry can be shown again. */
interface RangeInput {
    readonly min: string;
    readonly max: string;
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
     * Decides how to serve a request. Browser requests to a service without an approved grant are
     * redirected to the approval page (navigations) or rejected; `handled` means a response was sent.
     */
    async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<ApprovalDecision> {
        const site = this._site(request);
        const path = new URL(request.url ?? '/', 'http://x').pathname;
        if (path === LOGIN_PATH && site === this._baseDomain) {
            await (request.method === 'POST' ? this._requestGrant(request, response) : this._login(request, response));
            return { kind: 'handled' };
        }
        if (path === SESSION_PATH) {
            this._acceptTicket(request, response, site);
            return { kind: 'handled' };
        }
        const target = await this._target(request.headers.host ?? '');
        if (!target) {
            return { kind: 'forward' };
        }
        const caller = this._caller(request, site, target);
        if (caller) {
            return { kind: 'forward', caller };
        }
        const kind = requestKind(request);
        if (kind === 'tool') {
            return { kind: 'forward' };
        }
        if (kind === 'navigation') {
            this._redirectToLogin(request, response, site);
        } else {
            sendPage(response, 401, 'Browser not approved', '<h1>This browser is not approved for this port</h1><p>Open the page directly to ask for approval.</p>');
        }
        return { kind: 'handled' };
    }

    /** For WebSocket upgrades: the caller, `undefined` for tools, or `'rejected'`. */
    async authorizeUpgrade(request: IncomingMessage): Promise<HttpExportCaller | undefined | 'rejected'> {
        const target = await this._target(request.headers.host ?? '');
        const caller = target && this._caller(request, this._site(request), target);
        if (caller) {
            return caller;
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

    /** What a `<port>.<service>` or `<service>` host addresses; `undefined` for `localhost` and unknown services. */
    private async _target(host: string): Promise<Target | undefined> {
        const parsed = parseHttpExportHost(host, this._baseDomain);
        if (parsed?.kind !== 'service') {
            return undefined;
        }
        const serviceId = await this._services.resolve(parsed.service);
        return serviceId === undefined ? undefined : { serviceId, ...(parsed.params.port === undefined ? {} : { port: parsed.params.port }) };
    }

    /** The caller of the browser's grant for the target service, when that grant covers the target. */
    private _caller(request: IncomingMessage, site: string, target: Target): HttpExportCaller | undefined {
        const session = this._sessionAt(request, site);
        const grant = session?.grants.get(target.serviceId);
        return session && grant && covers(session, grant, target.port) ? callerOf(session, grant) : undefined;
    }

    private _sessionAt(request: IncomingMessage, site: string): Session | undefined {
        const token = readCookie(request, SESSION_COOKIE);
        if (!token) {
            return undefined;
        }
        if (site === this._baseDomain) {
            return this._sessionsBySecret.get(hash(token));
        }
        const entry = this._siteTokens.get(hash(token));
        return entry?.site === site ? this._sessions.get(entry.sessionId) : undefined;
    }

    private _redirectToLogin(request: IncomingMessage, response: ServerResponse, site: string): void {
        const current = new URL(`http://${request.headers.host}${request.url ?? '/'}`);
        const headers: Record<string, string | string[]> = { 'cache-control': 'no-store' };
        let state: string | undefined;
        if (site !== this._baseDomain) {
            state = randomToken();
            headers['set-cookie'] = `${STATE_COOKIE}=${state}; Path=${SESSION_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL_SECONDS}`;
        }
        headers.location = this._loginUrl(request, current, state);
        response.writeHead(302, headers);
        response.end();
    }

    private _loginUrl(request: IncomingMessage, returnUrl: URL, state: string | undefined): string {
        const login = new URL(`http://${this._baseDomain}${portSuffix(request)}${LOGIN_PATH}`);
        login.searchParams.set('return', returnUrl.href);
        if (state) {
            login.searchParams.set('state', state);
        }
        return login.href;
    }

    private async _login(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const query = new URL(request.url ?? '/', 'http://x').searchParams;
        const returnUrl = this._validReturn(query.get('return'), request);
        const state = query.get('state') ?? undefined;
        const setCookie: string[] = [];
        let session = this._sessionAt(request, this._baseDomain);
        if (!session) {
            const created = await this._startSession();
            session = created.session;
            setCookie.push(`${SESSION_COOKIE}=${created.secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
        }
        const target = await this._target(returnUrl.host);
        const grant = target && session.grants.get(target.serviceId);
        if (!target || (grant && covers(session, grant, target.port))) {
            return this._handOff(response, session, returnUrl, state, setCookie);
        }
        if (grant?.status === 'pending') {
            const code = codeOf(session);
            return sendPage(response, 200, `Approve ${code}`, `<h1>Waiting for approval</h1>
                <p class="code">${escapeHtml(code)}</p>
                <p>Approve this browser on any approver, e.g. <code>linkrpc hub approval ui</code>.
                Only approve a request whose principal starts with <code>id:key:${escapeHtml(code.replace('-', ''))}</code>.</p>
                <p class="note">It asks to open ${escapeHtml(describePorts(grant.portRange))} of <code>${escapeHtml(grant.serviceId)}</code> through ${escapeHtml(this._options.gatewayName)}. This page continues by itself.</p>`,
            { refresh: '2', ...(setCookie.length ? { 'set-cookie': setCookie } : {}) });
        }
        this._sendForm(response, { session, target, grant, returnUrl, state, setCookie });
    }

    /** Asks for the port range the browser chose for a service, replacing its grant for that service. */
    private async _requestGrant(request: IncomingMessage, response: ServerResponse): Promise<void> {
        // Only the form on this page may ask approvers for access, not other sites.
        if (request.headers['sec-fetch-site'] !== 'same-origin') {
            return sendPage(response, 403, 'Request rejected', '<h1>Request rejected</h1><p>Ask for approval with the form on the approval page.</p>');
        }
        const form = await readForm(request);
        if (!form) {
            return sendPage(response, 413, 'Request rejected', '<h1>Request rejected</h1><p>The form is too large.</p>');
        }
        const returnUrl = this._validReturn(form.get('return'), request);
        const state = form.get('state') || undefined;
        const session = this._sessionAt(request, this._baseDomain);
        const target = await this._target(returnUrl.host);
        if (!session || !target) {
            response.writeHead(303, { location: this._loginUrl(request, returnUrl, state), 'cache-control': 'no-store' });
            response.end();
            return;
        }
        const input = { min: form.get('min') ?? '', max: form.get('max') ?? '' };
        const range = parsePortRange(input);
        const error = range === undefined
            ? `Enter ports from 1 to ${MAX_PORT}; the first must not exceed the second.`
            : target.port !== undefined && (target.port < range.min || target.port > range.max)
                ? `The range must include port ${target.port}, which you are opening.`
                : undefined;
        if (error !== undefined || range === undefined) {
            return this._sendForm(response, { session, target, grant: session.grants.get(target.serviceId), returnUrl, state, setCookie: [], error, input });
        }
        const grant: Grant = { id: randomToken(), serviceId: target.serviceId, portRange: range, status: 'pending', capabilities: [] };
        session.grants.set(target.serviceId, grant);
        void this._request(session, grant);
        response.writeHead(303, { location: this._loginUrl(request, returnUrl, state), 'cache-control': 'no-store' });
        response.end();
    }

    private _sendForm(response: ServerResponse, options: {
        readonly session: Session;
        readonly target: Target;
        readonly grant: Grant | undefined;
        readonly returnUrl: URL;
        readonly state: string | undefined;
        readonly setCookie: readonly string[];
        readonly error?: string;
        readonly input?: RangeInput;
    }): void {
        const { session, target, grant } = options;
        const code = codeOf(session);
        const input = options.input ?? suggestedInput(target, grant);
        const status = options.error !== undefined
            ? `<p class="error">${escapeHtml(options.error)}</p>`
            : grant?.status === 'denied'
                ? `<p>The last request was not approved${grant.reason ? `: ${escapeHtml(grant.reason)}` : '.'}</p>`
                : grant?.status === 'approved'
                    ? `<p>This browser ${covers(session, grant, undefined) ? 'may open' : 'had an approval, now expired, for'} ${escapeHtml(describePorts(grant.portRange))} of this service. A new approval replaces it.</p>`
                    : '';
        const field = (name: keyof RangeInput) => `<input name="${name}" type="number" min="1" max="${MAX_PORT}" required value="${escapeHtml(input[name])}">`;
        sendPage(response, options.error === undefined ? 200 : 400, 'Approve this browser', `<h1>Open ports of <code>${escapeHtml(target.serviceId)}</code></h1>
            <p class="code">${escapeHtml(code)}</p>
            ${status}
            <form method="post" action="${LOGIN_PATH}">
                <input type="hidden" name="return" value="${escapeHtml(options.returnUrl.href)}">
                ${options.state ? `<input type="hidden" name="state" value="${escapeHtml(options.state)}">` : ''}
                <p><label>Ports ${field('min')}</label> <label>to ${field('max')}</label></p>
                <p><button type="submit">Ask for approval</button></p>
            </form>
            <p class="note">This browser can only open and list the ports in this range. Approvers see a request from a principal starting with <code>id:key:${escapeHtml(code.replace('-', ''))}</code>.</p>`,
        options.setCookie.length ? { 'set-cookie': options.setCookie } : {}, { allowForm: true });
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

    private async _startSession(): Promise<{ session: Session; secret: string }> {
        const secret = randomToken();
        const session: Session = {
            id: randomToken(),
            identity: await KeypairSigningIdentity.generateNew(),
            secretHash: hash(secret),
            grants: new Map(),
        };
        this._sessions.set(session.id, session);
        this._sessionsBySecret.set(session.secretHash, session);
        return { session, secret };
    }

    private async _request(session: Session, grant: Grant): Promise<void> {
        const code = codeOf(session);
        try {
            const result = await this._options.requestAccess({
                principal: session.identity.publicSigningIdentity.principal,
                name: `Browser ${code} via http-export on ${this._options.gatewayName}`,
                purpose: `Open ${describePorts(grant.portRange)} of ${grant.serviceId} in a browser. The browser shows the code ${code}.`,
                permissions: [
                    forwardPermission(grant.serviceId, { range: grant.portRange }),
                    listPermission(grant.serviceId, grant.portRange),
                ],
            });
            if (result.status === 'granted' && 'capabilities' in result && result.capabilities.length > 0) {
                grant.capabilities = result.capabilities;
                grant.status = 'approved';
                this._save();
            } else {
                grant.status = 'denied';
                grant.reason = 'reason' in result && result.reason ? result.reason : undefined;
            }
        } catch (error) {
            grant.status = 'denied';
            grant.reason = `the approval request failed: ${error instanceof Error ? error.message : String(error)}`;
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
        // Sessions of earlier versions were approved for whole namespaces; their browsers ask again.
        if (state.version !== 2) {
            return;
        }
        for (const entry of state.sessions) {
            const session: Session = {
                id: entry.id,
                identity: KeypairSigningIdentity.fromJson(entry.identity),
                secretHash: entry.secretHash,
                grants: new Map(entry.grants.map(grant => [grant.serviceId, { ...grant, status: 'approved' as const }])),
            };
            this._sessions.set(session.id, session);
            this._sessionsBySecret.set(session.secretHash, session);
        }
        for (const token of state.siteTokens) {
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
        const sessions = [...this._sessions.values()]
            .map(session => ({ session, grants: [...session.grants.values()].filter(grant => grant.status === 'approved') }))
            .filter(({ grants }) => grants.length > 0);
        const saved = new Set(sessions.map(({ session }) => session.id));
        const state: PersistedState = {
            version: 2,
            sessions: sessions.map(({ session, grants }) => ({
                id: session.id,
                secretHash: session.secretHash,
                identity: session.identity.toJson(),
                grants: grants.map(grant => ({ id: grant.id, serviceId: grant.serviceId, portRange: grant.portRange, capabilities: grant.capabilities })),
            })),
            siteTokens: [...this._siteTokens].filter(([, entry]) => saved.has(entry.sessionId)).map(([tokenHash, entry]) => ({ hash: tokenHash, ...entry })),
        };
        this._saving = this._saving.then(async () => {
            await mkdir(dirname(file), { recursive: true });
            const temporary = `${file}.${process.pid}.tmp`;
            await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
            await rename(temporary, file);
        }).catch(() => { /* the next save retries */ });
    }
}

/** Forwarding to the service's loopback ports that `port` matches. */
function forwardPermission(serviceId: string, port: ParamMatcher): HubAccessPermission {
    return {
        target: { serviceId: { exact: serviceId }, interfaceId: { exact: computeNodeTcpForwardInterface.info.id }, members: [{ exact: 'multiplex' }] },
        canInvoke: true,
        params: { host: { exact: FORWARDED_HOST }, port },
    };
}

/** Listing the service's ports within `portRange`; the gateway always passes that range. */
function listPermission(serviceId: string, portRange: ComputeNodePortRange): HubAccessPermission {
    return {
        target: { serviceId: { exact: serviceId }, interfaceId: { exact: computeNodePortsInterface.info.id }, members: [{ exact: 'listListening' }] },
        canInvoke: true,
        params: { portRange: { exact: { min: portRange.min, max: portRange.max } } },
    };
}

/**
 * Whether the grant's capabilities still permit opening `port`, or listing the grant's range when
 * `port` is absent. The approver may have granted less than requested.
 */
function covers(session: Session, grant: Grant, port: number | undefined): boolean {
    if (grant.status !== 'approved') {
        return false;
    }
    const needed = port === undefined ? listPermission(grant.serviceId, grant.portRange) : forwardPermission(grant.serviceId, { exact: port });
    return findCoveringCapabilities(grant.capabilities, [needed], {
        audience: session.identity.publicSigningIdentity.principal,
        freshnessMarginMs: 5_000,
    }) !== undefined;
}

/** The range shown in the form: the opened port, widened by the ports approved before. */
function suggestedInput(target: Target, grant: Grant | undefined): RangeInput {
    const previous = grant?.portRange;
    if (target.port === undefined) {
        return previous ? { min: String(previous.min), max: String(previous.max) } : { min: '', max: '' };
    }
    return grant?.status === 'approved' && previous
        ? { min: String(Math.min(previous.min, target.port)), max: String(Math.max(previous.max, target.port)) }
        : { min: String(target.port), max: String(target.port) };
}

function parsePortRange(input: RangeInput): ComputeNodePortRange | undefined {
    const parse = (value: string) => /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : undefined;
    const min = parse(input.min);
    const max = parse(input.max);
    return min !== undefined && max !== undefined && min >= 1 && max <= MAX_PORT && min <= max ? { min, max } : undefined;
}

function describePorts(range: ComputeNodePortRange): string {
    return range.min === range.max ? `port ${range.min}` : `ports ${range.min}–${range.max}`;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
    let body = '';
    for await (const chunk of request) {
        body += String(chunk);
        if (body.length > MAX_FORM_BYTES) {
            return undefined;
        }
    }
    return new URLSearchParams(body);
}

/** The first eight characters of the key, as approvers see them in the principal `id:key:<key>`. */
export function codeOf(session: { readonly identity: SigningIdentity }): string {
    const key = session.identity.publicSigningIdentity.principal.replace(/^id:key:/, '');
    return `${key.slice(0, 4)}-${key.slice(4, 8)}`;
}

function callerOf(session: Session, grant: Grant): HttpExportCaller {
    return { id: `${session.id}/${grant.id}`, signer: session.identity, capabilities: grant.capabilities, portRange: grant.portRange };
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

function sendPage(response: ServerResponse, status: number, title: string, body: string, headers: Record<string, string | readonly string[]> = {}, options: { readonly allowForm?: boolean } = {}): void {
    response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action ${options.allowForm ? "'self'" : "'none'"}`,
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        ...headers,
    });
    response.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
        + '<style>body{font:15px system-ui,sans-serif;margin:3em auto;max-width:42em;color-scheme:light dark}'
        + '.code{font:600 2.4em ui-monospace,monospace;letter-spacing:.08em;margin:.4em 0}.note{opacity:.7}.error{color:#c33}'
        + 'input[type=number]{width:7em}</style>'
        + body);
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}
