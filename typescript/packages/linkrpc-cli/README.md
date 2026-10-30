# @hediet/linkrpc-cli

Command-line and terminal-UI client for [`@hediet/linkrpc`](../linkrpc) endpoints.

The CLI speaks plain linkrpc over sockets, WebSockets, or a child process's
stdio: it connects to (or spawns) the server you point it at and drives it
through the JSON-RPC channel. Reflection
interfaces (`hubrpc.defaults`, `hubrpc.directory`, `hubrpc.schemas`) are
used to discover what the endpoint exposes. Generic RPC commands work with any
reflected interface; compiled-in views add specialized CLI and TUI renderers.

## Directory discovery and consent

`linkrpc hub ls` first tries directory reads using its current identity and
capabilities. On `permissionRequired`, it asks the connected hub's approval
service for short-lived access to `hubrpc.directory::list` on that exact
directory service, then retries once. Watch mode also requests `watch`;
schema/member dump modes additionally request `hubrpc.schemas::get`.
Unsigned connections (`--no-sign`) do not request capabilities.

Timeouts, missing methods, and transport errors never trigger consent. Plain
output shows inaccessible directories and their errors. `--format json` and
`--format jsonl` include an `inaccessible` report; legacy `--json` preserves its
flat array and reports failures on stderr.

Approval is not automatic authorization: the destination must accept the
issued capability's root. If the connected hub cannot obtain a grant from an
accepted issuer, discovery still reports that directory as inaccessible.
No trust roots are added and no service is made public.

## Daemon-owned endpoints (`hub services`)

`hub services` manages processes and existing connections **through the daemon
management RPC API**, including on the local machine. The CLI may bootstrap a
local per-user daemon, but never supervises the managed workload itself.

The daemon executable and implementation are bundled in this package's `dist/`
(`daemon.js`). Installing the CLI does not require publishing or installing
`@hediet/linkrpc-hub-daemon` separately. The daemon source package is a build-only
workspace dependency; bootstrap launches the bundled executable with Node.js.

Before using a daemon, the CLI checks its `requiredInterfaces` against the
interface IDs and hashes advertised through reflection. Each required hash must
be supported; no package/protocol version or automatic update policy is used.
A legacy daemon without reflection, a missing interface, or a different hash
fails with an actionable error before the workload is created:

```sh
hub services restart
```

This explicit command sends the local daemon's management `shutdown` RPC,
waits for exit, starts the CLI's bundled daemon, and rechecks its interfaces.
It disconnects Hub clients and stops workloads. Ephemeral endpoints disappear;
persistent definitions retain their existing restart/desired-state semantics.
It does **not** modify OS autostart registrations. A selected endpoint/config or
routed manager is never silently replaced: update it on its execution host, or
explicitly select the default local daemon with
`hub --context :empty --no-use-env services restart`.

OS autostart integration for `hub services` is postponed. Bootstrap/restart
does not invoke the OS service manager, and persistent endpoint creation does
not enable login startup. Existing registrations are left untouched and may
still start a different build at the next login.

```sh
# Create a context explicitly and run attached (daemon-owned lifetime):
hub services run --new-context . -- node server.js

# Bind the service lifetime to this terminal's CLI process:
hub services run --foreground --id temporary -- node server.js

# Another terminal in this context:
hub services list
hub ls
hub services logs --follow

# Detach an attached pipe console with Ctrl+D on an empty line.
# Or launch detached from the outset:
hub services run --id worker --detach -- node worker.js
hub services attach --id worker
hub services stop --id worker

# Run in a pseudoterminal (TTY); detach with Ctrl+B, then d:
hub services run -x -t --id shell -- pwsh

# Stop and replace an existing endpoint with the same ID:
hub services run --force --id worker --detach -- node worker.js

# Retain a definition and resume it when the daemon next starts:
hub services run --id worker --persistent --restart on-failure --detach -- node worker.js
hub services configure --id worker --restart always
hub services stop --id worker     # stays stopped across daemon restarts
hub services start --id worker
hub services remove --id worker

# Connect rather than spawn (URI is interpreted on the daemon host):
hub services connect --id peer --target-endpoint ws://localhost:7000 --restart on-failure
```

`--id` defaults to `main`. Namespace defaults to the selected context's canonical
folder path (case-normalized on Windows), its named context identity (`id:<name>`),
or `:root` where no folder context applies. The `:empty` context has no namespace.
Override it with `hub services --namespace <name> ...`. `--namespace` belongs
only to `services`; it does not select or filter services for `call`, `ls`, or
`ui`. `--context` only selects an existing context;
`--new-context .` creates one before the attached command starts. A namespace
does not determine a remote working directory.

Definitions default to ephemeral: they disappear after stop, completion, or
terminal failure. `--persistent` retains a definition. `--restart` is `never`
(default), `on-failure`, or `always`; for connections, disconnect counts as
failure. Persistent restarting endpoints resume when the daemon next starts,
unless explicitly stopped. This does not arrange for the daemon itself to start
after OS restart. Persistent `never` definitions remain stopped after daemon
restart.

Endpoint selection keeps the usual explicit flag / environment / context
precedence, including `HUBRPC_*` aliases. An explicit `--context` suppresses the
ambient endpoint unless `--use-env` is passed. On an effective Hub connection,
the manager defaults to `<hubServiceId>/daemon`; override with
`--daemon-service`. Both that option and `--namespace` can be saved using
`context set`. An unreachable or unauthorized selected manager is an error,
**never** a fallback to local execution.

