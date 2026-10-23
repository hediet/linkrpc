import { once } from 'node:events';
import type { ClientRequestArgs } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LinkRpcConnection, TransportPair, type JsonValue } from '@hediet/linkrpc';
import { connectRawJsonRpcTransport } from './client';
import { jsonRpcConnectionInterface } from './interface';
import { registerJsonRpcConnectionService } from './server';
import { JsonRpcTransportPair } from './transport';
import {
    startJsonRpcWebSocketExport,
    validateJsonRpcExport,
    type JsonRpcWebSocketExport,
    type JsonRpcWebSocketExportOptions,
} from './node';

const targetEndpoint = 'listen:ws://127.0.0.1:0';
const token = 'test-export-token';
const routes = [{ serviceId: 'foo', path: '/foo' }, { serviceId: 'bar', path: '/bar' }];
const servers: JsonRpcWebSocketExport[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    await Promise.all(servers.splice(0).map(server => server.close()));
});

async function start(openTransport: JsonRpcWebSocketExportOptions['openTransport'], errors: Error[] = []) {
    const server = await startJsonRpcWebSocketExport({
        targetEndpoint, token, routes, openTransport,
        onError: error => errors.push(error),
    });
    servers.push(server);
    return server;
}

async function connect(server: JsonRpcWebSocketExport, path = '/foo', query = `?tkn=${token}`) {
    const client = new WebSocket(`${server.endpoint.slice(0, -1)}${path}${query}`);
    clients.push(client);
    await once(client, 'open');
    return client;
}

function message(client: WebSocket): Promise<JsonValue> {
    return once(client, 'message').then(([data]) => JSON.parse(data.toString()));
}

