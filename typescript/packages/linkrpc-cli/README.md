# @hediet/linkrpc-cli

Command-line and terminal-UI client for [`@hediet/linkrpc`](../linkrpc) endpoints.

The CLI speaks plain linkrpc over sockets, WebSockets, or a child process's
stdio: it connects to (or spawns) the server you point it at and drives it
through the JSON-RPC channel. Reflection
interfaces (`hubrpc.defaults`, `hubrpc.directory`, `hubrpc.schemas`) are
used to discover what the endpoint exposes. Generic RPC commands work with any
reflected interface; compiled-in views add specialized CLI and TUI renderers.

## Views

Views target an **interface** or a **service** (including the main/root service),
not a service-name-prefix tree. The compiled-in typed registry is shared by the
CLI and terminal UI:

```sh
rpc view list
rpc --endpoint ws://localhost:7700 view targets graph --json
rpc --endpoint ws://localhost:7700 view open graph --target 'service::' --mode roots --json
rpc --endpoint ws://localhost:7700 view open graph --target 'service::' --root sessions --params '{}' --json
rpc --endpoint ws://localhost:7700 view open graph --target 'service::' --root sessions --mode watch --json
rpc --endpoint ws://localhost:7700 view open graph --target 'service::' --tui
```

`view list` is offline and prints modes and conditions, for example
`interface:tag(linkrpc.graph)` and `service:implements(tag(linkrpc.graph))`.
Conditions match interface IDs or tags, never template IDs. `view targets`
returns `{ targets, warnings }` with `--json`; targets include their stable `id`,
`kind`, service route, reporting directory, and implemented interfaces. IDs are
opaque within the selected endpoint/context and are not row numbers. They do
not pin schema hashes. The root service reported by the root directory has ID
`service::`; use the returned IDs for other targets.

For spawned/ephemeral endpoints, discover and open on **one connection**:

```sh
rpc view open graph --interface explorer.graph.v1 --root workspace --json --depth 2 \
  --endpoint-cmd-stdio '<server command>'
rpc view open graph --interface explorer.graph.v1 --root workspace --tui \
  --endpoint-cmd-stdio '<server command>'
```

Without `--target`, an exact `--interface` must resolve uniquely. `--service`
can narrow it, or select a service target by itself. Ambiguity is an error;
the CLI never chooses the first row. A main interface's default and qualified
reflection entries count as one implementation, preferring its default route.
Wrappers may choose `--tui` when stdin and stdout are terminals and otherwise
use `--json`; the CLI itself remains noninteractive unless `--tui` is explicit.

Advertised directory tags allow matching without downloading schemas.
Absent tags mean no advertised labels: there is no implicit legacy schema scan.
Interface-ID conditions still match without tags. Listing targets does
not start watches or load graph data. Opening re-resolves the target and its
latest schema through the reporting directory, validates the graph template
contracts and member mappings, and requires compatible roots/object stores.
Tags are untrusted discovery hints, not permissions or proof of capability.

Graph modes:

- `--mode roots`: list root names, interface IDs, and parameter schemas without
  starting a graph watch.
- `--mode snapshot` (default): materialize one root, then cancel its watch.
  `--json` emits the materialized value; unresolved references and cycles use
  `$ref` with `$missing`/`$cycle` markers.
- `--mode watch`: keep the root watch open until Ctrl-C. With `--json`, emit one
  complete materialized value per JSONL line.
- `--tui`: explicitly launch the Ink graph browser. There is no automatic
  TTY-dependent mode switch. Multiple roots open a picker; `--root` and
  `--interface` disambiguate. `p` edits JSON parameters, Enter opens a root,
  arrow keys navigate/expand/collapse, `r` returns to roots, and `q` exits.
  The browser fetches one reference level beyond expanded nodes, so collapsed
  rows can show their objects' `title` or `name`. This also refreshes collapsed
  titles when watched roots change. It fetches full objects (which may be large
  or trigger a deferred load), but does not recursively follow their references.
  This is a CLI browsing policy, not a graph protocol or preview feature.

`--depth`, `--path`, `--max-objects`, `--max-bytes`, `--max-rounds`,
`--timeout-ms`, and `--log-timing` bound or diagnose graph loading. The default
snapshot depth is 2; TUI loading is demand-driven. `--max-depth` bounds directory
discovery. Use `view open graph --help` for contribution-specific options.

