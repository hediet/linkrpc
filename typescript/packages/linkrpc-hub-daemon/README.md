# @hediet/linkrpc-hub-daemon

A per-user LinkRPC hub that runs in the background, starts at login, and keeps
configured services running. Applications on the same machine connect through a
private local socket. A JSON config file declares the services; saving it applies
changes immediately, restarting only what changed.

```
OS login (Run key / LaunchAgent / systemd user unit)
  └─ hub daemon ─┬─ LinkRPC hub ── private app endpoint ◄── applications
                 ├─ service supervisor ─┬─ service "github"
                 │                      └─ service "indexer"
                 └─ management endpoint ◄── CLI, tray app
```

The [desktop app](https://github.com/hediet/linkrpc-studio/tree/main/apps/linkrpc-hub-desktop) adds a tray icon
and a management window. It is a client: closing it never stops the hub.

## Quick start

```sh
linkrpc-hub-daemon start              # run in the background now
linkrpc-hub-daemon autostart enable   # and at every login
linkrpc-hub-daemon status
linkrpc-hub-daemon config path        # the file to edit
```

## Configuring services

### Dynamically managed endpoints

The [CLI's `hub services` commands](../linkrpc-cli/README.md#daemon-owned-endpoints-hub-services)
use `linkrpc.managedEndpoints` on the private management socket or the routed
Hub service `<hubServiceId>/daemon`. Local clients and remote clients use the
same API; the daemon owns processes, connection retries, output, and lifecycle.
The routed interface is subject to the selected Hub's admission/capability
policy. It permits execution as the daemon's OS user: do not expose a trusted
local listener to untrusted networks without configuring those policies.

The API exposes `info`, `list`, `create`, `run`, `watch`, `start`, `stop`,
`remove`, and `configure`. `watch` streams status changes until the endpoint is
removed. `create` and `run` accept `replace: true` (CLI `--force`): an existing
endpoint with the same address, including a persistent or owned one, is stopped
and removed first within the same serialized operation; its console reports a
notice and completes.

The management interface embeds the
[`linkrpc.console.v1`](../linkrpc-infra/README.md#process-consoles-linkrpcconsole)
template as its `consoles` instance (wire methods `consoleInfo` and
`attachConsole`), with the endpoint address `{ namespace, id }` as params. This
tags `linkrpc.managedEndpoints` with `linkrpc.console`, so generic clients such
as `hub attach <hubServiceId>/daemon --params '{"namespace":…,"id":…}'` find
process consoles without knowing this API. `status.console.mode` reports whether
an endpoint has a pipe or TTY console. Attachments share input, observe the
same output, and never stop the endpoint when cancelled. Pipe consoles replay up
to 1 MiB of recent output and supervisor notices; TTY consoles replay the
current screen and scrollback from a headless terminal (`@xterm/headless`). A
console persists across automatic restarts; its attachments complete when
no process runs and none is pending, and it closes when the endpoint is removed.

`run` creates a process endpoint and attaches to its console in one call: the
stream carries the `linkrpc.console` attach protocol plus `status` events, so
there is no create/attach gap that could lose output of a short-lived process.
With `owner: true`, the call owns the endpoint (CLI `--foreground`): its
completion, cancellation, or caller disconnect disposes that exact supervisor and
removes its endpoint. Without it, cancelling only detaches. Observer attachments
remain non-owning. Owned endpoints cannot be made persistent and are not
restored across Hub replacement. Instance IDs identify endpoint definitions,
not individual automatic restart attempts.

Process sources accept `rpc: false` for plain stdio programs (CLI `--no-rpc` /
`-x`). These start without a participant socket or identity and become ready
on spawn, regardless of the RPC readiness setting. Ambient LinkRPC/legacy
HubRPC endpoint and token variables are removed; explicit source `env` values
are preserved. `list` and status events report `rpc: false`.

Process sources accept `tty: true` (CLI `-t`) to run in a pseudoterminal
(`@lydell/node-pty`; ConPTY on Windows): stdout and stderr merge, and console
attachments can resize it. Its consoles report the signals they can deliver:
on Windows, TTYs support `SIGINT` (Ctrl+C via ConPTY) and `SIGKILL`, pipes only
`SIGKILL`; POSIX supports `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, and `SIGKILL`
(delivered to the process group).

Dynamic endpoints are keyed by `(namespace, id)` and reserve
`<hubServiceId>/services/<sha256(namespace)>/<id>` for application RPC. Plain
stdio processes publish no RPC methods there. Persistent definitions and
desired state are atomically saved in `endpoints.json` in the daemon state
directory. They are separate from the legacy configured services below, whose
defaults remain unchanged. Dynamic endpoints default to ephemeral and
`restart: never`. Persistent restarting endpoints resume when the daemon starts,
but do not enable OS user-login startup. The standalone daemon's explicit
`autostart` commands remain available; dynamic endpoint operations never alter
OS registrations.
Explicit stop persists desired=false. Daemon shutdown does not overwrite it.
Hub configuration reload preserves dynamic definitions in memory and restarts
their workloads when the Hub itself must be replaced.

The CLI bundles this daemon implementation and executable; it does not require
this package to be published separately. Both management transports expose
reflection for the CLI's required interface-hash checks. `hub services restart`
explicitly shuts down the local daemon over management RPC and launches the
CLI's bundled build, without updating existing autostart entries.

### Config file

The config (`linkrpc-hub-daemon config path`) is JSON with comments. A
`config.schema.json` next to it gives editors completion and validation.

```jsonc
{
    "$schema": "./config.schema.json",
    "services": {
        "github": {
            "command": ["node", "/opt/services/github.js"],
            "env": { "LOG_LEVEL": "info" }
        },
        "indexer": {
            "command": ["indexer", "--linkrpc"],
            "restart": "always",
            "enabled": false
        }
    }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | one of `command`/`endpoint` | Executable and arguments (no shell) |
| `endpoint` | one of `command`/`endpoint` | LinkRPC endpoint URI to connect instead of a process (see [Connecting another hub](#connecting-another-hub)) |
| `env`, `cwd` | `{}`, inherited | Extra environment and working directory (`command` only) |
| `enabled` | `true` | `false` keeps the service configured but stopped |
| `restart` | `on-failure` | `always`, `on-failure`, or `never` |
| `rpc` | `true` | `false` runs plain stdio without an RPC socket or identity; ready on spawn (`command` only) |
| `tty` | `false` | Run in a pseudoterminal; stdout and stderr merge (`command` only) |
| `readiness` | `connected` | RPC processes are running once connected to the hub, or once `spawned`; ignored when `rpc: false` (`command` only) |
| `serviceId` | `<hubServiceId>/<name>` | Namespace the service may claim on the hub (default `hub/<name>`) |
| `managedIdentity` | `true` | Provision a persistent identity (slot `service:<name>`) |
| `claimServiceIds` | `[]` | Service IDs to register on the far end of an `endpoint` so it routes them back (see [Serving this hub to the far end](#serving-this-hub-to-the-far-end)) |
| `startTimeoutMs` | `30000` | A `connected` service that does not connect in time is restarted |
| `stopTimeoutMs` | `5000` | Grace period before the process tree is killed |

On Windows, a process without an active RPC connection has no graceful
stop channel. Stopping it kills its process tree immediately rather than
waiting `stopTimeoutMs`. Connected RPC services still get the disconnect grace
period; on POSIX, processes get SIGTERM and the configured grace period.

Every other top-level field is a regular [hub config](../linkrpc-hub/README.md)
(listeners, endpoints, `forwardChecking`, …). Unlike a standalone hub,
`forwardChecking` defaults to `false`: the endpoints are private to the OS user,
which is the trust boundary of a per-user hub.

To require capabilities instead, trust an identity as capability root:

```jsonc
"forwardChecking": true,
// e.g. the linkrpc CLI identity (`hub identity show --endpoint <endpoint>`)
"rootPrincipalIds": ["id:key:…"]
```

Every forwarded call must then be signed and carry a capability rooted at a
trusted root. The CLI signing as that identity authorizes itself; other
callers' access requests wait until it approves them (`hub approval ui`).

### Connecting another hub

A service with an `endpoint` instead of a `command` connects that endpoint and
attaches it to this hub like a service process: it may serve only its
`serviceId`, and its own calls pass this hub's forwarded-call checks. That
makes it suitable for hubs this hub should host but not trust, such as a
virtual machine or container. The far end needs no token and no trust root:
this hub dials it and grants the namespace.

`cmd-stdio:` endpoints spawn a command and speak LinkRPC over its stdio, so
another machine's hub is reachable through `ssh` and its
[`bridge-stdio`](#hosts-that-spawn-stdio-services) command:

```jsonc
"services": {
    "vm-1": {
        "description": "macOS VM",
        "endpoint": "cmd-stdio:?argv=ssh&argv=my-vm&argv=linkrpc-hub-daemon&argv=bridge-stdio",
        "serviceId": "hediet/mac/vm-1",
        "managedIdentity": false,
        "restart": "always"
    }
}
```

The hub inside the VM uses `"hubServiceId": "hediet/mac/vm-1"`, so its own
services (for example `hediet/mac/vm-1/compute`) fall within the granted
namespace. `unix:`, `npipe:`, and `ws:` endpoints work the same way. The
command's stderr appears in the service log; when it exits, the restart
policy reconnects.

### Serving this hub to the far end

An `endpoint` service routes its `serviceId` out to the far end. To let the
far end also call into this hub, list the service IDs this hub serves in
`claimServiceIds`; they are registered on the far end on every connect:

- A string, such as `"de.hediet/home"`, is claimed within the namespace the
  far end grants the connection's token. If the far end rejects it, the
  connection fails and is retried.
- `{ "serviceId": "…", "as": "…" }` is claimed outside that namespace through
  the far hub's admin-gated `hubServiceIdRegistry::registerServiceId`, signed
  as `as`. `as` uses the CLI's `--principal` syntax, `user:<id>` or
  `file:<path>`. The far hub accepts the claim if it trusts that identity as a
  root (`rootPrincipalIds`) or has granted it access. A rejected claim is
  logged and retried on the next connect; the outbound route stays up.

`jsonc
"services": {
    "cloud": {
        "endpoint": "wss://hub.example.com?token=…",
        "serviceId": "de.hediet",
        "claimServiceIds": [{ "serviceId": "hediet/tablet", "as": "user:hubrpc-cli" }],
        "restart": "always"
    }
}
`

Calls the far end routes back pass this hub's forwarded-call checks like any
other inbound call.

### Application endpoint

Applications connect to a fixed, per-user endpoint (shown by `status`):

- Windows: the named pipe `\\.\pipe\linkrpc-hub-<username>`
- macOS/Linux: `hub.sock` in the user's private runtime directory

No token is required: other OS users cannot open the pipe/socket for writing.
Both can be changed:

```jsonc
"localEndpoint": {
    "path": "\\\\.\\pipe\\my-hub",   // or a Unix socket path
    "token": "my-secret"             // optional; clients must present it
}
```

The discovery file always reflects the active endpoint (and the token, if any),
so `connectToLocalHub` keeps working. Changing `localEndpoint` restarts the hub.

On Windows, pipe names are machine-wide: another local user could create the
pipe first and receive clients that connect by name. On shared machines, rely
on the discovery file (written only by the daemon) or configure a token.

### What a change restarts

| Change | Effect |
| --- | --- |
| Formatting, comments, `$schema` | Nothing |
| Service added / removed | That service starts / stops |
| `command`, `endpoint`, `env`, `cwd`, `serviceId`, `managedIdentity`, `claimServiceIds`, `rpc`, `tty`, `readiness` | That service restarts |
| `enabled`, `restart`, timeouts, `description` | Applied without restarting the process |
| `callLog` | Applied without restarting the hub or any service |
| Any hub-wide setting | The hub and all services restart |
| Invalid file | Nothing; the error is reported and the previous config keeps running |

`linkrpc-hub-daemon service enable|disable <name>` persists `enabled` with a
minimal edit that keeps comments.

## Writing a service

A service receives `LINKRPC_ENDPOINT` and `LINKRPC_TOKEN`, connects to a private
socket provisioned for it, and may claim its service ID. With
[`hostParticipant`](../linkrpc-hub/README.md#hosting-a-node-participant):

```ts
import { hostParticipant } from '@hediet/linkrpc-hub/participant-host';

const host = await hostParticipant({
    registrationMode: 'grantedServiceId',
    setup: ({ connection, services, serviceId }) => {
        services.register(myInterface, myImplementation);
        // Listed by the hub directory (`hub ls`): the root directory refers to
        // the per-service one.
        connection.enableReflection();
        connection.enableReflection({ serviceId });
    },
});
await host.done; // the hub disconnected: exit
process.exit(0);
```

The hub's directory includes a service only through a
`<serviceId>::hubrpc.directory` entry in the participant's root directory, so
reflection is needed at both places.

**Exit when the hub connection closes.** Closing the connection is the portable
stop request (POSIX services additionally receive `SIGTERM`); after
`stopTimeoutMs` the whole process tree is killed. Write logs to stdout/stderr:
the last 1000 lines per service are kept for `service logs` and the tray app,
and everything goes to the daemon log file.

## Connecting an application

```ts
import { connectToLocalHub } from '@hediet/linkrpc-hub-daemon/client';

const hub = await connectToLocalHub();
const github = hub.connection.service('hub/github').get(githubInterface);
```

`connectToLocalHub` uses `LINKRPC_ENDPOINT` when set (for managed services) and
otherwise the running daemon's discovery file (`hub.json` in the state
directory), which contains the endpoint (and the token, if one is configured).
Other languages can read the same file:
`{ "version": 1, "pid": …, "endpoint": "<pipe or socket path>", "token"?: "…" }`.

### Hosts that spawn stdio services

`linkrpc-hub-daemon bridge-stdio` connects its stdin/stdout (newline-delimited
JSON-RPC, no handshake) to the running hub as a client. A host that routes a
service ID prefix to a spawned stdio child can thereby forward this whole hub,
e.g. the VS Code team-tools extension (the key is the `hubServiceId`):

```jsonc
"vscode-team-tools.hubRpc.services": {
    "hub": { "cmd": "/path/to/node", "args": ["/path/to/linkrpc-hub-daemon/dist/cli.js", "bridge-stdio"] }
}
```

Requests arrive fully qualified (`hub/github::…`) and are routed by this hub;
responses and the stream frames of streaming calls go back unchanged.
The bridge exits when either side closes, and the host respawns it on the next
call (for example after the hub restarted).

## Call log

The daemon can record every call routed through its hub, including calls
forwarded from other machines (e.g. through `linkrpc-devtunnel`). It is off by
default; turn it on in the tray app ("Record calls"), with
`setCallLogLevel` in the management API, or in the config:

```jsonc
"callLog": {
    // off | error (failed calls) | info (all requests) | debug (+ notifications) | trace (+ stream frames)
    "level": "info",
    "payloads": {
        "mode": "truncated",          // none | truncated | full
        "maxStringLength": 256,       // per string property
        "maxArrayItems": 50,
        "maxDepth": 8,
        "redactKeys": ["password", "secret", "token", "apikey", "privatekey", "authorization", "cookie", "credential", "passwd"]
    },
    "rotation": { "maxFileSizeMb": 10, "maxFiles": 20, "maxAgeDays": 14 }
}
```

Only `level` needs to be set; the rest shows the defaults. Changes apply
without restarting the hub. `warn` records the same calls as `error`.

**Files are the source of truth.** Calls are appended as NDJSON to
`calls/calls-<UTC start>.ndjson` in the state directory. A file is closed at
`maxFileSizeMb`; files beyond `maxFiles` or older than `maxAgeDays` are
deleted. Each line is one record (see
[`callRecord.ts`](src/callLog/callRecord.ts)):

```json
{"v":1,"id":"c7a1e33d-flow19","at":1792582431135,"level":"info","kind":"request","status":"completed","durationMs":1,
 "method":"hediet/pc2/notes::test.echo::echo","serviceId":"hediet/pc2/notes",
 "from":{"label":"hediet/devbox","transport":"named-pipe \\\\.\\pipe\\linkrpc-hub-service-devtunnel-…"},
 "to":{"label":"hediet/pc2/notes","transport":"named-pipe \\\\.\\pipe\\linkrpc-hub-service-notes-…"},
 "principal":"id:key:9xNY…","paramsBytes":52,"resultBytes":47,
 "params":{"text":"remember the milk","token":"[redacted]"},"result":{"text":"noted: remember the milk"}}
```

- `from`/`to` are the hub ports the call entered and left on: the prefix the
  peer claimed (`hediet/devbox` for calls forwarded from that machine) or an
  edge id such as `e12` for an ordinary client, plus the transport behind the
  port and, for the daemon's configured services, `service` (e.g.
  `devtunnel`). `principal` is the caller's `$hubrpc.principal` when the call
  is signed; with `forwardChecking` the hub has verified it.
- A call still running about 50 ms after it started (e.g. a watch stream) is
  written as `pending` and written again under the same `id` when it settles.
  Readers keep the newest record per id.
- Payloads exclude the `$hubrpc*` call metadata. Values under keys containing a
  `redactKeys` entry (case-insensitive, ignoring `_` and `-`) are replaced by
  `[redacted]`; `redactKeys: []` turns redaction off. `mode: "none"` records
  only sizes.
- Calls the hub originates itself (e.g. peer discovery) are not recorded.

The recorder observes the hub's inspection traffic (the source of
`hubrpc.traffic`) and coalesces it with the hub's `TrafficFlowAggregator`, so a
call is one record however many messages it took. Transport and `service` come
from the hub's topology graph: the daemon describes each participant it
connects (configured services and managed endpoints) with an `attacher`
descriptor on its node (`{ type: "linkrpc.hubDaemon.service", label: <name> }`),
which `linkrpc hub topology` shows as well.

**Reading the log.** Besides the files and the tray app, the management API
offers `queryCalls` (newest first, filtered by a query, minimum level, and
time) and `watchCalls` (live, same filter). Hub clients, including remote hubs, read it through
the standard [`linkrpc.logging`](../linkrpc-infra/README.md#logging) interface
at `<hubServiceId>/daemon`: the latest 200 calls as a revisioned document,
rendered like the hub's flow log. `getLogLevel` returns `callLog.level`, and
`setLogLevel` persists a new level in the config.

The query ([`callQuery.ts`](src/callLog/callQuery.ts), also exported as
`@hediet/linkrpc-hub-daemon/call-query` for UIs) is a list of
space-separated terms that must all match:

| Term | Matches |
| --- | --- |
| `echo`, `"no route"` | Case-insensitive substring of the method, caller, target, principal, or error |
| `method:<glob>` | `service::interface::member`, `*` matching anything (the service is empty for root-form calls) |
| `service:<name>` | Calls from or to that configured service (e.g. `service:devtunnel` for all traffic with other machines) |
| `-<term>` | Calls the term does not match |

For example, `-method:hediet/devbox::*` hides every call to that service,
`-method:*::hubrpc.directory::*` hides an interface on all services, and
`-method:hediet/pc2::hubrpc.directory::list` hides one method of one service.

## Locations

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Config | `%LOCALAPPDATA%\linkrpc\hub\config.json` | `~/Library/Application Support/linkrpc/hub/config.json` | `$XDG_CONFIG_HOME/linkrpc/hub/config.json` |
| State, log, discovery | `%LOCALAPPDATA%\linkrpc\hub` | same directory | `$XDG_STATE_HOME/linkrpc/hub` |
| App endpoint | `\\.\pipe\linkrpc-hub-<username>` | `…/hub/run/hub.sock` | `$XDG_RUNTIME_DIR/linkrpc-hub/hub.sock` |
| Other sockets | random named pipes | `…/hub/run` | `$XDG_RUNTIME_DIR/linkrpc-hub` |

`--home <dir>` (or `LINKRPC_HUB_HOME`) puts everything in one directory, e.g.
for tests or a second independent hub; its autostart entries are named
separately.

## Lifecycle

- **One daemon per home.** A bound lock socket makes a second `run` exit (with
  code 0, so that no supervisor restarts the duplicate); the OS releases the
  lock if the daemon dies.
- **Autostart** registers a login entry and never starts or stops the running
  daemon:
  - Windows: `HKCU\…\Run` value (no elevation; visible in Task Manager's startup
    apps). It runs the daemon under its own keep-alive watchdog in a headless
    `conhost`, so no console window appears.
  - macOS: a LaunchAgent with `KeepAlive.SuccessfulExit = false`.
  - Linux: a systemd user unit with `Restart=on-failure`, or an XDG autostart
    entry with the watchdog when there is no systemd user instance.
- **Crashes restart, stops do not.** The OS manager or watchdog restarts the
  daemon after a crash; `stop` exits with code 0, which none of them restart.
- **Start now** uses the OS manager when it is registered there (launchd,
  systemd) and otherwise starts a detached daemon with the watchdog.
- Autostart entries point at the resolved Node.js binary (not a version
  manager's per-shell shim) and the installed CLI script. Re-run
  `autostart enable` after moving either.

## Management API

The daemon serves `linkrpc.hubDaemon` (see
[`managementInterface.ts`](src/managementInterface.ts)) on a second private
endpoint published in `management.json`: status and a status stream, config
read/validated write (with revision check), reload, service enable/restart/logs,
the [call log](#call-log) (`setCallLogLevel`, `queryCalls`, `watchCalls`), and
shutdown. `connectToHubManagement()` connects to it.

Both discovery files are written with user-only permissions. The management
endpoint keeps a generated token, which the CLI and tray read from
`management.json`; it separates concerns (managed services do not receive it)
rather than enforcing a security boundary within one user account.

## CLI

```
linkrpc-hub-daemon [--home <dir>] <command>

  run [--keep-alive] [--quiet]     run in the foreground
  start | stop | restart | status [--json] | reload
  bridge-stdio                     pipe stdio JSON-RPC to the running hub
  autostart enable|disable|status
  service enable|disable|restart <name>
  service logs <name> [-n <lines>]
  config path|schema|validate [file]
```

## Limitations

- Only the per-user hub exists so far; a machine-wide hub (boot-time service
  account) is a separate deployment mode.
- If the daemon is killed, its services are not terminated by it; they lose
  their hub connection and are expected to exit.
- Hub-wide settings restart everything; individual hub listeners and endpoints
  are not reconciled one by one yet.