describe('JSON-RPC WebSocket export', () => {
    it('routes simultaneous clients to independent raw Hub sessions without a handshake', async () => {
        const link = new TransportPair();
        const host = LinkRpcConnection.fromTransport(link.a);
        const consumer = LinkRpcConnection.fromTransport(link.b);
        const peers: { serviceId: string; pair: JsonRpcTransportPair; frames: JsonValue[] }[] = [];
        for (const { serviceId } of routes) {
            registerJsonRpcConnectionService({
                connection: host,
                serviceId,
                openTransport: async () => {
                    const pair = new JsonRpcTransportPair();
                    const frames: JsonValue[] = [];
                    peers.push({ serviceId, pair, frames });
                    pair.b.onMessage(frame => {
                        frames.push(frame);
                        void pair.b.send(frame);
                    });
                    return pair.a;
                },
            });
        }
        const errors: Error[] = [];
        const server = await start((serviceId, signal) => connectRawJsonRpcTransport(
            consumer.service(serviceId).get(jsonRpcConnectionInterface), undefined, signal,
        ), errors);
        try {
            const sockets = await Promise.all([connect(server), connect(server, '/bar'), connect(server)]);
            const frames = [
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: { client: 1 } },
                { jsonrpc: '2.0', method: 'notification' },
                { jsonrpc: '2.0', id: 'server-request', result: true },
            ];
            const received = sockets.map(message);
            sockets.forEach((socket, index) => socket.send(JSON.stringify(frames[index])));
            expect(await Promise.all(received)).toEqual(frames);
            expect(peers.map(peer => ({ serviceId: peer.serviceId, frames: peer.frames }))).toEqual([
                { serviceId: 'foo', frames: [frames[0]] },
                { serviceId: 'bar', frames: [frames[1]] },
                { serviceId: 'foo', frames: [frames[2]] },
            ]);
            const reverse = message(sockets[0]);
            await peers[0].pair.b.send({ jsonrpc: '2.0', id: 'reverse', method: 'approve' });
            expect(await reverse).toEqual({ jsonrpc: '2.0', id: 'reverse', method: 'approve' });
            await server.close();
            await expect.poll(() => peers.every(peer => peer.pair.b.closed)).toBe(true);
            expect(errors).toEqual([]);
        } finally {
            link.a.dispose();
            link.b.dispose();
        }
    });

    it('rejects unknown routes and missing or wrong tokens before opening an upstream', async () => {
        let opened = 0;
        const server = await start(async () => {
            opened++;
            return new JsonRpcTransportPair().a;
        });
        const statuses: number[] = [];
        for (const suffix of ['/missing?tkn=test-export-token', '/foo', '/foo?tkn=wrong']) {
            const client = new WebSocket(`${server.endpoint.slice(0, -1)}${suffix}`);
            clients.push(client);
            statuses.push(await new Promise<number>(resolve => {
                client.on('error', () => {});
                client.on('unexpected-response', (_request, response) => {
                    response.resume();
                    resolve(response.statusCode!);
                    client.terminate();
                });
            }));
        }
        expect({ statuses, opened }).toEqual({ statuses: [404, 401, 401], opened: 0 });
        const bearer = new WebSocket(`${server.endpoint}foo`, { headers: { authorization: `Bearer ${token}` } });
        clients.push(bearer);
        await once(bearer, 'open');
        await expect.poll(() => opened).toBe(1);
    });

    it('aborts pending factories on disconnect and closes late transports', async () => {
        let resolve!: (pair: JsonRpcTransportPair['a']) => void;
        let signal!: AbortSignal;
        const server = await start((_serviceId, abortSignal) => {
            signal = abortSignal;
            return new Promise(done => { resolve = done; });
        });
        const client = await connect(server);
        await expect.poll(() => !!signal).toBe(true);
        client.close();
        await expect.poll(() => signal.aborted).toBe(true);
        const pair = new JsonRpcTransportPair();
        resolve(pair.a);
        await expect.poll(() => pair.b.closed).toBe(true);
    });

    it('accepts configured query names and rejects ambiguous or malformed credentials', async () => {
        let opened = 0;
        const server = await startJsonRpcWebSocketExport({
            targetEndpoint, token, routes,
            tokenQueryParameters: ['connectionToken', 'api_key'],
            openTransport: async () => {
                opened++;
                return new JsonRpcTransportPair().a;
            },
            onError: error => { throw error; },
        });
        servers.push(server);
        await connect(server, '/foo', `?connectionToken=${token}`);
        await connect(server, '/bar', `?api_key=${token}`);
        const attempts = [
            { query: `?tkn=${token}` },
            { query: `?token=${token}` },
            { query: `?connectionToken=${token}&connectionToken=${token}` },
            { query: `?connectionToken=${token}&api_key=wrong` },
            { query: `?connectionToken=${token}`, authorization: `Bearer ${token}` },
            { query: `?connectionToken=${token}`, authorization: 'Basic invalid' },
            { query: '', authorization: token },
            { query: '', authorization: [`Bearer ${token}`, `Bearer ${token}`] },
        ];
        const statuses: number[] = [];
        for (const { query, authorization } of attempts) {
            const options: ClientRequestArgs = {
                headers: authorization === undefined ? {} : { Authorization: authorization },
            };
            const client = new WebSocket(`${server.endpoint}foo${query}`, options);
            clients.push(client);
            statuses.push(await new Promise<number>(resolve => {
                client.on('error', () => {});
                client.on('unexpected-response', (_request, response) => {
                    response.resume();
                    resolve(response.statusCode!);
                    client.terminate();
                });
            }));
        }
        expect({ opened, statuses }).toEqual({ opened: 2, statuses: attempts.map(() => 401) });
    });

    it('isolates upstream factory failures', async () => {
        const errors: Error[] = [];
        const server = await start(async serviceId => {
            if (serviceId === 'foo') throw new Error('Unavailable');
            const pair = new JsonRpcTransportPair();
            pair.b.onMessage(frame => { void pair.b.send(frame); });
            return pair.a;
        }, errors);
        const bad = await connect(server);
        await expect.poll(() => bad.readyState).toBe(WebSocket.CLOSED);
        const good = await connect(server, '/bar');
        const response = message(good);
        good.send('{"jsonrpc":"2.0","method":"ok"}');
        expect(await response).toEqual({ jsonrpc: '2.0', method: 'ok' });
        expect(errors.map(error => error.message)).toEqual(["JSON-RPC export route 'foo' failed"]);
    });

    it('preserves ordering while the upstream is opening and rejects invalid JSON', async () => {
        const pair = new JsonRpcTransportPair();
        const frames: JsonValue[] = [];
        pair.b.onMessage(frame => frames.push(frame));
        let resolve!: (transport: JsonRpcTransportPair['a']) => void;
        const errors: Error[] = [];
        const server = await start(() => new Promise(done => { resolve = done; }), errors);
        const client = await connect(server);
        client.send('{"jsonrpc":"2.0","id":1,"method":"first"}');
        client.send('{"jsonrpc":"2.0","id":2,"method":"second"}');
        await expect.poll(() => !!resolve).toBe(true);
        resolve(pair.a);
        await expect.poll(() => frames).toEqual([
            { jsonrpc: '2.0', id: 1, method: 'first' },
            { jsonrpc: '2.0', id: 2, method: 'second' },
        ]);
        client.send('{');
        await expect.poll(() => pair.b.closed).toBe(true);
        expect(errors[0].cause).toEqual(new Error('Invalid JSON WebSocket message'));
    });

    it('enforces the pending frame limit and aborts the factory', async () => {
        let signal!: AbortSignal;
        const errors: Error[] = [];
        const server = await start((_serviceId, abortSignal) => {
            signal = abortSignal;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        }, errors);
        const client = await connect(server);
        for (let i = 0; i < 1025; i++) client.send('{"jsonrpc":"2.0","method":"queued"}');
        await expect.poll(() => signal.aborted).toBe(true);
        expect(errors[0].cause).toEqual(new Error('JSON-RPC input queue exceeded'));
    });

    it('enforces the 32 MiB pending byte limit independently of the frame count', async () => {
        const errors: Error[] = [];
        const server = await start((_serviceId, signal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
        }), errors);
        const client = await connect(server);
        const frame = JSON.stringify({ jsonrpc: '2.0', method: 'large', params: 'x'.repeat(12 * 1024 * 1024) });
        for (let i = 0; i < 3; i++) client.send(frame);
        await expect.poll(() => client.readyState).toBe(WebSocket.CLOSED);
        expect(errors[0].cause).toEqual(new Error('JSON-RPC input queue exceeded'));
    });

    it('rejects an incoming frame exceeding 16 MiB', async () => {
        const pair = new JsonRpcTransportPair();
        const errors: Error[] = [];
        const server = await start(async () => pair.a, errors);
        const client = await connect(server);
        client.send(JSON.stringify({ params: 'x'.repeat(16 * 1024 * 1024) }));
        await expect.poll(() => pair.b.closed).toBe(true);
        expect(errors[0].cause).toMatchObject({ code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' });
    });

    it('rejects an outgoing frame exceeding 16 MiB', async () => {
        const pair = new JsonRpcTransportPair();
        const errors: Error[] = [];
        const server = await start(async () => pair.a, errors);
        await connect(server);
        await pair.b.send({ params: 'x'.repeat(16 * 1024 * 1024) });
        await expect.poll(() => pair.b.closed).toBe(true);
        expect(errors[0].cause).toEqual(new Error('WebSocket output queue exceeded'));
    });

    it('propagates bind failures and allows idempotent shutdown', async () => {
        const server = await start(async () => new JsonRpcTransportPair().a);
        await expect(startJsonRpcWebSocketExport({
            targetEndpoint: `listen:${server.endpoint}`,
            token, routes,
            openTransport: async () => new JsonRpcTransportPair().a,
            onError: () => {},
        })).rejects.toMatchObject({ code: 'EADDRINUSE' });
        await Promise.all([server.close(), server.close()]);
    });

    it('closes incomplete HTTP upgrades on shutdown', async () => {
        const server = await start(async () => new JsonRpcTransportPair().a);
        const socket = connectTcp(Number(new URL(server.endpoint).port), '127.0.0.1');
        const errors: NodeJS.ErrnoException[] = [];
        socket.on('error', error => errors.push(error));
        try {
            await once(socket, 'connect');
            socket.write('GET /foo HTTP/1.1\r\nUpgrade: websocket\r\n');
            const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
            await server.close();
            await closed;
            expect(errors.filter(error => error.code !== 'ECONNRESET')).toEqual([]);
        } finally {
            socket.destroy();
        }
    });

    it.each([
        { targetEndpoint: 'ws://127.0.0.1:8123' },
        { targetEndpoint: 'listen:npipe://./pipe/raw' },
        { targetEndpoint: 'listen:wss://127.0.0.1:8123' },
        { targetEndpoint: 'listen:ws://127.0.0.1:8123/path' },
        { token: '' },
        { tokenQueryParameters: [''] },
        { tokenQueryParameters: ['a&b'] },
        { tokenQueryParameters: ['tkn', 'tkn'] },
        { routes: [] },
        { routes: [routes[0], routes[0]] },
        { routes: [{ serviceId: '', path: '/foo' }] },
        { routes: [{ serviceId: 'foo', path: '/a/../b' }] },
    ])('rejects invalid startup configuration: %j', invalid => {
        expect(() => validateJsonRpcExport({ targetEndpoint, token, routes, ...invalid })).toThrow();
    });

    it('accepts a URI token without including it in readiness', async () => {
        const server = await startJsonRpcWebSocketExport({
            targetEndpoint: `${targetEndpoint}?token=${token}`, routes,
            openTransport: async () => new JsonRpcTransportPair().a,
            onError: () => {},
        });
        servers.push(server);
        expect(server.endpoint).not.toContain(token);
        await connect(server, '/foo', `?token=${token}`);
    });
});