Logging uses the canonical `linkrpc.logging` interface from
`@hediet/linkrpc-infra`. Its ID matches older producers even when directory
tags are absent. Listing targets does not fetch schemas or logs; opening checks
the selected interface's actual logging contract, so a tag alone is not enough.

```sh
rpc view targets logging --json
rpc --endpoint ws://localhost:7700 view open logging --interface linkrpc.logging --json
rpc --endpoint ws://localhost:7700 view open logging --interface linkrpc.logging --mode watch --json
rpc --endpoint ws://localhost:7700 view open logging --interface linkrpc.logging --tui
```

Snapshot uses the read-only `getLogSnapshot` operation. Watch uses `watchLog`
(initial snapshot followed by revisioned JSON document patches); a revision
gap triggers `getLogSnapshot` resynchronization. Each `--json` watch line is a
complete bounded frame with `revision`, `service`, `startedAt`, `state`,
`entries`, and `hidden` (earlier matching entries omitted by `--tail`).
Use `--level` and `--tail` for local display filtering and `--max-bytes` to
reject oversized authoritative documents (and stop the watch), not to truncate
them: truncation would corrupt subsequent positional JSON-pointer patches.
The protocol does not offer a server-side cursor, filter, or backfill beyond
its snapshot. Thus document retention still depends on the producer's size and
`--max-bytes` may stop a growing stream; `--tail` only bounds rendered rows.
No read or local filter change implicitly calls `setLogLevel`.
The TUI navigates entries with arrows/Page Up/Page Down; `p` pauses display,
`f` toggles follow, `l` cycles the local level filter, and `c` clears the
display locally, never remote logs. Clear tracks overlapping retained entries
across rolling buffers; when a replacement is ambiguous (such as duplicate
entries without stable IDs), entries may reappear rather than hiding new logs.
`q` closes the tab/standalone UI.

### Topology view

The contributed `topology` view inspects **one selected service's** canonical
`hubrpc.topology` interface. It is not the network-wide Hub topology scan.
Interface and service targets match the interface ID, without requiring tags;
opening validates the current canonical schema and uses the selected default
or qualified route.

```sh
rpc --endpoint ws://localhost:7700 view targets topology --json
rpc --endpoint ws://localhost:7700 view open topology --target 'service::'
rpc --endpoint ws://localhost:7700 view open topology --interface hubrpc.topology --service demo --json
rpc --endpoint ws://localhost:7700 view open topology --target 'service::' --mode watch --json
rpc --endpoint ws://localhost:7700 view open topology --target 'service::' --tui
```

Snapshot is the default and reads the full `getGraph` result. Watch subscribes
to `watchGraph` invalidations and re-fetches the full authoritative result;
`--json` emits one complete snapshot per JSONL line, including all nodes,
ports, links, transport metadata, descriptors and route claims. Fetch/watch
errors are reported, not treated as empty topology. `--timeout-ms` bounds
individual snapshot fetches. Closing a view cancels its watch and pending
fetches without closing the shared connection.

Text output uses `beautiful-mermaid` to draw Unicode boxes and **undirected**
connection lines. Placement and `from`/`to` endpoint roles do not imply RPC
direction. Generated node IDs link the diagram to complete node/link/route
records below it. Box labels are abbreviated ASCII-safe hints; those records
preserve complete Unicode labels. Remote text cannot supply Mermaid syntax.
Parallel links share a diagram line, but every link and exact port pair remains
in the numbered link records. Self-links, cycles and disconnected nodes are
retained. Unlisted endpoints are marked explicitly. If layout fails or exceeds
200 nodes/400 distinct connections, the text explains why the diagram is
omitted and still includes all authoritative records.

In the standalone TUI and regular UI's Topology tab, arrows scroll vertically
and horizontally, Page Up/Down and `[`/`]` page, Home/End jump vertically,
`r` refreshes the snapshot, and `?` shows the actual contributed command list.
The live diagram and records share one bounded, scrollable document. Normal
host keys still apply: `q`/Ctrl-C quit, and Tab/Escape navigate the regular UI.
No topology command changes the inspected service or interprets route claims
as proof of authority.

