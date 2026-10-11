# HTTP connections

`@hediet/linkrpc/http/client` exposes the browser-compatible `connectHttp`.
`@hediet/linkrpc/http/server` separately exposes `HttpServer`; browser clients
do not import server code. The server core uses Web `Request`/`Response`, while
the Node listener adapter is exported from `@hediet/linkrpc/node`. Applications keep
using `LinkRpcConnection.get`, `register`, interface schemas, declared errors,
and the existing streaming API. No WebSocket, initialize handshake, HTTP
annotations, or separately maintained route bindings are required.

This is a request-level HTTP adapter, not a general bidirectional message
transport. Independent reverse requests/notifications are not supported yet.

## Shared contract and handlers

```ts
import { z } from 'zod';
import {
    defineInterface, requestType, type InterfaceHandlers,
} from '@hediet/linkrpc';

export const scores = defineInterface({ id: 'example.scores' }, {
    getScoreList: requestType(z.object({}), z.array(z.string())),
    postScoreList: requestType(z.object({ title: z.string() }), z.number()),
    importScores: requestType(
        z.object({ count: z.number().int().positive() }),
        z.number(),
    ).withStream({
        client: z.string(),
        server: z.object({ received: z.number() }),
    }),
});

export type AppContext = { readonly data: { readonly userId: string } };

export function createHandlers(): InterfaceHandlers<typeof scores, AppContext> {
    const byUser = new Map<string, string[]>();
    const titles = (userId: string) => {
        let result = byUser.get(userId);
        if (!result) {
            result = [];
            byUser.set(userId, result);
        }
        return result;
    };

    return {
        getScoreList: (_params, ctx) => [...titles(ctx.data.userId)],
        postScoreList: ({ title }, ctx) => titles(ctx.data.userId).push(title),
        importScores: ({ count }, ctx, stream) => new Promise((resolve, reject) => {
            let received = 0;
            stream.signal.addEventListener('abort', () => reject(stream.signal.reason), { once: true });
            stream.onMessage(title => {
                if (received >= count) return;
                titles(ctx.data.userId).push(title);
                received++;
                const progress = received;
                void stream.send({ received: progress }).then(() => {
                    if (progress === count) resolve(progress);
                }, reject);
            });
        }),
    };
}
```

The handler context deliberately requires only application data. The same
handlers can be registered on a WebSocket connection whose transport supplies
that context; they contain no HTTP-specific code.

## Shared server connection (Node)

```ts
import { createServer } from 'node:http';
import { HttpServer } from '@hediet/linkrpc/http/server';
import { httpRequestListener } from '@hediet/linkrpc/node';
import { scores, createHandlers } from './scores.js';

const http = HttpServer.shared({
    // Demo identity only. Authenticate requests here in production.
    context: () => ({ userId: 'demo-user' }),
});

http.connection.register(scores, createHandlers());

const listener = httpRequestListener((request, options) => http.handle(request, options));
createServer(listener).listen(3000);

// At shutdown: http.dispose(); server.close();
```

The handler is mount-agnostic: it matches routes such as `/scores/scoreList`
relative to wherever it is mounted. The listener also works as Express/Connect
middleware, e.g. `app.use('/rpc', listener)`. It reads the mount-relative
`req.url`, and when earlier middleware like `express.json()` already parsed the
body, it reuses `req.body` instead of the consumed stream. Requests never stream
their bodies (client stream input uses separate POSTs), so this loses nothing.
Note that `express.json()` defaults to `strict: true` and rejects non-object
params such as a bare string.

Each handler receives `{ data, request, peer }`. Application context is computed
once per initial request and never stored as mutable state on the shared
connection. The shared connection owns the registry, while a per-request
`JsonRpcChannel` owns each call's streams and cancellation. Closing one request
does not affect the other calls.

`http.handle(request, { path?, parsedBody? })` also works directly with hosts
that support Web `Request`/`Response`, e.g.
`Bun.serve({ fetch: request => http.handle(request) })`. Without `path`, the
whole URL path is the route, i.e. the handler is mounted at the root.
The Node adapter flushes response headers and does not buffer the response.

## Per-request connections

```ts
const handlers = createHandlers();
const http = HttpServer.perRequest({
    context: () => ({ userId: 'demo-user' }),
    accept(connection) {
        connection.register(scores, handlers);
        connection.onDidClose(() => {
            // Release any resources allocated specifically for this request.
        });
    },
});
```

`accept` is synchronous; asynchronous authentication belongs in `context`.
The adapter creates the channel before constructing the connection and closes
the connection when the request finishes, times out, or disconnects. Stream
input POSTs go back to the original call, not to a new connection.

`context.peer` is that request's `LinkRpcConnection`. Reverse requests and
independent notifications through it reject explicitly. Likewise, a shared
server's `connection.get(...)` does not select or broadcast to remote callers.
Handler `stream.send(...)` is supported in both server modes.

## Browser or Node client

