# @vscode/hubrpc-hub

Standalone hubrpc hub that exposes a JSON-RPC-over-WebSocket endpoint.
Designed to run on a server behind a TLS-terminating reverse proxy
(Traefik, nginx, Caddy, …).

## Quick start

```sh
pnpm --filter @vscode/hubrpc-hub build
node packages/hubrpc-hub/dist/cli.js --port 7878 --token <shared-secret>
```

When `--token` and `--tokens-file` are both omitted, a one-shot token is
minted and printed at startup.

## CLI

```
hubrpc-hub [options]

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
import { connectToHubWs } from '@vscode/hubrpc-hub';

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
  hubrpc-hub:
    image: node:22-alpine
    command: node /app/packages/hubrpc-hub/dist/cli.js --host 0.0.0.0 --port 7878 --tokens-file /run/secrets/hubrpc-tokens
    volumes:
      - ./:/app
    secrets:
      - hubrpc-tokens
    networks:
      - infra
    labels:
      - traefik.enable=true
      - traefik.http.routers.hubrpc-hub.rule=Host(`hub.example.com`)
      - traefik.http.routers.hubrpc-hub.entrypoints=websecure
      - traefik.http.routers.hubrpc-hub.tls.certresolver=le
      - traefik.http.services.hubrpc-hub.loadbalancer.server.port=7878
      # liveness
      - traefik.http.services.hubrpc-hub.loadbalancer.healthcheck.path=/healthz

secrets:
  hubrpc-tokens:
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
  `hubrpc` README, Hub section). Without `--open`, every
  `hubAccess::request` / `hubAccess::extend` / `hubAccess::requestAccess`
  is rejected with `permissionRequired` — there is no interactive UI.
  Mint capabilities out-of-band using the admin keypair.
- Use **separate tokens per client** when you can. Token rotation: drop
  the new token into the tokens file and `kill -HUP $(pidof
  hubrpc-hub)`; old tokens are accepted until removed from the file.
- The admin keypair file is written with mode `0o600`. Treat it like an
  SSH host key.