```sh
hub --endpoint ws://remote-host:7000 --daemon-service remote/daemon \
  --context . services run --id worker --cwd /srv/project --detach -- node worker.js
```

Remote launches require `--cwd` on the execution host. Commands, files, and
environment values are not uploaded. Arguments after `--` are an executable
and argv, not a shell command string. Execution host, namespace, ID, command,
and working directory are printed before creation. Local fallback is used only
when no endpoint/config is selected. `run`, `connect`, and `start` may bootstrap
the local daemon; reads never do. Without a selected endpoint, `hub ls`, `call`,
and other connected commands (including `ui`) use the local Hub whenever its
daemon runs, whether or not any services do. If it is not running, the command
reports an error without starting the daemon. A configured endpoint that fails
never falls back to the local Hub.
Use the full `serviceId` returned by `services list` for RPC
calls; endpoint IDs and published RPC service IDs are different things.

Process readiness defaults to connecting to the provided `LINKRPC_ENDPOINT`
and token. Use `--no-rpc` (short form `-x`) for non-LinkRPC programs: they become
ready on spawn, without a participant socket or managed identity. Ambient
`LINKRPC_ENDPOINT`/`LINKRPC_TOKEN` and legacy `HUBRPC_*` connection variables
are not inherited in this mode; explicitly supplied `--env` values are preserved.
`--readiness spawned` alone still provisions RPC, but does not wait for connection.
`--no-rpc --readiness connected` is an error. Detached launches
wait up to 30 seconds for readiness; a timeout leaves the endpoint managed and
inspectable. Attachments stream bounded recent output and supervisor notices,
forward input and interrupts, and do not own the process lifetime. `logs`
prints recent output; `logs --follow` keeps streaming; `attach --read-only`
observes without sending input.

Every process endpoint has a console that implements the standard
[`linkrpc.console.v1`](../linkrpc-infra/README.md#process-consoles-linkrpcconsole)
interface template: the daemon's management interface contains one template
instance, `consoles`, whose params are the endpoint address. `hub services attach`
calls it directly. The generic `attach` command works with **any** participant
that instantiates the template, not only daemon-managed processes. It discovers
consoles through the `linkrpc.console` directory tag and reads the wire methods
and params schema from reflection:

```sh
hub attach                                   # list consoles and their params schemas
hub attach hub/daemon --params '{"namespace":"d:\\work\\app","id":"main"}'
rpc --endpoint ws://localhost:7000 attach my/service --read-only
```

`--params` (default `{}`) is validated against the instance's reflected params
schema. When a service has several console instances, select one with
`--instance` or `--interface`.

#### Pipe and TTY consoles

Processes default to a **pipe console**: stdout and stderr stay separate, and
the program sees no terminal. `-t` / `--tty` runs it in a pseudoterminal
(ConPTY on Windows) instead: output is a single terminal stream, programs enable
colors, prompts, and full-screen interfaces, and attachments can resize it. The
TTY adopts the size of the most recent interactive attachment. Joining
attachments receive the **current screen** (rendered by a headless terminal in
the daemon, including scrollback) instead of a raw byte replay, so full-screen
programs display correctly.

| | Pipe console | TTY console (`-t`) |
| --- | --- | --- |
| Local input | Line editing; Enter sends the line | Raw: every key goes to the program |
| Ctrl+C | Interrupts (sends SIGINT where supported), or stops a foreground owner | Goes to the program (an interrupt in a shell) |
| Ctrl+D | On an empty line: detach, or stop a foreground owner | Goes to the program (EOF in a shell) |
| Detach | Ctrl+D on an empty line (Ctrl+] also works) | The detach keys: Ctrl+B, then d by default |

TTY detach keys use Docker's `--detach-keys` syntax: comma-separated keys, each
a character or `ctrl-<key>` (`a`-`z`, `@`, `[`, `\`, `]`, `^`, `_`). The default
is `ctrl-b,d`, tmux's binding. Docker's `ctrl-p,ctrl-q` does not work in VS
Code's integrated terminal, which handles Ctrl+P (Quick Open) and, on Windows,
Ctrl+Q itself; Ctrl+B passes through. Keys of an incomplete sequence are held
back and forwarded unchanged when the sequence does not complete. Change the
sequence per command or store it in a context:

```sh
hub --detach-keys ctrl-p,ctrl-q services attach --id shell
hub context set --detach-keys 'ctrl-],q'     # store it in the active context
```

Choose another sequence when the attached program uses Ctrl+B itself, for
example tmux running inside the console.

Windows pipes have no interrupt channel: there, Ctrl+C in a pipe attachment
prints a hint instead of terminating the shared process; use `-t` when the
program should receive Ctrl+C. When a TTY attachment ends, the CLI resets
terminal modes the program may have enabled (mouse, bracketed paste, alternate
screen). Piped input is forwarded as received; EOF on a pipe does not cancel the
attachment or stop the service, so it can continue producing output.

The attached-console banner prints a `hub services attach ...` command for
reattaching, and detaching prints it again. Duplicate `run`/`connect` errors
print the same recovery command without stopping or replacing the existing
endpoint, and point to `--force`. Hints include the selected
context, namespace, endpoint ID, environment policy, and explicit connection
overrides. Reuse the same environment when `--use-env` is shown and the same
working directory for relative connection/config paths. Explicit tokens and
command-environment values are replaced with `<same ...>` placeholders rather
than exposed in the hint.

`--force` stops an existing endpoint with the same address and replaces it with
the new definition in one daemon operation. This also applies to persistent
endpoints (their stored definition is replaced) and to a foreground endpoint
owned by another terminal: that terminal prints a notice and its command ends.

`run --foreground` instead creates the process inside a lifetime-owning
management RPC. Ctrl+C, SIGTERM, cancellation, or a detected CLI disconnect
causes the daemon to stop the process tree and remove the endpoint, even when
the CLI is forcibly killed and cannot run an exit handler. On a remote Hub,
cleanup begins once the disconnect is detected. The normal graceful stop
timeout applies when a stop request can be delivered: SIGTERM on POSIX or
disconnecting an active RPC connection. On Windows, a process without an
RPC connection has no graceful stop channel, so its tree is terminated
immediately instead of waiting out an idle five-second timeout.

Other terminals can discover/call RPC services and attach as observers; closing
an observer does not stop it. The detach key of the owning terminal (Ctrl+D on
an empty line, or the TTY detach keys) cancels the foreground command and
therefore stops the service, rather than detaching it.
`--foreground` conflicts with `--detach` and `--persistent`; the management API
also rejects making a foreground endpoint persistent later. Restart policies
apply only while the owning call is alive. Hub replacement stops foreground
endpoints rather than restoring them without an owner. Ordinary `run` and
`attach` retain their daemon-owned lifetime behavior.

With a pipe console, interactive terminals use local line editing: with
unfinished text, Ctrl+D retains the line and uses normal delete-under-cursor
behavior.

#### Plain stdio programs

The [counter example](examples/counter.mjs) prints one number per second and has
no LinkRPC dependency. From this package directory, with an existing context:

```sh
# Background: the counter survives the launching CLI.
hub services run -x --id counter --detach -- node examples/counter.mjs
hub services attach --id counter
# Ctrl+D on an empty line detaches without stopping the counter.
hub services logs --id counter --follow
hub services stop --id counter

