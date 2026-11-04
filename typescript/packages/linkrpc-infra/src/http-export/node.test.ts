import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LinkRpcConnection, TransportPair, type SignedCapability } from '@hediet/linkrpc';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { computeNodeTcpForwardInterface } from '../compute-node/index';
import { registerComputeNode } from '../compute-node/node';
import { codeOf, startHttpExport, type BrowserAccessRequest, type BrowserAccessResult, type HttpExport, type HttpExportOptions } from './node';

const serviceId = 'test/compute';
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

describe('http export', () => {
    it('forwards HTTP requests as the target would see them from a browser on its own machine', async () => {
        const targetPort = await startTarget((incoming, response) => {
            if (incoming.url === '/redirect') {
                response.writeHead(302, { location: `http://localhost:${targetPort}/landing` });
                response.end();
                return;
            }
            let body = '';
            incoming.on('data', chunk => { body += chunk; });
            incoming.on('end', () => {
                response.setHeader('set-cookie', ['shared=1; Domain=localhost; Path=/', 'foreign=2; Domain=example.com', 'hostOnly=3', '__Host-strict=4; Path=/']);
                response.setHeader('access-control-allow-origin', `http://localhost:${targetPort}`);
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({
                    method: incoming.method,
                    url: incoming.url,
                    host: incoming.headers.host,
                    origin: incoming.headers.origin,
                    referer: incoming.headers.referer,
                    forwardedHost: incoming.headers['x-forwarded-host'],
                    body,
                }));
            });
        });
        const gatewayPort = await startGateway();
        const host = `${targetPort}.test--compute.localhost:${gatewayPort}`;
        const echo = async (headers: Record<string, string>) => {
            const response = await send(gatewayPort, { host, method: 'POST', path: '/echo?x=1', body: 'hello', headers });
            return { ...JSON.parse(response.body), cookies: response.headers['set-cookie'], allowOrigin: response.headers['access-control-allow-origin'] };
        };
        const redirected = await send(gatewayPort, { host, path: '/redirect' });
        expect({
            sameService: await echo({ origin: `http://4000.test--compute.localhost:${gatewayPort}`, referer: `http://${host}/page?q=1` }),
            otherService: (({ origin, referer }) => ({ origin, referer }))(await echo({ origin: `http://5000.other--compute.localhost:${gatewayPort}`, referer: `http://5000.other--compute.localhost:${gatewayPort}/page` })),
            thisMachine: (({ origin, referer }) => ({ origin, referer }))(await echo({ origin: 'http://localhost:5173', referer: 'http://127.0.0.1:5173/page' })),
            foreign: (({ origin, referer }) => ({ origin, referer }))(await echo({ origin: 'https://example.com', referer: 'https://example.com/page' })),
            redirect: { status: redirected.status, location: redirected.headers.location },
        }).toEqual({
            sameService: {
                method: 'POST',
                url: '/echo?x=1',
                host: `localhost:${targetPort}`,
                origin: 'http://localhost:4000',
                referer: `http://localhost:${targetPort}/page?q=1`,
                body: 'hello',
                cookies: ['shared=1; Path=/; Domain=test--compute.localhost', 'hostOnly=3; Domain=test--compute.localhost', '__Host-strict=4; Path=/'],
                allowOrigin: `http://${host}`,
            },
            otherService: { origin: `http://5000.other--compute.localhost:${gatewayPort}`, referer: `http://5000.other--compute.localhost:${gatewayPort}/page` },
            thisMachine: { origin: 'null' },
            foreign: { origin: 'https://example.com', referer: 'https://example.com/page' },
            redirect: { status: 302, location: `http://${host}/landing` },
        });
    });

    it('forwards WebSocket upgrades, translating both heads', async () => {
        const targetPort = await startTarget((_request, response) => response.end());
        const target = cleanupServer(new WebSocketServer({ server: targets.at(-1)! }));
        target.on('headers', headers => headers.push('Set-Cookie: session=1; Domain=localhost'));
        target.on('connection', (socket, request) => socket.on('message', () => socket.send(JSON.stringify({ host: request.headers.host, origin: request.headers.origin }))));
        const gatewayPort = await startGateway();
        const host = `${targetPort}.test--compute.localhost:${gatewayPort}`;
        const client = new WebSocket(`ws://127.0.0.1:${gatewayPort}/socket`, { headers: { host }, origin: `http://${host}` });
        cleanups.push(() => client.terminate());
        let cookie: string[] | undefined;
        client.on('upgrade', response => { cookie = response.headers['set-cookie']; });
        await once(client, 'open');
        client.send('ping');
        const [reply] = await once(client, 'message');
        expect({ seen: JSON.parse(reply.toString()), cookie }).toEqual({
            seen: { host: `localhost:${targetPort}`, origin: `http://localhost:${targetPort}` },
            cookie: ['session=1; Domain=test--compute.localhost'],
        });
    });

    it('passes cross-site requests through, rejects unknown hosts, and lists services and ports', async () => {
        const targetPort = await startTarget((_request, response) => response.end('target'));
        const gatewayPort = await startGateway();
        const forwarded = `${targetPort}.test--compute.localhost:${gatewayPort}`;
        const results = await Promise.all([
            send(gatewayPort, { host: forwarded, headers: { 'sec-fetch-site': 'cross-site', origin: 'https://other.example' } }),
            send(gatewayPort, { host: `example.com:${gatewayPort}` }),
            send(gatewayPort, { host: `localhost:${gatewayPort}`, headers: { accept: 'application/json' } }),
            send(gatewayPort, { host: `test--compute.localhost:${gatewayPort}`, headers: { accept: 'application/json' } }),
        ]);
        expect(results.map(result => result.status)).toEqual([200, 421, 200, 200]);
        expect({
            crossSite: results[0].body,
            services: JSON.parse(results[2].body),
            ports: JSON.parse(results[3].body),
        }).toEqual({
            crossSite: 'target',
            services: { services: [{ serviceId, url: `http://test--compute.localhost:${gatewayPort}/` }], complete: true },
            ports: { serviceId, ports: [{ port: targetPort, addresses: ['127.0.0.1'], commandLine: 'node server.js --token <secret>', cwd: '/srv/app', url: `http://${targetPort}.test--compute.localhost:${gatewayPort}/` }] },
        });
    });

    it('answers 502 when the target port is not listening', async () => {
        const gatewayPort = await startGateway();
        const unused = await unusedPort();
        const response = await send(gatewayPort, { host: `${unused}.test--compute.localhost:${gatewayPort}` });
        expect(response.status).toBe(502);
    });

    it('serves gateway pages only to navigations, same-origin requests, and non-browser clients', async () => {
        await startTarget((_request, response) => response.end('target'));
        const gatewayPort = await startGateway();
        const pages = `test--compute.localhost:${gatewayPort}`;
        const forwardedApp = `http://4000.test--compute.localhost:${gatewayPort}`;
        const cases: Record<string, { host?: string; method?: string; headers?: Record<string, string> }> = {
            nonBrowser: {},
            typedInAddressBar: { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } },
            linkFromServiceIndex: { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } },
            sameOriginFetch: { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } },
            forwardedAppFetch: { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: forwardedApp } },
            forwardedAppNoCors: { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } },
            otherSiteIframe: { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } },
            otherSiteFetchIndex: { host: `localhost:${gatewayPort}`, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: 'https://evil.example' } },
            legacyCrossOrigin: { headers: { origin: 'https://evil.example' } },
            post: { method: 'POST' },
        };
        const results = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([name, request]) => {
            const response = await send(gatewayPort, { host: request.host ?? pages, method: request.method, headers: { accept: 'application/json', ...request.headers } });
            return [name, response] as const;
        })));
        const page = results.nonBrowser;
        expect({
            statuses: Object.fromEntries(Object.entries(results).map(([name, response]) => [name, response.status])),
            headers: {
                allowOrigin: page.headers['access-control-allow-origin'],
                frameOptions: page.headers['x-frame-options'],
                csp: page.headers['content-security-policy'],
                resourcePolicy: page.headers['cross-origin-resource-policy'],
                nosniff: page.headers['x-content-type-options'],
            },
            port: JSON.parse(page.body).ports[0],
        }).toEqual({
            statuses: {
                nonBrowser: 200, typedInAddressBar: 200, linkFromServiceIndex: 200, sameOriginFetch: 200,
                forwardedAppFetch: 403, forwardedAppNoCors: 403, otherSiteIframe: 403, otherSiteFetchIndex: 403, legacyCrossOrigin: 403, post: 405,
            },
            headers: {
                allowOrigin: undefined,
                frameOptions: 'DENY',
                csp: "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
                resourcePolicy: 'same-origin',
                nosniff: 'nosniff',
            },
            port: expect.objectContaining({ commandLine: 'node server.js --token <secret>', cwd: '/srv/app' }),
        });
        const html = await send(gatewayPort, { host: pages });
        expect(html.body).toContain('<code class="cmd">node server.js --token &#60;secret&#62;</code>');
    });

    it('asks approval for the port range a browser chooses, and hands the approval to each site', async () => {
        const seenCookies: (string | undefined)[] = [];
        const targetPort = await startTarget((incoming, response) => {
            seenCookies.push(incoming.headers.cookie);
            response.end(`page ${incoming.url}`);
        });
        const requests: BrowserAccessRequest[] = [];
        let approve: (result: BrowserAccessResult) => void = () => { };
        const stateFile = join(mkdtempSync(join(tmpdir(), 'http-export-approval-')), 'sessions.json');
        cleanups.push(() => rmSync(dirname(stateFile), { recursive: true, force: true }));
        const callers: (string | undefined)[] = [];
        const listedRanges: unknown[] = [];
        const approval = {
            gatewayName: 'test-machine',
            stateFile,
            requestAccess: (request: BrowserAccessRequest) => {
                requests.push(request);
                return new Promise<BrowserAccessResult>(resolve => { approve = resolve; });
            },
        };
        const outsidePort = targetPort === 65_535 ? targetPort - 10 : targetPort + 1;
        const listPorts: HttpExportOptions['listPorts'] = async (_serviceId, caller) => {
            listedRanges.push(caller?.portRange);
            return [targetPort, outsidePort].map(port => ({ port, addresses: ['127.0.0.1'] }));
        };
        const gatewayPort = await startGateway({ approval, listPorts }, callers);
        const site = `${targetPort}.test--compute.localhost:${gatewayPort}`;
        const navigate = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
        const fetchHeaders = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
        const range = { min: Math.max(1, targetPort - 5), max: targetPort };

        const first = await send(gatewayPort, { host: site, path: '/page?x=1', headers: navigate });
        const login = new URL(first.headers.location!);
        const stateCookie = cookiePair(first.headers['set-cookie'], 'linkrpc-gateway-state');
        const openLogin = (cookie?: string) => send(gatewayPort, { host: login.host, path: `${login.pathname}${login.search}`, headers: { ...navigate, ...(cookie ? { cookie } : {}) } });
        const form = await openLogin();
        const sessionCookie = cookiePair(form.headers['set-cookie'], 'linkrpc-gateway');
        const submit = (fields: Record<string, string>, fetchSite = 'same-origin') => send(gatewayPort, {
            host: login.host, method: 'POST', path: login.pathname, body: new URLSearchParams({ return: login.searchParams.get('return')!, state: login.searchParams.get('state')!, ...fields }).toString(),
            headers: { 'sec-fetch-site': fetchSite, 'sec-fetch-mode': 'navigate', 'content-type': 'application/x-www-form-urlencoded', cookie: sessionCookie },
        });
        const crossSite = await submit({ min: '1', max: '65535' }, 'cross-site');
        const submitted = await submit({ min: String(range.min), max: String(range.max) });
        const waiting = await openLogin(sessionCookie);
        await waitFor(() => requests.length === 1);
        const code = codeOf({ identity: { publicSigningIdentity: { principal: requests[0].principal } } } as unknown as Parameters<typeof codeOf>[0]);
        const beforeApproval = {
            fetch: (await send(gatewayPort, { host: site, path: '/api', headers: fetchHeaders })).status,
            tool: (await send(gatewayPort, { host: site, path: '/tool' })).body,
        };
        approve({ status: 'granted', capabilities: [fakeCapability(requests[0].principal, requests[0].permissions)] });
        await new Promise(resolve => setTimeout(resolve, 20));
        const approved = await openLogin(sessionCookie);
        const handoff = new URL(approved.headers.location!);
        const accepted = await send(gatewayPort, { host: handoff.host, path: `${handoff.pathname}${handoff.search}`, headers: { ...navigate, cookie: stateCookie } });
        const siteCookieHeader = accepted.headers['set-cookie']!.find(cookie => cookie.startsWith('linkrpc-gateway='))!;
        const siteCookie = cookiePair([siteCookieHeader], 'linkrpc-gateway');
        const page = await send(gatewayPort, { host: site, path: '/page?x=1', headers: { ...navigate, cookie: `${siteCookie}; app=1` } });
        const replayed = await send(gatewayPort, { host: handoff.host, path: `${handoff.pathname}${handoff.search}`, headers: { ...navigate, cookie: stateCookie } });
        const listed = await send(gatewayPort, { host: `test--compute.localhost:${gatewayPort}`, headers: { ...navigate, accept: 'application/json', cookie: siteCookie } });
        const outside = await send(gatewayPort, { host: `${outsidePort}.test--compute.localhost:${gatewayPort}`, headers: { ...navigate, cookie: siteCookie } });
        const outsideLogin = new URL(outside.headers.location!);
        const widen = await send(gatewayPort, { host: outsideLogin.host, path: `${outsideLogin.pathname}${outsideLogin.search}`, headers: { ...navigate, cookie: sessionCookie } });
        const sessionId = callers.at(-1);

        const restartedPort = await startGateway({ approval: { ...approval, requestAccess: async () => ({ status: 'denied' }) }, listPorts }, callers);
        const afterRestart = await send(restartedPort, { host: `${targetPort}.test--compute.localhost:${restartedPort}`, path: '/again', headers: { ...navigate, cookie: siteCookie } });

        expect({
            first: { status: first.status, login: `${login.host}${login.pathname}`, return: login.searchParams.get('return'), hasState: login.searchParams.get('state') === stateCookie.split('=')[1] },
            form: { status: form.status, suggests: form.body.includes(`value="${targetPort}"`), showsCode: form.body.includes('class="code"'), allowsForm: form.headers['content-security-policy']?.includes("form-action 'self'") },
            crossSite: crossSite.status,
            submitted: { status: submitted.status, location: submitted.headers.location === login.href },
            waiting: { status: waiting.status, showsCode: waiting.body.includes(code), refresh: waiting.headers.refresh },
            request: { name: requests[0].name, purpose: requests[0].purpose, permissions: requests[0].permissions },
            beforeApproval,
            handoff: { status: approved.status, host: handoff.host, path: handoff.pathname, return: handoff.searchParams.get('return') },
            siteCookie: siteCookieHeader.replace(/=[^;]+/, '=<token>'),
            accepted: { status: accepted.status, location: accepted.headers.location },
            page: { status: page.status, body: page.body },
            appSawCookies: seenCookies,
            signedAsBrowser: sessionId !== undefined,
            replayed: replayed.status,
            listed: { status: listed.status, ports: JSON.parse(listed.body).ports.map((port: { port: number }) => port.port), portRange: JSON.parse(listed.body).portRange, askedFor: listedRanges.at(-1) },
            outside: { status: outside.status, login: outsideLogin.pathname },
            widen: { status: widen.status, suggests: widen.body.includes(`value="${Math.max(range.max, outsidePort)}"`), replaces: widen.body.includes('A new approval replaces it') },
            afterRestart: { status: afterRestart.status, body: afterRestart.body, sameSession: callers.at(-1) === sessionId },
        }).toEqual({
            first: { status: 302, login: `localhost:${gatewayPort}/.linkrpc/login`, return: `http://${site}/page?x=1`, hasState: true },
            form: { status: 200, suggests: true, showsCode: true, allowsForm: true },
            crossSite: 403,
            submitted: { status: 303, location: true },
            waiting: { status: 200, showsCode: true, refresh: '2' },
            request: {
                name: `Browser ${code} via http-export on test-machine`,
                purpose: `Open ports ${range.min}–${range.max} of ${serviceId} in a browser. The browser shows the code ${code}.`,
                permissions: [
                    {
                        target: { serviceId: { exact: serviceId }, interfaceId: { exact: 'linkrpc.computeNode.tcpForward' }, members: [{ exact: 'multiplex' }] },
                        canInvoke: true,
                        params: { host: { exact: '127.0.0.1' }, port: { range } },
                    },
                    {
                        target: { serviceId: { exact: serviceId }, interfaceId: { exact: 'linkrpc.computeNode.ports' }, members: [{ exact: 'listListening' }] },
                        canInvoke: true,
                        params: { portRange: { exact: range } },
                    },
                ],
            },
            beforeApproval: { fetch: 401, tool: 'page /tool' },
            handoff: { status: 302, host: site, path: '/.linkrpc/session', return: '/page?x=1' },
            siteCookie: 'linkrpc-gateway=<token>; Domain=test--compute.localhost; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=31536000',
            accepted: { status: 302, location: '/page?x=1' },
            page: { status: 200, body: 'page /page?x=1' },
            appSawCookies: [undefined, 'app=1', undefined],
            signedAsBrowser: true,
            replayed: 403,
            listed: { status: 200, ports: [targetPort], portRange: range, askedFor: range },
            outside: { status: 302, login: '/.linkrpc/login' },
            widen: { status: 200, suggests: true, replaces: true },
            afterRestart: { status: 200, body: 'page /again', sameSession: true },
        });
    });

    it('asks again for invalid ranges and for sessions of earlier versions', async () => {
        const targetPort = await startTarget((_incoming, response) => response.end('page'));
        const requests: BrowserAccessRequest[] = [];
        const stateFile = join(mkdtempSync(join(tmpdir(), 'http-export-approval-')), 'sessions.json');
        cleanups.push(() => rmSync(dirname(stateFile), { recursive: true, force: true }));
        writeFileSync(stateFile, JSON.stringify({ version: 1, sessions: [], siteTokens: [] }));
        const gatewayPort = await startGateway({
            approval: { gatewayName: 'test-machine', stateFile, requestAccess: async request => { requests.push(request); return { status: 'denied', reason: 'not now' }; } },
        });
        const navigate = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
        const login = new URL((await send(gatewayPort, { host: `${targetPort}.test--compute.localhost:${gatewayPort}`, headers: navigate })).headers.location!);
        const form = await send(gatewayPort, { host: login.host, path: `${login.pathname}${login.search}`, headers: navigate });
        const cookie = cookiePair(form.headers['set-cookie'], 'linkrpc-gateway');
        const submit = (min: string, max: string) => send(gatewayPort, {
            host: login.host, method: 'POST', path: login.pathname, body: new URLSearchParams({ return: login.searchParams.get('return')!, min, max }).toString(),
            headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', cookie },
        });
        const reversed = await submit(String(targetPort), String(targetPort - 1));
        const excludesPort = await submit('1', String(targetPort - 1));
        await submit(String(targetPort), String(targetPort));
        await waitFor(() => requests.length === 1);
        await new Promise(resolve => setTimeout(resolve, 20));
        const denied = await send(gatewayPort, { host: login.host, path: `${login.pathname}${login.search}`, headers: { ...navigate, cookie } });
        expect({
            earlierVersionAsksAgain: form.status,
            reversed: { status: reversed.status, explains: reversed.body.includes('must not exceed'), keepsInput: reversed.body.includes(`value="${targetPort - 1}"`) },
            excludesPort: { status: excludesPort.status, explains: excludesPort.body.includes(`must include port ${targetPort}`) },
            requests: requests.length,
            denied: { status: denied.status, reason: denied.body.includes('not approved: not now'), formAgain: denied.body.includes('<form') },
        }).toEqual({
            earlierVersionAsksAgain: 200,
            reversed: { status: 400, explains: true, keepsInput: true },
            excludesPort: { status: 400, explains: true },
            requests: 1,
            denied: { status: 200, reason: true, formAgain: true },
        });
    });
});

