import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { defineInterface, type InterfaceHandlers } from '../connection/interfaceDefinition';
import { notificationType, requestType, rpcError } from '../schema/memberTypes';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { bareInterfaceTarget } from '../connection/bareInterfaceTarget';
import { TransportPair } from '../transport/messageTransport';
import { connectHttp } from './client';
import { HttpServer } from './server';
import { CALL_HEADER, httpRoute, NDJSON, readLines } from './protocol';
import { httpRequestListener } from '../node/http';

const missing = rpcError(42, z.object({ message: z.string() }));
const api = defineInterface({ id: 'test.scores' }, {
    getScoreList: requestType(z.object({ filter: z.string().optional() }), z.array(z.string())),
    postScoreList: requestType(z.object({ title: z.string() }), z.string()),
    echo: requestType(z.string(), z.string()),
    failure: requestType(z.object({}), z.string()).withErrors([missing]),
    notify: notificationType(z.string()),
    importScores: requestType(z.object({}), z.number()).withStream({ client: z.number(), server: z.string() }),
    getProgress: requestType(z.object({}), z.number()).withStream({ server: z.string() }),
    cancel: requestType(z.object({}), z.string()).withStream({ server: z.string() }),
});

const cleanup: (() => void | Promise<void>)[] = [];
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function handlers(): InterfaceHandlers<typeof api, { readonly data: string }> {
    return {
        getScoreList: (_params, ctx) => [ctx.data],
        postScoreList: ({ title }) => title,
        echo: value => value,
        failure: () => missing.create({ message: 'missing score' }),
        notify: () => {},
        importScores: (_params, _ctx, stream) => new Promise<number>((resolve, reject) => {
            stream.onMessage(value => {
                void stream.send(`received ${value}`).then(() => resolve(value), reject);
            });
        }),
        getProgress: async (_params, _ctx, stream) => {
            await stream.send('ready');
            await stream.ping();
            return 3;
        },
        cancel: (_params, _ctx, stream) => new Promise((_resolve, reject) => {
            stream.signal.addEventListener('abort', () => reject(stream.signal.reason), { once: true });
        }),
    };
}

function setup(mode: 'shared' | 'perRequest') {
    const options = { context: (request: Request) => request.headers.get('authorization') ?? 'anonymous', timeoutMs: 2000 };
    const http = (() => {
        if (mode === 'perRequest') return HttpServer.perRequest({ ...options, accept: connection => connection.register(api, handlers()) });
        const shared = HttpServer.shared(options);
        shared.connection.register(api, handlers());
        return shared;
    })();
    cleanup.push(() => http.dispose());
    const fetch: typeof globalThis.fetch = (input, init) => http.handle(new Request(input, init));
    const connection = connectHttp('http://localhost', { fetch, timeoutMs: 2000, headers: { authorization: 'alice' } });
    cleanup.push(() => connection.close());
    return { http, connection, client: connection.get(api), fetch };
}

describe('HTTP convention', () => {
    it('infers verbs and preserves namespaces', () => {
        expect([
            httpRoute('test.scores::getScoreList'),
            httpRoute('test.scores::postScoreList'),
            httpRoute('service/a::test.scores::deleteScore'),
            httpRoute('getaway'),
            httpRoute('importScores'),
        ]).toMatchInlineSnapshot(`
          [
            {
              "method": "GET",
              "path": "/test.scores/scoreList",
            },
            {
              "method": "POST",
              "path": "/test.scores/scoreList",
            },
            {
              "method": "DELETE",
              "path": "/service%2Fa/test.scores/score",
            },
            {
              "method": "POST",
              "path": "/getaway",
            },
            {
              "method": "POST",
              "path": "/importScores",
            },
          ]
        `);
    });
});

