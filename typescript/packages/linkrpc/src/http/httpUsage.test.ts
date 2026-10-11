/**
 * End-to-end usage of LinkRPC over HTTP. Read top to bottom:
 *
 *   1. A transport-independent interface contract.
 *   2. Handlers that implement it (no HTTP-specific code).
 *   3. A Node HTTP server exposing a shared connection.
 *   4. A client using the ordinary typed `connection.get(...)` API.
 *
 * Imports mirror the public entry points noted alongside.
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    applicationError, defineInterface, isRpcFailure, LinkRpcConnection, requestType,
    TransportPair, type InterfaceHandlers,
} from '../index'; // @hediet/linkrpc
import { connectHttp } from './client'; // @hediet/linkrpc/http/client (browser-compatible)
import { HttpRpcError, HttpServer } from './server'; // @hediet/linkrpc/http/server
import { httpRequestListener } from '../node/http'; // @hediet/linkrpc/node

// ---- 1. Contract: shared by client and server --------------------------------------------

const Score = z.object({ id: z.string(), title: z.string() });
type Score = z.infer<typeof Score>;

const scoreNotFound = applicationError('ScoreNotFound');

/** HTTP verbs and paths are inferred from member names; no HTTP metadata is declared. */
const scores = defineInterface({ id: 'example.scores' }, {
    /** GET /example.scores/scoreList */
    getScoreList: requestType(z.object({}), z.array(Score)),
    /** POST /example.scores/scoreList */
    postScoreList: requestType(z.object({ title: z.string() }), Score),
    /** GET /example.scores/score, with a declared (typed) error */
    getScore: requestType(z.object({ id: z.string() }), Score).withErrors([scoreNotFound]),
    /** DELETE /example.scores/score */
    deleteScore: requestType(z.object({ id: z.string() }), z.boolean()),
    /** POST /example.scores/importScores: the client streams titles, the server streams progress. */
    importScores: requestType(z.object({ expected: z.number() }), z.number())
        .withStream({ client: z.string(), server: z.object({ imported: z.number() }) }),
});

// ---- 2. Handlers: identical for HTTP, WebSocket, or any other transport -------------------

/** Handlers only depend on application data, not on `Request` or HTTP. */
type UserContext = { readonly data: { readonly user: string } };

function createScoreHandlers(): InterfaceHandlers<typeof scores, UserContext> {
    const scoresByUser = new Map<string, Score[]>();
    let nextId = 1;
    const scoresOf = (ctx: UserContext) => {
        let list = scoresByUser.get(ctx.data.user);
        if (!list) scoresByUser.set(ctx.data.user, list = []);
        return list;
    };
    const add = (ctx: UserContext, title: string) => {
        const score = { id: String(nextId++), title };
        scoresOf(ctx).push(score);
        return score;
    };

    return {
        getScoreList: (_params, ctx) => scoresOf(ctx),
        postScoreList: ({ title }, ctx) => add(ctx, title),
        getScore: ({ id }, ctx) => scoresOf(ctx).find(score => score.id === id) ?? scoreNotFound.create(),
        deleteScore: ({ id }, ctx) => {
            const list = scoresOf(ctx);
            const index = list.findIndex(score => score.id === id);
            if (index < 0) return false;
            list.splice(index, 1);
            return true;
        },
        importScores: ({ expected }, ctx, stream) => new Promise((resolve, reject) => {
            stream.signal.addEventListener('abort', () => reject(stream.signal.reason), { once: true });
            let imported = 0;
            stream.onMessage(title => {
                add(ctx, title);
                imported++;
                void stream.send({ imported }).then(() => {
                    if (imported === expected) resolve(imported);
                }, reject);
            });
        }),
    };
}

// ---- 3. Server -----------------------------------------------------------------------------

async function startServer() {
    // One shared connection; `context` runs once per HTTP call and is passed to handlers.
    const rpc = HttpServer.shared({
        context: (request): UserContext['data'] => {
            const user = request.headers.get('authorization')?.replace(/^Bearer /, '');
            if (!user) throw new HttpRpcError('Unauthenticated', 401);
            return { user };
        },
    });
    rpc.connection.register(scores, createScoreHandlers());

    // Mount-agnostic: this also works as Express middleware, e.g. app.use('/rpc', listener).
    const listener = httpRequestListener((request, options) => rpc.handle(request, options));
    const server = createServer(listener).listen(0, '127.0.0.1');
    await once(server, 'listening');

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        dispose: () => new Promise<void>(resolve => {
            rpc.dispose();
            server.closeAllConnections();
            server.close(() => resolve());
        }),
    };
}

// ---- 4. Client -----------------------------------------------------------------------------