# Foreground: closing this CLI stops and removes the counter.
hub services run --no-rpc --foreground --id counter -- node examples/counter.mjs
# A different terminal can still attach while the owner is running:
hub services attach --id counter
```

The [interactive counter](examples/interactive-counter.mjs) also accepts input.
It prints `tick 1`, `tick 2`, ... once per second and responds to `count`,
`reset`, `echo <text>`, and `quit`:

```sh
hub services run -x --foreground --id interactive -- node examples/interactive-counter.mjs
# Type: count, echo hello, reset, or quit (then Enter).
# Or start with --detach instead of --foreground and attach separately:
hub services attach --id interactive
```

`count` prints the current number, `reset` sets it to zero, `echo hello` prints
`[<current count>] hello`, and `quit` exits the service. Requests can come from
any attachment; all attachments see the responses and ticks.

Create a context first with `hub context --new-context .` if needed. Multiple
attachments receive the same output; interactive attachments share the process's
stdin. Use `logs --follow` for a read-only observer. Restart/persistence policies
work for plain processes too.

`services list` reports `rpc: false` for these processes. They do not publish
application RPC methods under their reserved `serviceId`: other Hub participants
attach to their console (`hub services attach`, or generically through the
daemon's `consoles` template instance) to observe output and
send input, in both foreground and background mode. When the program adds
LinkRPC support, omit `-x` to provision its RPC connection. Add `-t` when the
program expects a terminal.

Connections support initialized LinkRPC socket/WebSocket endpoints. Forwarding
preserves method names and signatures, rather than rewriting root services
under a new prefix. The target must serve the assigned namespace (available
from `services list` or by querying the Hub's granted namespace over the
bidirectional connection). Connecting does not own or stop the target process.

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

Profiles are presets, not restrictions on shared call behavior. Signing defaults
to off in `linkrpc`/`rpc` and on in `linkrpc hub`/`rpc hub`/`hub`.
Use `--sign` or `--no-sign` to override that default. `--principal` chooses
the identity; it does not by itself enable signing. Signed calls present stored
grants; unsigned calls do not load or present the capability bag.
`caps` management is available only in the Hub profile, but shared `call`
supports `--cap:request` and the `--cap:allow-*` options in both profiles.

Setting precedence is explicit CLI overrides, then enabled environment
overrides, then saved context values, then profile defaults. Environment
overrides currently supply endpoint/token settings, not signing settings.
`--sign`/`--no-sign` are saved with `context set` or `--context-set` and can be
removed with `context set --unset sign`. The existing environment-selection
policy remains: an explicit `--context` suppresses the Hub's default environment
override unless `--use-env` is supplied.

`--cap:request` enables signing when the signing setting is unspecified; it
does not change validation/environment defaults or switch command profiles.
An explicit or saved `sign: false` conflicts with capability operations;
override it with `--sign`. `--cap:request --validation off` is also rejected.
These calls illustrate equivalent settings:

```sh
linkrpc hub call files::fs::read --cap:request --p:path=/docs/a
linkrpc call files::fs::read --cap:request --validation required --use-env --p:path=/docs/a