describe.each(['shared', 'perRequest'] as const)('%s HTTP server', mode => {
    it('round-trips GET/POST, notifications, validation and declared errors', async () => {
        const { client, http } = setup(mode);
        expect(await client.getScoreList({})).toEqual(['alice']);
        expect(await client.postScoreList({ title: 'suite' })).toBe('suite');
        await client.notify('notified');
        expect(await client.failure({})).toMatchObject({ error: { kind: 'application', code: 42, message: 'missing score' } });
        const response = await http.handle(new Request('http://localhost/test.scores/scoreList', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title":2}',
        }));
        expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    });

    it('supports immediate input, response streams, and both ping directions', async () => {
        const { client } = setup(mode);
        const messages: string[] = [];
        const call = client.importScores({}, { onMessage: value => messages.push(value) });
        await call.ping();
        await call.send(7);
        expect(await call).toBe(7);
        expect(messages).toEqual(['received 7']);
        expect(await client.getProgress({}, { onMessage: value => messages.push(value) })).toBe(3);
        expect(messages).toEqual(['received 7', 'ready']);
    });

    it('cancels one request without closing other requests', async () => {
        const { client } = setup(mode);
        const first = client.cancel({});
        const rejected = expect(first).rejects.toMatchObject({ code: -32800 });
        await first.cancel('stop');
        await rejected;
        expect(await client.echo('still alive')).toBe('still alive');
    });

    it('isolates per-request contexts', async () => {
        const { fetch, client } = setup(mode);
        const bob = connectHttp('http://localhost', { fetch, headers: { authorization: 'bob' } });
        cleanup.push(() => bob.close());
        expect(await Promise.all([client.getScoreList({}), bob.get(api).getScoreList({})]))
            .toEqual([['alice'], ['bob']]);
    });

    it('does not accept stream input from another credential scope', async () => {
        const { http } = setup(mode);
        const response = await http.handle(new Request('http://localhost/test.scores/cancel', {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'alice' }, body: '{}',
        }));
        const input = (authorization: string) => http.handle(new Request('http://localhost/$stream::send', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization, [CALL_HEADER]: response.headers.get(CALL_HEADER)! },
            body: JSON.stringify({ jsonrpc: '2.0', method: '$stream::send', params: {
                requestId: 1, dir: 'toCallee', control: { type: 'cancel' },
            } }),
        }));
        expect((await input('bob')).status).toBe(403);
        expect((await input('alice')).status).toBe(204);
        await response.text();
        expect((await input('alice')).status).toBe(410);
    });
});

