# @hediet/linkrpc-cli

Command-line and terminal-UI client for [`@hediet/linkrpc`](../linkrpc) endpoints.

The CLI speaks plain linkrpc over sockets, WebSockets, or a child process's
stdio: it connects to (or spawns) the server you point it at and drives it
through the JSON-RPC channel. Reflection
interfaces (`hubrpc.defaults`, `hubrpc.directory`, `hubrpc.schemas`) are
used to discover what the endpoint exposes; the CLI is otherwise generic — it
has no compiled-in knowledge of any particular interface.

## Profiles

The same shared commands are available through two profiles:

- `linkrpc` and `rpc` use the generic RPC profile. Schema validation defaults to
  `auto`, and endpoint environment variables are ignored unless `--use-env` is
  present.
- `linkrpc hub`, `rpc hub`, and `hub` use the Hub profile. Schema validation
  defaults to `required`, endpoint environment variables are enabled, and Hub
  signing, capability negotiation, topology, traffic, identity, and approval
  commands are available.

Inherited options may appear before the profile, between the profile and command,
or after the command:

```sh
linkrpc --endpoint ws://localhost:7700 hub call app::api::get
linkrpc hub --endpoint ws://localhost:7700 call app::api::get
linkrpc hub call app::api::get --endpoint ws://localhost:7700
```

Use `--validation auto|required|off` to override a profile default.

## Contexts

Contexts persist command defaults in the global user configuration store. A
folder context is keyed by its canonical folder path; no file is written into
that folder. Without `--context`, the CLI searches from the current directory
through its parents, then uses `:root`, then the immutable `:empty` context.

Context selectors are:

- An absolute or relative folder path.
- `id:<name>` for a named context.
- `:root` for the system-wide root above platform filesystem roots. On Unix,
  `/` is equivalent to `:root`.
- `:empty` for no stored defaults.

`LINKRPC_CONTEXT` selects a context when `--context` is absent;
`HUBRPC_CONTEXT` is its legacy alias. An explicit `--context` also suppresses
the Hub profile's normal environment endpoint overlay. Every context value can
still be overridden by a command-line option.

```sh
# Set endpoint and principal on the nearest context, creating one for cwd if needed.
hub context set --endpoint 'wss://hub.example?token=%' \
  --endpoint-token secret --principal user:work

# Create a named context from the effective values only after the call succeeds.
hub call app::api::get --new-context id:working-copy

# Apply this successful command's explicit overrides to the active context.
hub call app::api::get --validation off --context-set

hub context                         # same as `hub context show`
hub context resolve --context id:working-copy
hub context list
hub context remove --context .
hub call app::api::get --context :empty --endpoint ws://localhost:7700
```

Context creation and mutation are explicit: use `context set`,
`--context-set`, or `--new-context <selector>`. Context values, including
endpoint tokens, are currently stored inline and unencrypted. Principals are
stored by selector (`managed`, `user:<id>`, or `file:<path>`); their private
keys remain in the existing identity store.

## Endpoint syntax

An endpoint says **where the linkrpc server lives, and how to reach (or start)
it**. Pick one of:

| Flag / env                       | Meaning                                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--endpoint <uri>`               | A strict endpoint URI (see below).                                                                         |
| `--endpoint-cmd <command>`       | Spawn a _server_, hand it a fresh socket + token via `LINKRPC_ENDPOINT`/`LINKRPC_TOKEN`, then connect to it. |
| `--endpoint-cmd-stdio <command>` | Spawn a child and talk linkrpc over its stdio.                                                              |
| `LINKRPC_ENDPOINT` (env)          | A URI, or a legacy bare socket path / `ws://` URL. Token from `LINKRPC_TOKEN`; enabled by default in the Hub profile. |

Legacy `HUBRPC_ENDPOINT` and `HUBRPC_TOKEN` remain supported when the
corresponding `LINKRPC_*` variable is absent.

`--endpoint-token <token>` is accepted only when the selected explicit or
context endpoint contains exactly one `token=%` query parameter. Supplying it
without that placeholder, or with a literal `token=...`, is an error. This makes
token inheritance explicit: an endpoint override without `token=%` discards an
inherited context token. Environment endpoint/token pairs retain their legacy
fallback behavior. Put protocol-specific authentication directly in a
`ws-no-init:` query string. At most
one of `--endpoint`, `--endpoint-cmd`, `--endpoint-cmd-stdio` may be given;
they take precedence over the env var in that order.