# Reuse stored grants through the generic profile, without requesting:
linkrpc call files::fs::read --sign --validation required --p:path=/docs/a
```

Use `--validation auto|required|off` to override a profile default.

## Contexts

Contexts persist command defaults in the global user configuration store. A
folder context is keyed by its canonical folder path; no file is written into
that folder. Without `--context`, the CLI searches from the current directory
through its parents, then uses `:root`.

Context selectors are:

- An absolute or relative folder path.
- `id:<name>` for a named context.
- `:root` for the system-wide root above platform filesystem roots. On Unix,
  `/` is equivalent to `:root`. The root context **always exists**: until you
  store defaults in it, it has none. It cannot be created with `--new-context`,
  and removing it resets it to no defaults. Because it applies to every folder
  without its own context, `context set` and `--context-set` change it only when
  selected explicitly (`--context :root`).
- `:empty` for no stored defaults, selected only explicitly. It is immutable.

`LINKRPC_CONTEXT` selects a context when `--context` is absent;
`HUBRPC_CONTEXT` is its legacy alias. An explicit `--context` also suppresses
the Hub profile's normal environment endpoint overlay. Every context value can
still be overridden by a command-line option.

```sh
# Explicitly create a context for cwd with endpoint and principal defaults.
hub context set --new-context . --endpoint 'wss://hub.example?token=%' \
  --endpoint-token secret --principal user:work

# Create a named context from the effective values only after the call succeeds.
hub call app::api::get --new-context id:working-copy

# Apply this successful command's explicit overrides to the active context.
hub call app::api::get --validation off --context-set

hub context                         # same as `hub context show`
hub context create id:working-copy  # same as: hub context --new-context id:working-copy
hub context resolve --context id:working-copy
hub context list                    # always includes :root
hub context remove --context .
hub context set --context :root --principal user:work   # defaults for folders without a context
hub context remove --context :root  # resets :root to no defaults
hub call app::api::get --context :empty --endpoint ws://localhost:7700
```

Context creation is explicit: use `hub context create <selector>` or
`--new-context <selector>` (for example, `hub context --new-context .` creates a
folder context from effective defaults and shows it).
`--context <selector>` only selects an existing context; missing-context errors
show how to create it. `context set` and `--context-set` update existing contexts
and do not implicitly create a cwd context. Use `context set --new-context <selector>`
to create one with initial defaults. Combining `--context existing` with
`--new-context new` derives the new context from an existing one; it never creates
the selected source context.
Context values, including
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
| `LINKRPC_ENDPOINT` (env)          | A URI, or a legacy bare socket path / `ws://` URL. Token from `LINKRPC_TOKEN`; enabled by default in the Hub profile and with `--use-env` in the RPC profile. |

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
| `linkrpc:local`                           | CLI discovery of the current user's local LinkRPC Hub |
| `unix:/run/hub/hub.sock?token=…`          | unix-domain socket                         |
| `npipe://./pipe/linkrpc?token=…`           | Windows named pipe                         |
| `ws://host:7700?token=…` / `wss://…`      | LinkRPC WebSocket (token → `hubrpc::initialize`) |
| `ws-no-init://host:7700?…`                | Plain JSON-RPC WebSocket; skip LinkRPC initialization/signing, preserve query params |
| `cmd:?command=…` / `cmd:?argv=…&argv=…`   | spawn-as-server (`--endpoint-cmd`)         |
| `cmd-stdio:?command=…` / `?argv=…&argv=…` | spawn over stdio (`--endpoint-cmd-stdio`)  |

`linkrpc:local` resolves the local daemon's application endpoint and credentials
from its discovery file, honoring `LINKRPC_HUB_HOME`. It never starts the daemon
and works even when no managed services are running. It is a CLI lookup URI,
not a wire transport or a service filter; raw SDK endpoint parsers do not resolve
it. It works as a CLI flag, a saved context endpoint, or an endpoint environment
variable. Explicit selection overrides ambient endpoint settings:

```sh
hub --endpoint linkrpc:local ui
hub --endpoint linkrpc:local ls
hub context --new-context . --endpoint linkrpc:local
```

Credentials come exclusively from discovery; `--endpoint-token` is rejected for
this URI. No username-derived pipe address needs to be hardcoded. By contrast,
the implicit local fallback requires at least one running managed endpoint.

`cmd:` children can use `startEndpoint({ onConnection })` without parsing any
transport flags: the parent injects `LINKRPC_ENDPOINT` and `LINKRPC_TOKEN`.
The CLI accepts one authenticated callback connection and exposes the child's
interfaces directly. It does not wait for a hub service-namespace claim.
The existing root overlay still supplies namespace (`local`) and optional
provisioned-identity services for hub-aware children. Full routing-hub startup
remains a separate `connectViaLocalHub` helper.
Child stdout/stderr are diagnostics and appear on the CLI's stderr; parent stdout
remains reserved for command results. Startup fails if the child exits, cannot
spawn, or does not connect within 10 seconds.

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

### Consoles