The regular `rpc ui` / `hub ui` has Methods and Schema tabs plus matching
contributed views. Tab cycles views and `v` switches interface/service scope;
the displayed conditions explain availability. Graph sessions cancel when
inactive or disconnected, ignore stale asynchronous results, and restore the
selected root/params after reconnection. Escape returns focus to the services
column. Static `--schema` profiles apply to both commands and UI.

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
| `contract export --output <file\|-> [--service <id>] [--max-depth <n>]` | Export a complete reusable static contract from live reflection. |
| `schema show <interfaceId>[@hash]` | Print an interface schema (wraps `hubrpc.schemas::get`). `--method <name>`, `--json`.           |
| `schema hash <schema.json>` | Compute `computeInterfaceHash` for a local schema without connecting.                                  |
| `schema check-compat <interfaceId> <local.json>` | Compare a live interface schema with a local schema.                                  |
| `codegen --input <bundle> --interface <id> --name <name> --output <file> [--preserve-wire-schema] [--check]` | Generate a TypeScript interface definition from a validated offline static bundle. |
| `codegen --input <contract> --output <file> [--names <json>] [--check]` | Generate all reusable interface definitions and typed root/service/default/bare bindings. |

`codegen` uses the same `{ interfaceSchemas, services?, defaultInterface?, bareInterfaces? }`
bundle parser and interface-hash verification as static reflection. `--check`
compares the generated source with the output file and exits unsuccessfully if
the file is missing or stale; it never overwrites in check mode.

```sh
linkrpc --endpoint-cmd-stdio "node server.js" contract export --output contract.json
linkrpc codegen --input contract.json --output generated.ts
linkrpc codegen --input contract.json --output generated.ts --check
# Existing per-interface generation remains available:
linkrpc codegen --input contract.json --interface demo.echo --name echoInterface \
  --output echo.ts --preserve-wire-schema
```

Omit both `--interface` and `--name` for whole-contract generation. Every interface
is emitted once, with canonical wire schemas preserved, and each binding refers
to that definition. For `demo.echo`, default names include `demoEchoInterface`,
`demoEchoRoot`, `demoEchoDefault`, and (for bare prefix `Runtime.`) `runtimeBare`.
A service `worker` produces `workerDemoEchoService`. If names collide, supply a
local `--names` JSON file containing `interfaceNames` (`"id@hash": "exportName"`)
and/or `bindingNames` (`"root:id@hash"`, `"service:serviceId:id@hash"`,
`"default"`, or `"bare:prefix"` keys). Unknown keys and colliding overrides fail.

Contract export queries directory interfaces, `defaults.get`, and
`defaults.listBindings`; it fails explicitly if discovery is inaccessible,
truncated or depth-limited, default metadata is incomplete, or schemas cannot be
retrieved and hash-verified. It writes the output only after successful completion.
`--service` selects a reflection scope; default/bare bindings describe that scope's
preset routes, not additional service-qualified foreign methods. No default or
bare bindings are guessed from directory listings.

`ls --dump` remains the diagnostic graph format, including directory provenance.
It is not a static contract and is not an input to `contract export`. Export a
contract directly from the endpoint for offline generation instead.

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
| `json-rpc-stdio <serviceId> [--params <json>]`         | In the Hub profile, expose `<serviceId>::jsonRpcConnection::connectRaw` as newline-delimited JSON-RPC on stdin/stdout. Diagnostics remain on stderr. |

The inherited `--schema <path-or-url>` option also overlays static
`hubrpc.defaults`, `hubrpc.directory`, and `hubrpc.schemas` reflection for
direct calls. Application requests still go to the selected endpoint. This is
especially useful with the RPC profile's `auto` validation mode and ordinary
JSON-RPC servers.

The former `connect`, `connection-status`, `notifications`, `disconnect`,
`hash`, `check-compat`, and `schema <interface>` spellings are accepted as
compatibility aliases.

`json-rpc-stdio` lets JSON-RPC tools consume a remote service without knowing
about LinkRPC. Each non-empty input line must contain one complete JSON-RPC
frame, and each remote frame is written as one JSON line:

```sh
hub --endpoint unix:/run/hub.sock json-rpc-stdio language-server
```

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
    connection create --timeout 30s --ttl 5min --schema ./service-schema.json
)"

hub defaults
hub ls
hub schema show example.counter --method get
hub call get --params '{}'
hub connection notifications --follow
hub connection status
hub connection destroy
```

This example assumes the schema document declares `example.counter` as its
default interface and the remote JSON-RPC service exposes a bare `get` method.
Protocol-specific schema generators and initialization sequences belong in
the consuming application, not the generic CLI.

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