### Endpoint URIs

Every endpoint is a valid `new URL()` — safe in env vars and logs:

| URI                                       | Transport                                  |
| ----------------------------------------- | ------------------------------------------ |
| `unix:/run/hub/hub.sock?token=…`          | unix-domain socket                         |
| `npipe://./pipe/linkrpc?token=…`           | Windows named pipe                         |
| `ws://host:7700?token=…` / `wss://…`      | LinkRPC WebSocket (token → `hubrpc::initialize`) |
| `ws-no-init://host:7700?…`                | Plain JSON-RPC WebSocket; skip LinkRPC initialization/signing, preserve query params |
| `cmd:?command=…` / `cmd:?argv=…&argv=…`   | spawn-as-server (`--endpoint-cmd`)         |
| `cmd-stdio:?command=…` / `?argv=…&argv=…` | spawn over stdio (`--endpoint-cmd-stdio`)  |

The command payload is either a single verbatim string (`?command=node%20server.js`,
split by the OS shell) or repeated, structure-preserving `argv` params
(`?argv=node&argv=server.js`).

```sh
linkrpc ls --endpoint-cmd-stdio "node ./server.js"
linkrpc call acme.mailer::email::send --param to=a@b.c \
  --endpoint 'wss://hub.example.com?token=%' --endpoint-token abc
LINKRPC_ENDPOINT=unix:/run/hub/hub.sock?token=abc linkrpc ls
```

## Commands

### Reflection

