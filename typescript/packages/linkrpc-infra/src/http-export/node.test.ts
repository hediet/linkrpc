import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { computeNodeTcpForwardInterface } from '../compute-node/index';
import { registerComputeNode } from '../compute-node/node';
import { startHttpExport, type HttpExport } from './node';

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
            ports: { serviceId, ports: [{ port: targetPort, addresses: ['127.0.0.1'], url: `http://${targetPort}.test--compute.localhost:${gatewayPort}/` }] },
        });
    });

    it('answers 502 when the target port is not listening', async () => {
        const gatewayPort = await startGateway();
        const unused = await unusedPort();
        const response = await send(gatewayPort, { host: `${unused}.test--compute.localhost:${gatewayPort}` });
        expect(response.status).toBe(502);
    });
});

const targets: Server[] = [];

async function startTarget(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const server = createServer(handler);
    targets.push(server);
    cleanupServer(server);
    return listen(server);
}

async function startGateway(): Promise<number> {
    const pair = new TransportPair();
    const node = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    registerComputeNode(node.service(serviceId));
    cleanups.push(() => { client.close(); node.close(); });
    const gateway: HttpExport = await startHttpExport({
        listen: [{ host: '127.0.0.1', port: 0 }],
        getTcpForward: id => client.service(id).get(computeNodeTcpForwardInterface),
        listServices: async () => ({ serviceIds: [serviceId], complete: true }),
        listPorts: async () => targets.flatMap(target => {
            const address = target.address();
            return address && typeof address === 'object' ? [{ port: address.port, addresses: ['127.0.0.1'] }] : [];
        }).slice(-1),
        onError: () => { /* asserted through responses */ },
    });
    cleanups.push(() => gateway.close());
    return Number(new URL(gateway.urls[0]).port);
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
