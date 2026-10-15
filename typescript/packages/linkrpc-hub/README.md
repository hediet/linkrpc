# @hediet/linkrpc-hub

Standalone linkrpc hub that exposes a JSON-RPC-over-WebSocket endpoint.
Designed to run on a server behind a TLS-terminating reverse proxy
(Traefik, nginx, Caddy, …).

## Quick start

```sh
pnpm --filter @hediet/linkrpc-hub build
node packages/linkrpc-hub/dist/cli.js --port 7878 --token <shared-secret>
```

When `--token` and `--tokens-file` are both omitted, a one-shot token is
minted and printed at startup.

## Hosting a Node participant

`hostParticipant` composes the Node `startEndpoint` API with service registration
and per-connection cleanup. An application-specific `--stdio` flag can force
stdio; otherwise the endpoint defaults to `LINKRPC_ENDPOINT`:

```ts
import { hostParticipant } from '@hediet/linkrpc-hub/participant-host';

const host = await hostParticipant({
    endpoint: process.argv.includes('--stdio')
        ? { type: 'stdio' }
        : { type: 'fromEnv' },
    registrationMode: 'all',
    setup: ({ services, connection, serviceId, signal }) => {
        services.register(myInterface, myImplementation);
        // Return a disposable for connection-owned resources.
    },
});
await host.done;
```