| Command                       | Purpose                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ls`                          | Explore the directory referral graph and its services/interfaces. Supports exact and prefix filters, regexp `--search`, `--format pretty\|json\|jsonl`, `--watch`, `--dump <file>`, and `--dump-patches <file\|->`. |
| `defaults`                    | Print the preset service/interface (wraps `hubrpc.defaults::get`).                                   |
| `schema show <interfaceId>[@hash]` | Print an interface schema (wraps `hubrpc.schemas::get`). `--method <name>`, `--json`.           |
| `schema hash <schema.json>` | Compute `computeInterfaceHash` for a local schema without connecting.                                  |
| `schema check-compat <interfaceId> <local.json>` | Compare a live interface schema with a local schema.                                  |

`hub ls --format json` waits for finite exploration and prints the final state.
`--format jsonl` emits progressive state while requests fan out: the first line
is `{ "type": "snapshot", "revision": n, "value": ... }` and each later line
is `{ "type": "patch", "revision": n, "patch": [...] }`, where `patch` is an
atomic RFC 6902 operation array. Applying the arrays in order reconstructs the
same state used by the terminal renderer. For compatibility, bare `--json`
still emits the original flat listing array and bare `--stream` still emits the
older timestamped patch-log format.

Add `--watch` to continue from that initial exploration into live directory
changes. A TTY repaints the human-readable referral forest; redirected watch
output defaults to JSONL:

```sh
hub ls --watch
hub ls --watch > hub-directory.jsonl
```

### Topology inspection

| Command | Purpose |
| ------- | ------- |
| `topology` | Query or watch topology providers, merge their graphs by node/port identity, and show route claims without treating them as service ownership. Supports repeatable `--source`, node/service/kind filters, regexp `--search`, and the same `pretty`, `json`, and reconstructable `jsonl` formats as `ls`. |
| `topology participants` | Find participant descriptors and optionally start a traffic watch for a selected node. |

With no `--source`, topology providers are discovered through
`hubrpc.directory`. Repeating `--source` queries exactly those providers and
does not start directory discovery. On gated hubs the CLI requests the needed
permissions in one consent operation before querying: wildcard directory plus
wildcard topology access for discovery, or exact topology access for all
explicit sources.

Topology JSON links may include transport details reported by the accepting
server. Built-in WebSocket listeners report their local and remote socket
addresses, URL path, and separately labeled `Origin`/`X-Forwarded-For` metadata;
Unix-domain sockets and Windows named pipes report their endpoint path. Origin
and forwarded-address values are untrusted raw request headers for diagnostics,
not authoritative peer identity.

```sh
hub topology --format json
hub topology --source app --source background-service --watch
hub topology --search 'telegram|workspace-42'
```

`hub ls --dump <file>` writes the complete directory graph, native per-directory
responses, flattened reachable listings, inaccessible branches, and reflected
schemas. `hub ls --dump-patches <file>` writes one RFC 6902 operation per line
while that same document is being explored; use `-` for stdout and add
`--watch` for continuing changes. Apply those operations in order to this
initial document:

```json
{
  "format": "linkrpc-hub-dump",
  "version": 2,
  "revision": 0,
  "complete": false,
  "schemasComplete": false,
  "root": {
    "target": { "kind": "root" },
    "state": "unexplored",
    "effectiveScopes": [{ "prefix": "" }],
    "depth": 0,
    "parents": [],
    "nativeListings": [],
    "watching": false
  },
  "directories": {},
  "listings": [],
  "inaccessible": [],
  "schemas": {},
  "schemaErrors": {}
}
```

### Calls

| Command                                               | Purpose                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call <method> [--param k=v]... [--params <json>\|-]` | Invoke a request. Method is form 1/2/3 (`send`, `iface::send`, `svc::iface::send`). Validates params against the live schema by default; pass `--no-validate` to skip. Use `@hash` on the method ref (e.g. `iface::send@a3f2b1`) to look up a pinned schema version for local validation. Reads stdin for `--params -`. |
| `notify <method> ...`                                 | Fire-and-forget notification. Same flags as `call`.                                                                                                                                                                                                                                                                     |
| `batch --call <method> ... [--notify <method> ...]`   | Run multiple calls and notifications sequentially on one connection. `--params`, repeatable `--param`, and `--no-validate` apply to the preceding operation. Fails fast unless `--continue-on-error` is set. Results are one JSON array; stream chunks are labeled on stderr. |
| `connection create [--timeout 30s] [--ttl 5min] [--schema source]` | Open the configured remote once in a detached broker and print its authenticated local `unix:` / `npipe:` endpoint. `--timeout` is transport inactivity; `--ttl` is an absolute lifetime. `--schema` overlays static LinkRPC reflection from a local JSON file or an HTTP(S) URL. |
| `connection status`                                   | Read lifecycle and buffer status from the broker configured by the effective endpoint. |
| `connection notifications [--after n] [--wait 25s] [--follow]` | Read incoming remote notifications from the broker's bounded buffer. `--follow` emits one JSON object per line and can run alongside calls. |
| `connection destroy`                                  | Stop the configured connection broker through its local overlay. |

The inherited `--schema <path-or-url>` option also overlays static
`hubrpc.defaults`, `hubrpc.directory`, and `hubrpc.schemas` reflection for
direct calls. Application requests still go to the selected endpoint. This is
especially useful with the RPC profile's `auto` validation mode and ordinary
JSON-RPC servers.

The former `connect`, `connection-status`, `notifications`, `disconnect`,
`hash`, `check-compat`, and `schema <interface>` spellings are accepted as
compatibility aliases.

### Identity and approvals

These commands resolve the same persistent identity selected by the global
`--principal` option and endpoint configuration. Approval commands discover and
validate Hub access manifests through the shared Hub approver client. The
resolved identity acts as the capability issuer/root: commands only show or
decide requests whose `acceptableRootIds` allow that root, while minted
capabilities retain the request consumer as their audience.

| Command                                  | Purpose |
| ---------------------------------------- | ------- |
| `identity show [--json]`                 | Print the resolved persistent principal. JSON output has a stable versioned shape. |
| `approval requests [--json]`             | List pending requests and copyable opaque request IDs. |
| `approval approve <request-id> [--json]` | Approve one pending request and mint its capability. |
| `approval deny <request-id> [--reason text] [--json]` | Deny one pending request. |
| `approval ui`                            | Open a live, interactive approval dashboard with request details, explicit confirmation, and denial reasons. |

Approval commands install and reuse a narrowly scoped self-issued capability for
recursive directory discovery and `hubAccessManifest` inspection/decisions.
They never call `hubAccess::requestAccess`; the Hub still admits that capability
only when the selected identity is a configured trusted root.
Discovery diagnostics are written to stderr, including every manifest source
and its pending-request count; `--json` stdout remains machine-readable.

