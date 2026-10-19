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

The [desktop app](../../packages-private/linkrpc-hub-desktop) adds a tray icon
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

The API exposes `info`, `list`, `create`, `runForeground`, `start`, `stop`, `remove`, `configure`,
`attach` (server stream), and instance-guarded `input`. Attach cancellation never
stops an endpoint. Output retention is bounded to 1000 chunks per endpoint;
recently completed ephemeral instances retain a bounded replay window.
These instance IDs identify endpoint definitions, not individual automatic
restart attempts.

`runForeground` creates a non-persistent process and streams the same events as
`attach`, but owns that process's lifetime. Its completion, cancellation, or
caller disconnect disposes that exact supervisor and removes its endpoint.
There is no separate create/attach gap that could orphan foreground work.
Observer attachments remain non-owning. Foreground endpoints cannot be made
persistent and are not restored across Hub replacement.

Process sources accept `rpc: false` for plain stdio programs (CLI `--no-rpc` /
`-x`). These start without a participant socket or identity and become ready
on spawn, regardless of the RPC readiness setting. Ambient LinkRPC/legacy
HubRPC endpoint and token variables are removed; explicit source `env` values
are preserved. RPC clients still observe/control their stdio via this management
API, including when another caller owns the foreground lifetime. Attachments
share stdin and receive the same output; they are pipe consoles, not PTYs.
`list` and status events report `rpc: false`.

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
| `command` | required | Executable and arguments (no shell) |
| `env`, `cwd` | `{}`, inherited | Extra environment and working directory |
| `enabled` | `true` | `false` keeps the service configured but stopped |
| `restart` | `on-failure` | `always`, `on-failure`, or `never` |
| `rpc` | `true` | `false` runs plain stdio without an RPC socket or identity; ready on spawn |
| `readiness` | `connected` | RPC processes are running once connected to the hub, or once `spawned`; ignored when `rpc: false` |
| `serviceId` | `<hubServiceId>/<name>` | Namespace the service may claim on the hub (default `hub/<name>`) |
| `managedIdentity` | `true` | Provision a persistent identity (slot `service:<name>`) |
| `startTimeoutMs` | `30000` | A `connected` service that does not connect in time is restarted |
| `stopTimeoutMs` | `5000` | Grace period before the process tree is killed |

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
| `command`, `env`, `cwd`, `serviceId`, `managedIdentity`, `rpc`, `readiness` | That service restarts |
| `enabled`, `restart`, timeouts, `description` | Applied without restarting the process |
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

Requests arrive fully qualified (`hub/github::…`) and are routed by this hub.
The bridge exits when either side closes, and the host respawns it on the next
call (for example after the hub restarted).

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
and shutdown. `connectToHubManagement()` connects to it.

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