Omitting `endpoint` is equivalent to `{ type: 'fromEnv' }`. An explicit
`{ endpoint: 'ws://localhost:7878', token: '...' }` uses the existing endpoint/token
options. Endpoint URIs, tokens, authentication, and listener behavior follow
[Node endpoint startup](../linkrpc/README.md#node-endpoint-startup):

| `LINKRPC_ENDPOINT` | Behavior |
| --- | --- |
| `stdio:` | Serve this process's stdin/stdout |
| `ws://host:port/path` or `wss://host/path` | Dial an existing endpoint |
| `unix:/path.sock` or `npipe://./pipe/name` | Dial a local socket or named pipe |
| `listen:ws://127.0.0.1:7878/rpc` | Accept WebSocket peers |
| `listen:unix:/path.sock` or `listen:npipe://./pipe/name` | Accept local peers |

There is no implicit endpoint if the environment is unset. Explicit stdio
ignores `LINKRPC_ENDPOINT`. Never write logs to stdout in stdio mode; use stderr.
Listeners require a nonempty token. Token precedence is explicit `token`, URI
token, then `LINKRPC_TOKEN`. WebSocket listeners use `ws:`; terminate TLS externally.

`registrationMode` is required and controls `services.register`:

| Mode | No granted namespace | Granted namespace available |
| --- | --- | --- |
| `all` | Register at root | Claim namespace; register at root **and** the granted service ID |
| `root` | Register at root | Register at root without querying or claiming a namespace |
| `grantedServiceId` | Fail before `setup` | Claim namespace; register only at the granted service ID |

Discovery is independent of transport, including stdio. Only a remote
method-not-found response to namespace discovery or an empty grant counts as
absence. Other errors, including failed claims, propagate instead of silently
falling back to root. An optional top-level `serviceId` selects a descendant of
the granted namespace; it rejects outside the grant, without a grant, or in
`root` mode.

`services.register` uses the same implementation at each selected address and
returns one disposable for all registrations. If registration fails, partial
registrations are rolled back. Service description/root-principal metadata
applies only to the named registration and requires a granted service ID.
Root exposure is explicit policy, not a replacement for application authorization.
The underlying `connection` remains available for explicit registration and
reflection (for example, `connection.enableReflection()`).

`setup` runs once per connection: once for dialing/stdio, or once per accepted
listener peer. Its `serviceId` is the claimed namespace, if any, and its `signal`
aborts on peer disconnect or host shutdown, including during setup. Keep
process-wide resources outside `setup`. Inbound application calls wait until
setup completes; namespace discovery remains live to avoid mutual startup waits.

`host.endpoint` contains the resolved address without credentials, including
the actual port when listening on port `0`. `host.done` waits for endpoint
shutdown and cleanup; a listener remains active when an individual peer leaves.
`await host.dispose()` closes all peers and awaits cleanup. A supplied
`AbortSignal` also stops the host. Listener peer failures are reported through
`onError` (default: `process.emitWarning`) without stopping other peers. Cleanup
failures are reported and also reject `host.done` on shutdown.

When the peer provisions a managed identity overlay, set the top-level
`managedIdentity: true` to sign outbound calls. A granted namespace alone does
not imply this overlay exists. The helper does not spawn a hub, retry connections,
install process signal handlers, or exit the process.

Migrating from the earlier API: replace `transport` with `endpoint` and the
required `registrationMode`; move `serviceId`/`managedIdentity` to the top level.
Use the connection, namespace, and signal from `setup`, not from the host handle,
since a listener can own multiple connections.

## CLI

```
linkrpc-hub [options]

  --host <h>             interface to bind (default 127.0.0.1)
  --port <n>             TCP port (default 7878)
  --path <p>             URL path of the WebSocket endpoint (default /)
  --identity <file>      admin keypair file (auto-generated on first run)
  --tokens-file <file>   one accepted token per line; reloaded on SIGHUP
  --token <t>            accepted token (repeatable)
  --open                 openMode — disable signature checks. LOCAL DEV ONLY.
  --allowed-origin <o>   restrict browser clients to this Origin (repeatable)
  --max-payload <bytes>  WebSocket max frame size (default 16 MiB)
  --health-path <p>      HTTP path returning 200 OK (default /healthz)
```

## Authenticating a connection

A client may present its token via `Authorization: Bearer <token>`

## Node client

```ts
import { connectToHubWs } from '@hediet/linkrpc-hub';

const hub = await connectToHubWs({
    url: 'wss://hub.example.com/',
    token: process.env.HUB_TOKEN!,
});
const result = await hub.channel.sendRequest('hubrpc.directory::list', {});
```

## Traefik recipe

Run the hub bound to loopback (or to a docker-internal interface) and let
Traefik handle TLS and the public hostname.

```yaml
# docker-compose.yml
services:
  linkrpc-hub:
    image: node:22-alpine
    command: node /app/packages/linkrpc-hub/dist/cli.js --host 0.0.0.0 --port 7878 --tokens-file /run/secrets/linkrpc-tokens
    volumes:
      - ./:/app
    secrets:
      - linkrpc-tokens
    networks:
      - infra
    labels:
      - traefik.enable=true
      - traefik.http.routers.linkrpc-hub.rule=Host(`hub.example.com`)
      - traefik.http.routers.linkrpc-hub.entrypoints=websecure
      - traefik.http.routers.linkrpc-hub.tls.certresolver=le
      - traefik.http.services.linkrpc-hub.loadbalancer.server.port=7878
      # liveness
      - traefik.http.services.linkrpc-hub.loadbalancer.healthcheck.path=/healthz

secrets:
  linkrpc-tokens:
    file: ./tokens.txt

networks:
  infra:
    external: true
```

Traefik proxies WebSockets transparently — no `Upgrade` header munging
needed. The hub respects `X-Forwarded-For`, so connection logs show
real client IPs.

## Security notes

- The hub starts in signed mode by default. Participants register
  prefixes with capabilities issued by the admin keypair (see the
  `linkrpc` README, Hub section). Without `--open`, every
  `hubAccess::request` / `hubAccess::extend` / `hubAccess::requestAccess`
  is rejected with `permissionRequired` — there is no interactive UI.
  Mint capabilities out-of-band using the admin keypair.
- Use **separate tokens per client** when you can. Token rotation: drop
  the new token into the tokens file and `kill -HUP $(pidof
  linkrpc-hub)`; old tokens are accepted until removed from the file.
- The admin keypair file is written with mode `0o600`. Treat it like an
  SSH host key.