```sh
hub --endpoint unix:/run/hub.sock?token=abc identity show --json
hub --endpoint unix:/run/hub.sock?token=abc approval requests --json
hub --endpoint unix:/run/hub.sock?token=abc approval approve ar1_c2VydmljZQByZXF1ZXN0
hub --endpoint unix:/run/hub.sock?token=abc approval ui
```

The approval dashboard watches all discovered manifests live. Use `Up`/`Down`
or `j`/`k` to select a request, `a` to review and confirm an approval, `d` to
deny with an optional reason, `PageUp`/`PageDown` for long authority lists,
`r` to refresh, and `?` for in-app help. The layout adapts to narrow and short
terminals, preserves the selected request as the queue changes, and disables
decisions while its authoritative manifest snapshot is stale. Request details
also identify the source `hubAccessManifest` service. If a successful decision
is followed by an equivalent pending request, the dashboard keeps it visible
and reports that the consumer may have retried instead of treating the write as
failed.

```sh
hub batch \
  --call acme.mailer::prepare --param draftId=42 \
  --notify acme.audit::record --params '{"event":"prepared"}' \
  --call acme.mailer::send --param draftId=42
```

### Persistent connections

`connection create` keeps one remote transport open in a detached process. It prints the
actual local socket endpoint; store that endpoint in `LINKRPC_ENDPOINT` for later
commands:

```sh
export LINKRPC_ENDPOINT="$(
  hub --endpoint 'ws-no-init://localhost:4123?tkn=…' \
    connection create --timeout 30s --ttl 5min --schema ./ahp-schema.json
)"

hub defaults
hub schema show ahp --method initialize
hub call initialize --params '{"channel":"ahp-root://","protocolVersions":["0.6.0"],"clientId":"hub"}'
hub call listSessions --params '{"channel":"ahp-root://","limit":50}'
hub connection notifications --follow
hub connection status
hub connection destroy
```

The endpoint contains a local authentication token and should be treated as a
secret. The broker handles `hubrpc.connectionBroker::status`,
`hubrpc.connectionBroker::readNotifications`, and
`hubrpc.connectionBroker::disconnect` locally. With `--schema`, it also handles
`hubrpc.directory`, `hubrpc.schemas`, and `hubrpc.defaults` from the static
document. Every other request or notification is forwarded to the persistent
remote connection. The schema file is validated, including its interface
hashes and references, before the broker detaches. `ws-no-init:` remotes remain raw
JSON-RPC: the local endpoint carries `broker=raw`, telling subsequent CLI
processes not to perform signing or remote LinkRPC initialization.

`defaultInterface` is independent of `services`: it describes the schema for
bare methods on an ordinary RPC server and does not implicitly add a directory
service. The terminal UI presents it as a synthetic `default` entry and keeps
its application methods bare on the wire.

The inactivity timer resets for every message sent or received on either side.
The TTL is measured from broker startup and never resets. Incoming remote
notifications are kept in a sequence-numbered bounded buffer (1,000 entries by
default; configure with `--notification-limit`).

### Offline

| Command                                   | Purpose                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `schema hash <schema.json>`                      | Compute `computeInterfaceHash` of a local schema. No connection.                                             |
| `schema check-compat <interfaceId> <local.json>` | Fetch live schema, run `isAssignable` against the local one. Verdict: identical / compatible-subset / incompatible. |
| `ping`                                    | One `defaults::get` round-trip with latency.                                                                        |

### Interactive

| Command | Purpose                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| `ui`    | Launch a terminal UI: tree of services on the left, schema-derived form on the right, results at the bottom. |

### Transport diagnostics

Pass `--log-transport` to print every raw JSON-RPC message sent and received,
including `hubrpc::initialize`. Output goes to stderr. This is lower-level than
`--log-messages`, which coalesces request flows. Raw transport logs can contain
tokens and sensitive payloads.

## Development

```sh
pnpm --filter @hediet/linkrpc-cli cli -- ls --cmd -- node ./your-server.js
pnpm --filter @hediet/linkrpc-cli test
```