describe('HTTP lifecycle and compatibility', () => {
    async function listen(listener: Parameters<typeof createServer>[1] & {}) {
        const server = createServer(listener);
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        cleanup.push(() => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
        }));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No server address');
        return `http://127.0.0.1:${address.port}`;
    }

    it('supports real HTTP/1.1 streaming without a streaming request body', async () => {
        const http = HttpServer.shared({ context: () => 'node' });
        http.connection.register(api, handlers());
        cleanup.push(() => http.dispose());
        const errors: unknown[] = [];
        const connection = connectHttp(await listen(httpRequestListener((request, options) => http.handle(request, options), error => errors.push(error))));
        cleanup.push(() => connection.close());
        const client = connection.get(api);
        const call = client.importScores({});
        await call.send(9);
        expect(await call).toBe(9);
        expect(await client.getProgress({})).toBe(3);
        expect(errors).toEqual([]);
    });

    it('works below a mount path after middleware consumed the JSON body', async () => {
        const http = HttpServer.shared({ context: request => new URL(request.url).pathname });
        http.connection.register(api, handlers());
        cleanup.push(() => http.dispose());
        const errors: unknown[] = [];
        const listener = httpRequestListener((request, options) => http.handle(request, options), error => errors.push(error));
        // Emulates Express: `app.use(express.json())` followed by `app.use('/rpc', listener)`.
        const base = await listen(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(chunk as Buffer);
            const text = Buffer.concat(chunks).toString();
            Object.assign(request, { originalUrl: request.url, body: text ? JSON.parse(text) : {} });
            if (!request.url?.startsWith('/rpc/')) {
                response.writeHead(404).end();
                return;
            }
            request.url = request.url.slice('/rpc'.length);
            listener(request, response);
        });
        const connection = connectHttp(`${base}/rpc`);
        cleanup.push(() => connection.close());
        const client = connection.get(api);
        expect(await client.getScoreList({})).toEqual(['/rpc/test.scores/scoreList']);
        expect(await client.echo('parsed')).toBe('parsed');
        await client.notify('parsed');
        const call = client.importScores({});
        await call.send(5);
        expect(await call).toBe(5);
        expect(errors).toEqual([]);
    });

    it('reports bodies consumed without req.body instead of treating them as empty', async () => {
        const http = HttpServer.shared({ context: () => 'node' });
        http.connection.register(api, handlers());
        cleanup.push(() => http.dispose());
        const errors: unknown[] = [];
        const listener = httpRequestListener((request, options) => http.handle(request, options), error => errors.push(error));
        const base = await listen(async (request, response) => {
            for await (const _chunk of request) { /* consume */ }
            listener(request, response);
        });
        const response = await fetch(`${base}/test.scores/echo`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '"lost"',
        });
        expect(response.status).toBe(500);
        expect(String(errors[0])).toContain('consumed by earlier middleware');
    });

    it('reuses identical handlers with an ordinary message transport', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport<{ readonly data: string }>({
            send: message => pair.a.send(message),
            setListener: listener => pair.a.setListener(listener
                ? message => listener({ ...message, context: { data: 'memory' } }) : undefined),
            dispose: () => pair.a.dispose(),
        });
        const client = LinkRpcConnection.fromTransport(pair.b);
        cleanup.push(() => { server.close(); client.close(); });
        server.register(api, handlers());
        expect(await client.get(api).echo('same handlers')).toBe('same handlers');
        const call = client.get(api).importScores({});
        await call.send(4);
        expect(await call).toBe(4);
    });

    it('reflects the same interface and removes disposed routes', async () => {
        const http = HttpServer.shared({ context: () => 'alice' });
        cleanup.push(() => http.dispose());
        const registration = http.connection.register(api, handlers());
        expect(http.connection.listRegisteredInterfaces()[0].interfaceHash).toBe(api.schemaHash);
        expect((await http.handle(new Request('http://localhost/test.scores/scoreList?params=%7B%7D'))).status).toBe(200);
        registration.dispose();
        expect((await http.handle(new Request('http://localhost/test.scores/scoreList'))).status).toBe(404);
    });

    it('caches shared routes and invalidates additions, removals, and bare bindings', async () => {
        const http = HttpServer.shared({ context: () => 'alice' });
        cleanup.push(() => http.dispose());
        const list = vi.spyOn(http.connection, 'listRegisteredMethods');
        const request = (path: string) => http.handle(new Request(`http://localhost/${path}?params=%7B%7D`));
        expect((await request('test.scores/scoreList')).status).toBe(404);
        expect((await request('test.scores/scoreList')).status).toBe(404);
        expect(list).toHaveBeenCalledTimes(1);

        const registration = http.connection.register(bareInterfaceTarget(api), handlers());
        for (const path of ['test.scores/scoreList', 'scoreList', 'scoreList']) {
            expect(await (await request(path)).json()).toMatchObject({ result: ['alice'] });
        }
        expect(list).toHaveBeenCalledTimes(2);

        registration.dispose();
        expect((await request('scoreList')).status).toBe(404);
        expect((await request('test.scores/scoreList')).status).toBe(404);
        expect(list).toHaveBeenCalledTimes(3);

        http.connection.register(api, { ...handlers(), getScoreList: () => ['replacement'] });
        expect(await (await request('test.scores/scoreList')).json()).toMatchObject({ result: ['replacement'] });
        expect((await request('scoreList')).status).toBe(404);
        expect(list).toHaveBeenCalledTimes(4);
    });

    it('does not reuse routes across per-request connections', async () => {
        const http = HttpServer.perRequest({
            context: () => 'alice',
            accept: connection => {
                if (++requests === 1) connection.register(api, handlers());
            },
        });
        let requests = 0;
        cleanup.push(() => http.dispose());
        const request = () => http.handle(new Request('http://localhost/test.scores/scoreList?params=%7B%7D'));
        expect((await request()).status).toBe(200);
        expect((await request()).status).toBe(404);
    });

    it('does not cache a partially built table after a collision', async () => {
        const http = HttpServer.shared({ context: () => 'alice' });
        cleanup.push(() => http.dispose());
        http.connection.register(api, handlers());
        const request = () => http.handle(new Request('http://localhost/test.scores/scoreList?params=%7B%7D'));
        expect((await request()).status).toBe(200);
        const registration = http.connection.register(defineInterface({ id: 'collision' }, {
            postImport: requestType(z.object({}), z.string()),
            import: requestType(z.object({}), z.string()),
        }), { postImport: () => '', import: () => '' });
        await expect(request()).rejects.toThrow('Ambiguous HTTP route');
        await expect(request()).rejects.toThrow('Ambiguous HTTP route');
        registration.dispose();
        expect((await request()).status).toBe(200);
    });

    it('rejects route collisions explicitly', async () => {
        const http = HttpServer.shared({ context: () => undefined });
        cleanup.push(() => http.dispose());
        http.connection.register(defineInterface({ id: 'collision' }, {
            postImport: requestType(z.object({}), z.string()),
            import: requestType(z.object({}), z.string()),
        }), { postImport: () => '', import: () => '' });
        await expect(http.handle(new Request('http://localhost/collision/import', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        }))).rejects.toThrow('Ambiguous HTTP route');
    });

    it('surfaces unsupported reverse notifications', async () => {
        const http = HttpServer.shared({ context: () => undefined });
        cleanup.push(() => http.dispose());
        await expect(http.connection.get(api).notify('reverse')).rejects.toThrow('reverse notifications');
    });

    it.each([
        ['missing final', '{"jsonrpc":"2.0","method":"$stream::send","params":{"requestId":1,"dir":"toCaller","payload":"hi"}}\n'],
        ['wrong id', '{"jsonrpc":"2.0","id":2,"result":1}\n'],
        ['both result and error', '{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1,"message":"bad"}}\n'],
        ['after final', '{"jsonrpc":"2.0","id":1,"result":1}\n{"jsonrpc":"2.0","id":1,"result":2}\n'],
        ['malformed', 'not JSON\n'],
    ])('rejects %s responses', async (_name, body) => {
        const connection = connectHttp('http://localhost', {
            fetch: async () => new Response(body, { headers: { 'content-type': NDJSON, [CALL_HEADER]: 'handle' } }),
        });
        cleanup.push(() => connection.close());
        await expect(connection.get(api).importScores({})).rejects.toThrow();
    });

    it('propagates asynchronous stream-input failures', async () => {
        const { fetch } = setup('shared');
        const connection = connectHttp('http://localhost', {
            fetch: (input, init) => String(input).endsWith('/$stream::send')
                ? Promise.resolve(new Response('failed', { status: 503 })) : fetch(input, init),
        });
        cleanup.push(() => connection.close());
        const call = connection.get(api).cancel({});
        const rejected = expect(call).rejects.toThrow('503');
        await expect(call.cancel()).rejects.toThrow('503');
        await rejected;
    });

    it('closes unary calls even while fetch is still pending', async () => {
        const connection = connectHttp('http://localhost', {
            fetch: (_input, init) => new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
            }),
        });
        const call = connection.get(api).echo('pending');
        const rejected = expect(call).rejects.toThrow('Connection closed');
        connection.close();
        await rejected;
    });

    it.each(['dispose', 'close'] as const)('aborts server work on client %s', async action => {
        const stopped = deferred();
        const http = HttpServer.shared({ context: () => 'alice' });
        cleanup.push(() => http.dispose());
        http.connection.register(api, {
            ...handlers(),
            cancel: (_params, _ctx, stream) => new Promise((_resolve, reject) => {
                stream.signal.addEventListener('abort', () => {
                    stopped.resolve();
                    reject(stream.signal.reason);
                }, { once: true });
            }),
        });
        const connection = connectHttp('http://localhost', {
            fetch: (input, init) => http.handle(new Request(input, init)),
        });
        cleanup.push(() => connection.close());
        const call = connection.get(api).cancel({});
        await call.ping();
        const rejected = expect(call).rejects.toThrow();
        if (action === 'close') connection.close();
        else call.dispose?.();
        await rejected;
        await stopped.promise;
        expect((await http.handle(new Request('http://localhost/test.scores/scoreList'))).status).toBe(200);
    });

    it('bounds active calls and releases slots on disconnect', async () => {
        const http = HttpServer.shared({ context: () => 'alice', maxActiveCalls: 1 });
        cleanup.push(() => http.dispose());
        http.connection.register(api, handlers());
        const request = () => new Request('http://localhost/test.scores/cancel', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        const response = await http.handle(request());
        expect((await http.handle(request())).status).toBe(503);
        await response.body!.cancel();
        await vi.waitFor(async () => {
            expect((await http.handle(new Request('http://localhost/test.scores/scoreList'))).status).toBe(200);
        });
    });

    it('times out a stalled streaming call', async () => {
        const { fetch } = setup('shared');
        const connection = connectHttp('http://localhost', { fetch, timeoutMs: 20 });
        cleanup.push(() => connection.close());
        await expect(connection.get(api).cancel({})).rejects.toThrow('timed out');
    });

    it('times out stalled request-body uploads', async () => {
        const http = HttpServer.shared({ context: () => 'alice', timeoutMs: 20 });
        cleanup.push(() => http.dispose());
        http.connection.register(api, handlers());
        const body = new ReadableStream<Uint8Array>();
        const init: RequestInit & { duplex: 'half' } = {
            method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half',
        };
        const response = await http.handle(new Request('http://localhost/test.scores/echo', init));
        expect(response.status).toBe(408);
    });

    it('applies backpressure to a slow response reader', async () => {
        let sent = 0;
        const http = HttpServer.shared({ context: () => 'alice' });
        cleanup.push(() => http.dispose());
        http.connection.register(api, {
            ...handlers(),
            getProgress: async (_params, _ctx, stream) => {
                await stream.send('first');
                sent++;
                await stream.send('second');
                sent++;
                return sent;
            },
        });
        const response = await http.handle(new Request('http://localhost/test.scores/progress?params=%7B%7D'));
        expect(response.headers.get('content-type')).toBe(NDJSON);
        expect(sent).toBe(0);
        const reader = response.body!.getReader();
        await reader.read();
        await vi.waitFor(() => expect(sent).toBe(1));
        await reader.read();
        await vi.waitFor(() => expect(sent).toBe(2));
        await reader.read();
        expect((await reader.read()).done).toBe(true);
    });

    it('limits request/frame sizes and invalid options', async () => {
        const http = HttpServer.shared({ context: () => 'alice', maxFrameBytes: 16 });
        cleanup.push(() => http.dispose());
        http.connection.register(api, handlers());
        const response = await http.handle(new Request('http://localhost/test.scores/echo', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify('x'.repeat(20)),
        }));
        expect(response.status).toBe(413);
        expect(() => connectHttp('http://localhost', { timeoutMs: -1 })).toThrow('timeoutMs');
        expect(() => HttpServer.shared({ context: () => undefined, maxActiveCalls: 0 })).toThrow('maxActiveCalls');
    });

    it('bounds early stream sends before the handle is available', async () => {
        const { fetch } = setup('shared');
        const gate = deferred();
        const connection = connectHttp('http://localhost', {
            fetch, maxPendingStreamMessages: 1,
            headers: async () => { await gate.promise; return {}; },
        });
        cleanup.push(() => connection.close());
        const call = connection.get(api).importScores({});
        const first = call.send(1);
        await expect(call.send(2)).rejects.toThrow('Too many pending');
        gate.resolve();
        await first;
        expect(await call).toBe(1);
    });

    it('waits for input acknowledgments before releasing a completed call', async () => {
        const { fetch } = setup('shared');
        const connection = connectHttp('http://localhost', {
            fetch: async (input, init) => {
                const response = await fetch(input, init);
                if (String(input).endsWith('/$stream::send')) {
                    await new Promise(resolve => setTimeout(resolve, 20));
                    init?.signal?.throwIfAborted();
                }
                return response;
            },
        });
        cleanup.push(() => connection.close());
        const call = connection.get(api).importScores({});
        await call.send(7);
        expect(await call).toBe(7);
    });

    it('handles UTF-8 split at every byte and enforces frame limits', async () => {
        const bytes = new TextEncoder().encode('"🎵"\n"ok"\n');
        const body = () => new ReadableStream<Uint8Array>({
            start(controller) {
                for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
                controller.close();
            },
        });
        const lines = [];
        for await (const line of readLines(body(), 32)) lines.push(line);
        expect(lines).toEqual(['"🎵"', '"ok"']);
        await expect(async () => {
            for await (const _line of readLines(body(), 3)) { /* consume */ }
        }).rejects.toThrow('Frame too large');
    });
});