const targets: Server[] = [];

async function startTarget(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const server = createServer(handler);
    targets.push(server);
    cleanupServer(server);
    return listen(server);
}

async function startGateway(overrides: Partial<HttpExportOptions> = {}, callers: (string | undefined)[] = []): Promise<number> {
    const pair = new TransportPair();
    const node = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    registerComputeNode(node.service(serviceId));
    cleanups.push(() => { client.close(); node.close(); });
    const gateway: HttpExport = await startHttpExport({
        listen: [{ host: '127.0.0.1', port: 0 }],
        getTcpForward: (id, caller) => {
            callers.push(caller?.id);
            return client.service(id).get(computeNodeTcpForwardInterface);
        },
        listServices: async () => ({ serviceIds: [serviceId], complete: true }),
        listPorts: async () => targets.flatMap(target => {
            const address = target.address();
            return address && typeof address === 'object' ? [{ port: address.port, addresses: ['127.0.0.1'], commandLine: 'node server.js --token <secret>', cwd: '/srv/app' }] : [];
        }).slice(-1),
        onError: () => { /* asserted through responses */ },
        ...overrides,
    });
    cleanups.push(() => gateway.close());
    return Number(new URL(gateway.urls[0]).port);
}

function cookiePair(setCookie: readonly string[] | undefined, name: string): string {
    const cookie = setCookie?.find(value => value.startsWith(`${name}=`));
    if (!cookie) {
        throw new Error(`no ${name} cookie`);
    }
    return cookie.split(';')[0];
}

/** A root capability granting `permissions`, as an approver that approves a request unchanged issues it. */
function fakeCapability(audience: string, permissions: BrowserAccessRequest['permissions']): SignedCapability {
    return { issuer: 'id:key:approver', audience, nonce: 'n', $hubrpcSignature: {}, permissions } as unknown as SignedCapability;
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

function send(port: number, options: { host: string; method?: string; path?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const outgoing = request({
            host: '127.0.0.1',
            port,
            method: options.method ?? 'GET',
            path: options.path ?? '/',
            headers: { ...options.headers, host: options.host },
            agent: false,
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        });
        outgoing.on('error', reject);
        outgoing.end(options.body);
    });
}

function cleanupServer<T extends { close(callback?: () => void): unknown }>(server: T): T {
    cleanups.push(() => new Promise<void>(resolve => {
        if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        server.close(() => resolve());
    }));
    return server;
}

async function listen(server: Server): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('test server did not bind');
    }
    return address.port;
}

async function unusedPort(): Promise<number> {
    const server = createServer();
    const port = await listen(server);
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
}