| Command                       | Purpose                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `attach [serviceId] [--params <json>] [--instance <name>] [--interface <id>] [--read-only]` | Attach to a [`linkrpc.console.v1`](../linkrpc-infra/README.md#process-consoles-linkrpcconsole) template instance of any service, found through the `linkrpc.console` tag; without a service, list consoles. Pipe consoles use line editing (Ctrl+D on an empty line detaches); TTY consoles receive raw keys (`--detach-keys`, default Ctrl+B, then d, detaches). |

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
| `codegen --service <id> [--max-depth <n>] ... --output <file> [--check]` | Same as above, but reflect the live service (like `contract export --service`) instead of reading a bundle. |

`codegen` uses the same `{ interfaceSchemas, services?, defaultInterface?, bareInterfaces? }`
bundle parser and interface-hash verification as static reflection. `--check`
compares the generated source with the output file and exits unsuccessfully if
the file is missing or stale; it never overwrites in check mode.

`--input` and `--service` are mutually exclusive. `--service <id>` runs the same
reflection as `contract export --service <id>` in memory (with the same failure
rules, see below) and feeds the result to codegen, so no intermediate bundle file is
needed. `--max-depth` is only valid with `--service` and defaults to unlimited;
because discovery fails rather than truncating, a single service rarely needs it.
`--check` works with `--service` too, to detect when a checked-in file drifted from
the live service.

```sh
linkrpc --endpoint-cmd-stdio "node server.js" contract export --output contract.json
linkrpc codegen --input contract.json --output generated.ts
linkrpc codegen --input contract.json --output generated.ts --check
# Existing per-interface generation remains available:
linkrpc codegen --input contract.json --interface demo.echo --name echoInterface \
  --output echo.ts --preserve-wire-schema
# One step against a live hub service, without an intermediate bundle:
linkrpc hub codegen --service hediet/pc2/stream-deck --interface hediet.streamDeck \
  --name streamDeckInterface --output streamDeck.ts
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
| `connection create --timeout <duration\|inf> [--ttl <duration\|inf>] [--schema source]` | Open the configured remote once in a detached broker and print its authenticated local `unix:` / `npipe:` endpoint. Explicitly supply at least one of `--timeout` (transport inactivity) or `--ttl` (absolute lifetime). Omitted limits are `inf`. `--schema` overlays static LinkRPC reflection from a local JSON file or an HTTP(S) URL. |
| `connection status`                                   | Read lifecycle and buffer status from the broker configured by the effective endpoint. |
| `connection notifications [--after n] [--wait 25s] [--follow]` | Read incoming remote notifications from the broker's bounded buffer. `--follow` emits one JSON object per line and can run alongside calls. |
| `connection destroy`                                  | Stop the configured connection broker through its local overlay. |
| `json-rpc-stdio <serviceId> [--params <json>]`         | In the Hub profile, expose `<serviceId>::jsonRpcConnection::connectRaw` as newline-delimited JSON-RPC on stdin/stdout. Diagnostics remain on stderr. |
| `json-rpc-export --target-endpoint <uri> --serviceId <id> --path <path> ...` | In the Hub profile, export multiple JSON-RPC factories through one authenticated raw WebSocket listener. |
| `http-export [--port <n>] [--host <address>]... [--base-domain <domain>] [--auth browser\|none]` | In the Hub profile, serve loopback ports of Hub compute nodes at `<port>.<service>.localhost` over HTTP and WebSocket; browsers must be approved per service and port range unless `--auth none`. |

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

`json-rpc-export` maps multiple Hub JSON-RPC services to distinct paths on one listener:

```sh
linkrpc hub json-rpc-export \
  --target-endpoint "listen:ws://127.0.0.1:8123" \
  --target-token "$EXPORT_TOKEN" \
  --target-token-query-param tkn \
  --serviceId foo --path /foo \
  --serviceId bar --path /bar
```

Each `--serviceId` must be followed by its `--path`; a leading slash is optional. Missing pairs, duplicate paths, and unsupported endpoints fail before connecting to the Hub. Each WebSocket client opens an independent `<serviceId>::jsonRpcConnection::connectRaw` session, including clients on the same route. Requests, responses, notifications, and server-initiated requests pass unchanged, without a `hubrpc::initialize` handshake.

The nonempty export token is separate from the source Hub credentials. Clients authenticate during the WebSocket upgrade with `Authorization: Bearer <token>` or a configured query parameter. Without `--target-token-query-param`, the accepted query names are `tkn` (VS Code sends its `connectionToken` under this name) and `token`. Supplying the repeatable option replaces those defaults: for example `--target-token-query-param connectionToken --target-token-query-param api_key` accepts either custom name. Bearer headers remain accepted. Exactly one credential is required: duplicate query parameters, multiple Authorization headers, or a header combined with a recognized query parameter are rejected, even if their values match. Unrecognized parameters are not credentials.

Alternatively, configure the listener token in the target URI as `listen:ws://127.0.0.1:8123?token=...`; this configuration syntax is independent of the accepted client query names. Readiness output never includes the token. Unknown routes return 404 and missing/invalid/ambiguous credentials return 401 without opening an upstream session. Anyone holding this token can access all configured routes using the export process's Hub identity; use a narrowly scoped identity and protect the token. Client credentials are consumed by the listener and never forwarded to the upstream factory.

Only `listen:ws://` TCP listeners are currently supported, not named pipes or TLS listeners. Bind loopback for local use. For remote access, terminate TLS in a trusted reverse proxy rather than sending tokens over unencrypted networks. The gateway limits connections to 100, frames to 100 MiB (104,857,600 bytes), and pending input per client to 200 MiB / 1024 frames; outgoing buffered data is also limited to 200 MiB. Slow consumers and failed upstreams close only their own connection. Factories must open within 30 seconds.

The command stays in the foreground until SIGINT/SIGTERM, then closes clients and the listener. Use the existing Hub daemon/service lifecycle to supervise it; this command neither installs a service nor starts remote AHP hosts. Diagnostics and the bound address (including an assigned port when using port 0) go to stderr.

### HTTP export

`http-export` serves loopback TCP ports of Hub compute nodes (services offering
`linkrpc.computeNode.tcpForward`) as `*.localhost` sites. `*.localhost` always
resolves to this machine, so no DNS setup is needed:

```sh
linkrpc hub http-export            # listens on 127.0.0.1:80 and [::1]:80
```

| URL | Shows |
| --- | --- |
| `http://localhost/` | Services that can forward TCP (`?format=json` for JSON). |
| `http://hediet--tablet--compute.localhost/` | Listening ports of `hediet/tablet/compute` with each owning process's name, command line, and working directory (needs `linkrpc.computeNode.ports`). |
| `http://3000.hediet--tablet--compute.localhost/` | Port 3000 of that compute node, including WebSocket upgrades. |

A service is always exactly one label directly below `localhost`, its
segments joined with `--`. Browsers treat `localhost` as a public suffix, so
each service is its own site: pages of one machine get no `SameSite` cookies
from another machine's apps and cannot set cookies for them, as with direct
access. The ports of one service share that site, as the ports of `localhost`
do on its machine. A service ID whose segments are not plain lowercase DNS
labels, or whose label would exceed 63 characters, is written as a hashed label
instead, `<slug>--h<hash>`, which the gateway resolves against the services it
can reach. The index pages link to the right form.

There is no gateway credential and no origin check of its own. Instead, the
gateway translates between a forwarded app's own origins
(`http://localhost:<port>` on its machine) and their exported names, so the
app's own Host, Origin, CORS, redirect, and cookie checks behave as they do for
a browser on its machine:

| Header | Translation |
| --- | --- |
| `Host` | Always `localhost:<port>`. The gateway itself only accepts `*.localhost` names, so DNS rebinding cannot reach it. |
| `Origin`, `Referer` | Exported names of the same service map to `http://localhost:<port>`. Other services' exported names and foreign sites pass unchanged. This machine's own loopback origins have no counterpart on the target: `Origin` becomes `null` and `Referer` is dropped. |
| `Location`, `Access-Control-Allow-Origin` | URLs naming the target machine's loopback map to their exported names. |
| `Set-Cookie` | Host-only and `Domain=localhost` cookies get the service's domain (e.g. `Domain=hediet--tablet--compute.localhost`), which reaches that machine's exported ports, as such cookies reach all of its ports there. Cookies for other domains are dropped, as a browser there would reject them. `__Host-` cookies stay host-only, so they reach only one exported port. |

WebSocket upgrades are translated the same way in both directions. No
`X-Forwarded-*` headers are added. Absolute loopback URLs inside response
bodies are not rewritten, so they fail rather than reach this machine. Bind
loopback only: anyone who can reach the listener can use the export process's
Hub identity to reach every forwarded port.

**Browser approval (prototype, on by default).** A browser must be approved for
each service it opens, for a port range it chooses; `--auth none` restores the
behavior above.

- A browser without approval for the service and port it opens is redirected
  to `http://localhost/.linkrpc/login`. That page asks which ports of the
  service the browser may use, prefilled with the opened port. The gateway
  holds a signing key for the browser and asks the Hub's approvers
  (`hubAccess::requestAccess`) to let it call `tcpForward::multiplex` for those
  ports and `ports::listListening` for that range, both on exactly that
  service. The page shows a code, the first eight characters of the browser
  key (`id:key:AbCdEfGh…` → `AbCd-EfGh`), and continues by itself once
  approved. Approve only requests whose principal starts with the code your
  browser shows.
- The gateway then signs that browser's calls with the browser's key and
  granted capabilities, so compute nodes enforce the service and port range,
  not just the gateway. The ports page lists only ports in the range.
- A browser keeps one approval per service. Opening a port outside it shows
  the form again, prefilled with a range that also covers the new port;
  approving it replaces the previous range of that service.
- `localhost` keeps the browser's session cookie. Each service site
  (`<service>.localhost`) gets its own cookie on first visit through a
  single-use, 30-second ticket from `localhost`, bound to that site and to a
  state cookie set by the site. Cookies are `HttpOnly`, `Secure`
  (Chromium treats `http://*.localhost` as secure), and never reach forwarded
  apps; apps cannot set them either. Only the form on the approval page can
  ask approvers for access (`Sec-Fetch-Site: same-origin`).
- Requests without `Sec-Fetch-*` and `Origin` headers (curl, scripts, agents)
  are not affected and keep using the gateway's identity, as does the list of
  services at `localhost`. Browser requests other than page navigations get
  `401` until the browser is approved for their port.
- Approved sessions are kept in `--session-file` (default
  `%LOCALAPPDATA%\linkrpc\http-export\browser-sessions-<port>.json` or
  `$XDG_STATE_HOME/linkrpc/http-export/…`); it contains the browser keys.
  Sessions from gateways before port ranges are not loaded: those browsers ask
  again.

The gateway's own pages (`localhost` and `<service>.localhost`, HTML and JSON)
show command lines, which may contain secrets. They answer only top-level
navigations, same-origin requests, and clients that send no `Sec-Fetch-*` or
cross-origin `Origin` header (e.g. `curl`); other requests, including fetches,
scripts, and iframes from forwarded apps of the same machine, get `403`. They
send no CORS headers, forbid framing (`frame-ancestors 'none'`,
`X-Frame-Options: DENY`), and set `nosniff`, `no-store`, `no-referrer`, and
same-origin resource and opener policies. Command lines and working directories
are only shown for processes the compute node may inspect, e.g. not for
elevated or other users' processes on Windows.

Each service and port shares one `tcpForward.multiplex` session (up to 10
logical connections, 8 of them for pooled HTTP keep-alive), closed after five
idle minutes.

### Hub MCP aggregation

`linkrpc hub mcp` is a lightweight stdio MCP server that discovers services
exposing `vscode.mcp-forward` in the selected Hub and aggregates their tools.
No service IDs, filters, or principal overrides are required:

```json
{
  "servers": {
    "hub-mcp": {
      "type": "stdio",
      "command": "linkrpc",
      "args": ["hub", "mcp"]
    }
  }
}
```

Endpoint/context/environment and identity selection follow the normal Hub CLI
rules. An explicit endpoint can be supplied before `mcp`, for example
`linkrpc hub --endpoint npipe://./pipe/my-hub mcp`. Signing and capability
negotiation remain enabled by default; discovery does not bypass authorization.
Inaccessible directories and failed servers are reported on stderr; stdout
contains only MCP protocol frames.

The command watches directory changes, refreshes changed tool lists (including
paginated lists), and retries failed connections while they remain advertised.
Tool names use a readable prefix and a stable hash of service ID plus tool name,
remaining unique and MCP-safe even for long service paths. Descriptions identify
the source service. Disconnecting stdio closes this client's forwarding sessions.
This version aggregates tools, not resources, prompts, or sampling.

The producer stays separate:

```sh
linkrpc hub mcp-forward --serviceId <authorized-service-id> -- component-explorer mcp -p <config> --use-daemon --no-daemon-autostart
```

Manage that producer and `component-explorer serve -p <same-config>` with your
workspace daemon. The aggregator opens lightweight MCP connections; it does not
start workspace builds or explorer daemons. Each forwarded connection spawns
the configured MCP child, so producers must use attach-only commands when
heavyweight services are managed separately.

### Participant proxy

`proxy` stands in for a participant on the hub: the participant is either this
process's stdin/stdout (`--stdio`) or a `--target-endpoint*`. It keeps full
LinkRPC semantics (service ids, streaming, cancellation) and adds what the
participant cannot do itself:

- By default the proxy signs nothing: calls the participant makes are
  forwarded to the hub as they are (unsigned, or keeping the `$hubrpc`
  envelope the participant attached). `--sign-as [principal]` re-signs every
  such call as `principal` (`managed`, `user:<id>`, or `file:<path>`; default:
  `--principal`, i.e. the managed Hub identity) and requests capabilities for
  those calls, so a participant without signing support can call services
  behind `forwardChecking`. This lends the participant that identity.
  `--no-outbound` drops the participant's calls instead. The global `--sign`
  is rejected here to keep this choice explicit.
- `--claim <serviceId>` registers the service id (that registration is signed
  as `--principal`) and forwards requests the hub routes to it to the
  participant unchanged, keeping callers' signatures.

```sh
# A Rust client that cannot sign yet reaches a gated remote service.
# Point it at this cmd-stdio endpoint and address calls to the remote service id:
#   cmd-stdio:?argv=linkrpc&argv=hub&argv=proxy&argv=--stdio&argv=--sign-as
hub proxy --stdio --sign-as
hub proxy --stdio --sign-as user:automation

# Serve a stdio program under a service id (equivalent to `tunnel`).
hub proxy --claim my/service --no-outbound --target-endpoint-cmd-stdio "my-server --stdio"
```

With `--stdio`, the proxy exits when stdin closes. `tunnel <serviceId>` is
`proxy --claim <serviceId> --no-outbound`; with `--bidi` it forwards the
target's calls unsigned.

### Capabilities

`linkrpc hub caps list [--json]` lists the selected principal's stored capabilities,
including expired grants. `caps request <methodRef>` requests and stores a
capability without executing the method. `call --cap:request` ensures the same
scope is available before executing the call. These explicit operations enable
signing even for generic-profile `call` and require a LinkRPC endpoint.
Without `--cap:request`, `call` never requests new capabilities (including
reflection access). When signing is enabled, it signs with the selected
identity and presents stored grants. Generic calls remain unsigned unless
`--sign` or a saved signing setting enables signing.
Missing or unusable grants fail with guidance to retry using `--cap:request`;
unguarded methods and plain RPC endpoints remain usable without capabilities.

Both request forms share `call`'s method references, `--params`, `--param`, and
`--p:<name>` shortcuts, including nested argument overrides and dynamic help.
Concrete arguments become exact constraints by default. Repeat
`--cap:allow-param 'key=<matcher JSON>'` to relax individual **top-level** parameters:

```sh
linkrpc hub --endpoint "$ENDPOINT" caps list --json

# Request permission without reading the file:
linkrpc hub --endpoint "$ENDPOINT" caps request files::fs::read \
  --p:path=/workspace/readme.txt \
  --cap:allow-param 'path={"prefix":"/workspace/"}'

# Ensure permission for that scope, then read a file:
linkrpc --endpoint "$ENDPOINT" call files::fs::read --cap:request \
  --p:path=/workspace/another.txt \
  --cap:allow-param 'path={"prefix":"/workspace/"}'
```

Matchers are `{"exact":value}`, `{"enum":[value,...]}`,
`{"prefix":"string-prefix"}`, `{"subsetOf":["allowed","array","items"]}`,
`{"range":{"min":3000,"max":3999}}` (an integer within both bounds, inclusive),
or `{"any":true}`. Constraints must be compatible with the reflected,
Zod-derived method schema, and the concrete example arguments must satisfy
both that schema and every constraint. Required and unknown keys are checked.
Nested matcher paths are unsupported by the capability protocol.
`any` allows every JSON value, so it is accepted only for unconstrained schema
properties; use `prefix`/`enum`/`subsetOf` for typed properties. A prefix cannot
be proven compatible with a finite enum or a formatted string; use an enum
of valid values instead. Remote reflection cannot reproduce arbitrary
producer-side custom Zod refinements.

Instead of naming the key in `--cap:allow-param`, attach a shortcut immediately
after a `--param key=value` or `--p:key=value` assignment:

```sh
linkrpc hub call files::fs::read --cap:request \
  --p:path=/workspace/readme.txt --cap:allow-prefix=/workspace/
```

| Shortcut | Matcher | Meaning |
| --- | --- | --- |
| `--cap:allow-prefix <string>` | `prefix` | Any string beginning with the prefix |
| `--cap:allow-any` | `any` | Any JSON value; requires an unconstrained schema property |
| `--cap:allow-enum <JSON array>` | `enum` | One entire value from a non-empty array of alternatives |
| `--cap:allow-subset <JSON string array>` | `subsetOf` | An array containing only allowed strings; empty arrays, repetitions, and any ordering are allowed |

Each parameter can have only one explicit constraint. Mixing shortcuts with
`--cap:allow-param` for the same key, repeating constraints, or reassigning a
constrained parameter is an error. Shortcuts do not attach to `--params` JSON
or across intervening options. With variadic `--param`, a shortcut attaches
to the last assignment. The same schema and example-value validation applies
to shortcuts and explicit matchers.

Value-taking options support both `--option=value` and `--option value`.
Parameter assignment itself still uses `key=value`, e.g.
`--param path=/docs/a` or `--param=path=/docs/a`. Use the equals form for
dash-prefixed values. Quote JSON and strings containing spaces.
`--cap:request`, `--cap:allow-any`, and `--cap:delegate` are switches with no value.
The older `--request-cap`, `--allow-param`, and `--duration` spellings have
been replaced by the `--cap:` options.

Schema validation is mandatory for explicit requests: `--no-validate` and
`--validation off` are rejected. On `call`, `--cap:allow-param` requires
`--cap:request`. For explicit requests, a method reference's `@hash` also pins
the permission; signed calls include that hash in their signed metadata.
The default requested duration is `persistent`; `--cap:duration shortLived` and
`--cap:duration longLived` are also supported. The Hub still decides what to grant.
`--cap:delegate` also requests `canDelegate`, so the identity can issue narrower
capabilities for that scope to other identities, e.g. a service it runs; a
stored grant without delegation does not satisfy such a request.
One-shot approval cannot satisfy a reusable scope and is rejected.

Fresh durable grants for the selected principal are reused when they cover
the **entire requested scope**, not merely the example call. Broader prefixes,
enum sets, subset sets, and unconstrained grants can cover narrower requests.
New grants are saved through the principal's existing capability bag and are
available to later invocations using the same identity. Denial or an insufficient
grant fails without executing the method. `caps request` outputs the granted
capabilities and a `reused` flag; `call --cap:request` retains normal call output.

### Identity and approvals

These commands resolve the same persistent identity selected by the global
`--principal` option and endpoint configuration. Approval commands discover and
validate Hub access manifests through the shared observable approval client in
`@hediet/linkrpc-infra/approval`. The CLI owns formatting and the terminal UI;
its interactive adapter supplies `createTerminalConsentPrompt` from
`@hediet/linkrpc-hub` when no prompt is provided. Generic infrastructure callers
must pass an explicit `ConsentPrompt` to `runInteractive(signal, prompt)`. The
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

An unavailable child directory or manifest does not block requests and decisions from healthy sources. The listing reports partial results, and JSON output includes a `warnings` array when sources are unavailable. Directory warnings identify the failed service and the directories advertising it. Failed manifests contribute no cached requests; a failure of root discovery or the aggregate snapshot still fails the command rather than reporting a healthy empty inbox.

Hub calls (`call`, `ls`, …) additionally present a self-issued capability for
every call. A Hub accepts it only where the identity is a configured trusted
root, so a root needs no approval for its own calls; elsewhere it is ignored
and stored or requested grants apply as before. A Hub answers a trusted root's
access request at once, without parking it for approval.

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

Every `connection create` (including the legacy `connect` alias and context-owned
connections) requires an explicit `--timeout` or `--ttl`. Stored context limits
do not satisfy this requirement or supply omitted limits: each omitted limit is
`inf`. Both flags accept durations such as `250ms`, `30s`, `5min`, or `2h`, or the
literal `inf`. Finite limits must fit a Node timer (1 through 2147483647 ms).
Unlimited limits schedule no timer; status reports their `timeoutMs`/`ttlMs` as
the JSON string `"inf"`, while finite values remain millisecond numbers.
Broker startup has a separate 60-second readiness deadline; `inf` does not
disable startup error detection.
Command-environment endpoints also retain their existing 10-second deadline for
the spawned application to connect back. This is distinct from the transport
initialize handshake and the broker's lifetime limits. A slow application must
establish its endpoint before that deadline. Startup failures report the broker's
underlying error, including the last 16384 characters of command-environment child
stdout/stderr, rather than only the broker process's exit code.

Use a folder context to own the broker without environment overrides:

```sh
rpc --endpoint-cmd "node ./server.js" connection create --timeout inf --new-context .
rpc call example::ping --no-validate
rpc context remove --context .
```

Only `connection create --new-context <selector>` assigns ownership. Removing
that context, replacing its endpoint/token/config, or unsetting the owned endpoint
or token stops the owned broker before saving the mutation. This also applies to
persisted `--context-set` overrides. Unrelated edits and temporary overrides do
not stop it. Saving an existing endpoint or deriving another context with
`--new-context` does not transfer or duplicate ownership.

Already-stopped local brokers permit cleanup. Authentication, RPC, permission,
and other shutdown errors fail explicitly and preserve the context for retry.
The shutdown RPC has a five-second response deadline.
If saving fails after shutdown, the old context remains available for cleanup.
Contexts created by older versions have no ownership metadata and are not
automatically stopped. An unlimited broker without an owning context must be
stopped explicitly with `connection destroy`.

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