```ts
import { connectHttp } from '@hediet/linkrpc/http/client';
import { scores } from './scores.js';

const connection = connectHttp('http://localhost:3000', {
    // Relative base URLs work in browsers, e.g. '/rpc' when mounted with app.use('/rpc', ...).
    credentials: 'same-origin',
    // headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
});
const api = connection.get(scores);

await api.postScoreList({ title: 'Cello Suite' });
console.log(await api.getScoreList({}));

const call = api.importScores({ count: 2 }, {
    onMessage: progress => console.log(progress.received),
});
await call.ping();
await call.send('Violin Concerto');
await call.send('Piano Sonata');
console.log(await call); // 2

connection.close();
```

Headers are resolved once per call and reused for its input POSTs. No automatic
retries are performed. A lost HTTP response does not prove the operation was
not executed.

`await call.cancel(reason)` sends advisory cancellation and leaves the response
open for the handler's result/error. `call.dispose()` abandons local tracking
and aborts the fetch. `connection.close()` does this for every active call.
Both client and handler ping/pong use the existing LinkRPC controls.

## Routes and bodies

The route codec is exported as `httpRoute(method)`.

| Wire method | HTTP route relative to the mount point |
| --- | --- |
| `example.scores::getScoreList` | `GET /example.scores/scoreList` |
| `example.scores::postScoreList` | `POST /example.scores/scoreList` |
| `example.scores::importScores` | `POST /example.scores/importScores` |
| `team/a::example.scores::deleteScore` | `DELETE /team%2Fa/example.scores/score` |
| Bare `getScoreList` with a registered default binding | `GET /scoreList` |

Prefixes `get`, `post`, `put`, `patch`, and `delete` are recognized only before
an uppercase letter; the remaining name has its first letter lowercased.
Other names default to POST without stripping anything. HEAD is not inferred,
because an RPC response requires a body. Group members use their existing
flattened wire names. Namespace/member segments are encoded independently.

GET parameters use a single `params` query value containing JSON:
`?params=%7B%7D`. Other verbs carry params directly as `application/json`.
An absent body/query value represents undefined params, not `{}`. Notifications
are identified from the registered schema and acknowledged with HTTP 204;
acknowledgment does not guarantee completion of asynchronous handler work.

Shared-server routes are cached and lazily rebuilt after the connection's
directory-change event invalidates them, including registration, default/bare
bindings, and registration disposal. Per-request connections build their own
route table after registration. Ambiguous verb/path mappings
are configuration errors; HTTP does not guess which handler to invoke.
Existing interface reflection remains unchanged: consumers derive the same
routes from reflected member names.

Unary responses use the normal JSON-RPC result/error envelope (ID `1`, scoped
to this HTTP call) with HTTP 200. Application failures retain LinkRPC's declared
error semantics. Transport-level failures use non-2xx HTTP status codes and
become `HttpRpcError`s on the client.

## Streaming wire format

A member declaring either client or server stream schemas returns
`application/x-ndjson`. Headers include an opaque `LinkRPC-Call` handle.
The response carries existing `$stream::send` notifications and ends with
exactly one JSON-RPC result/error response. Missing final responses, mismatched
IDs, invalid frames, and frames after the final response are rejected.

Client input and controls use:

```http
POST <base>/$stream::send
Content-Type: application/json
LinkRPC-Call: <handle from the initial response>

{"jsonrpc":"2.0","method":"$stream::send","params":{"requestId":1,"dir":"toCallee","payload":"Violin Concerto"}}
```

All calls use wire ID `1` within their isolated channel. The opaque handle
selects the channel; wire IDs cannot select another user's call. The client
serializes input POSTs and awaits their HTTP 204 acceptance. Early sends wait
for response headers. Concurrent input POSTs from custom clients are rejected.

The initial request body always finishes immediately. Browser Fetch never needs
to upload and read a response simultaneously, including for GET streaming calls.
There is no single-request full-duplex mode.

## Hosting and resource limits

- Defaults: 1 MiB per body/frame, 64 pending client input messages, 1024 active
  server calls, and a 5-minute **total** call timeout. Configure `maxFrameBytes`,
  `maxPendingStreamMessages`, `maxActiveCalls`, and `timeoutMs` on the appropriate
  side. Long-running calls need a larger timeout; ping does not extend it.
- Server sends apply stream backpressure. Unawaited sends are bounded to four
  times the frame limit; overflow fails that call.
- Authenticate in `context`. Stream input must present the same Authorization,
  Cookie, and Origin headers as the initial request and a live opaque handle.
  `authorizeStream` can additionally enforce revocation or other policy.
- Handle credentials and authentication failures in your HTTP application.
  Throw `HttpRpcError(message, status)` for an intentional HTTP rejection.
  Unexpected errors propagate to the host; the Node adapter logs and emits 500.
- The call handle is sensitive. Use HTTPS and do not log it. This adapter is not
  a substitute for LinkRPC signature/capability verification or application
  authorization.
- Cookie-authenticated applications must enforce their own Origin/CSRF policy.
  CORS is host-owned. Cross-origin clients need preflight support, allowed
  request headers, and `Access-Control-Expose-Headers: LinkRPC-Call`.
- Disable proxy response buffering. `Cache-Control: no-store` and
  `X-Accel-Buffering: no` are emitted for streams.
- Stream input must reach the process owning the call. Multiple instances
  require affinity/routing; there is no distributed session store.
- Independent server notifications and arbitrary reverse RPC are not exposed.
  They require a separate reverse channel, not this request stream.