describe('LinkRPC over HTTP', () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    let connection: LinkRpcConnection;
    let api: ReturnType<typeof connection.get<typeof scores>>;

    beforeEach(async () => {
        server = await startServer();
        // A normal LinkRpcConnection. No connection is opened until the first call.
        // In a browser, a relative base URL such as '/rpc' works too.
        connection = connectHttp(server.url, {
            headers: async () => ({ authorization: 'Bearer alice' }), // Resolved per call.
        });
        api = connection.get(scores);
    });

    afterEach(async () => {
        connection.close();
        await server.dispose();
    });

    it('calls unary methods via REST-style routes', async () => {
        expect(await api.postScoreList({ title: 'Cello Suite' })).toMatchInlineSnapshot(`
          {
            "id": "1",
            "title": "Cello Suite",
          }
        `);
        expect(await api.postScoreList({ title: 'Violin Concerto' })).toMatchInlineSnapshot(`
          {
            "id": "2",
            "title": "Violin Concerto",
          }
        `);
        expect(await api.getScoreList({})).toMatchInlineSnapshot(`
          [
            {
              "id": "1",
              "title": "Cello Suite",
            },
            {
              "id": "2",
              "title": "Violin Concerto",
            },
          ]
        `);
        expect(await api.deleteScore({ id: '1' })).toMatchInlineSnapshot(`true`);
        expect(await api.getScoreList({})).toMatchInlineSnapshot(`
          [
            {
              "id": "2",
              "title": "Violin Concerto",
            },
          ]
        `);
    });

    it('returns declared errors as typed values', async () => {
        const result = await api.getScore({ id: 'missing' });
        if (!isRpcFailure(result)) throw new Error('Expected a failure');
        expect(scoreNotFound.is(result)).toBe(true);
        expect(result.error).toMatchInlineSnapshot(`
          {
            "code": 1,
            "kind": "application",
            "message": "ScoreNotFound",
            "type": "ScoreNotFound",
          }
        `);
    });

    it('streams in both directions within one call', async () => {
        const progress: unknown[] = [];
        const call = api.importScores({ expected: 2 }, { onMessage: update => progress.push(update) });

        // Each send is a separate POST to <base>/$stream::send; the response stays open.
        await call.send('Cello Suite');
        await call.send('Violin Concerto');

        expect({ imported: await call, progress }).toMatchInlineSnapshot(`
          {
            "imported": 2,
            "progress": [
              {
                "imported": 1,
              },
              {
                "imported": 2,
              },
            ],
          }
        `);
        expect(await api.getScoreList({})).toMatchInlineSnapshot(`
          [
            {
              "id": "1",
              "title": "Cello Suite",
            },
            {
              "id": "2",
              "title": "Violin Concerto",
            },
          ]
        `);
    });

    it('cancels a streaming call', async () => {
        const call = api.importScores({ expected: 10 });
        const rejected = expect(call).rejects.toMatchObject({ code: -32800, message: 'user aborted' });
        await call.send('Partial import');
        // Advisory: the handler observes `stream.signal` and settles the call itself.
        await call.cancel('user aborted');
        await rejected;
    });

    it('is plain HTTP on the wire', async () => {
        const response = await fetch(`${server.url}/example.scores/scoreList?params=${encodeURIComponent('{}')}`, {
            headers: { authorization: 'Bearer alice' },
        });
        expect({ status: response.status, body: await response.json() }).toMatchInlineSnapshot(`
          {
            "body": {
              "id": 1,
              "jsonrpc": "2.0",
              "result": [],
            },
            "status": 200,
          }
        `);
    });

    it('rejects calls that fail authentication in the context factory', async () => {
        const anonymous = connectHttp(server.url);
        try {
            await expect(anonymous.get(scores).getScoreList({})).rejects.toThrow('HTTP request failed: 401');
        } finally {
            anonymous.close();
        }
    });

    it('serves the same handlers over a message transport, e.g. a WebSocket', async () => {
        const pair = new TransportPair();
        // A WebSocket server would attach its authenticated user as the message context instead.
        const serverSide = LinkRpcConnection.fromTransport<UserContext>({
            send: message => pair.a.send(message),
            setListener: listener => pair.a.setListener(listener
                && (message => listener({ ...message, context: { data: { user: 'alice' } } }))),
            dispose: () => pair.a.dispose(),
        });
        serverSide.register(scores, createScoreHandlers());
        const clientSide = LinkRpcConnection.fromTransport(pair.b);
        try {
            expect(await clientSide.get(scores).postScoreList({ title: 'Over WebSocket' })).toMatchInlineSnapshot(`
              {
                "id": "1",
                "title": "Over WebSocket",
              }
            `);
        } finally {
            clientSide.close();
            serverSide.close();
        }
    });
});
