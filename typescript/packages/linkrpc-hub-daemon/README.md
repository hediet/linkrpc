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
| `readiness` | `connected` | Running once connected to the hub, or once `spawned` |
| `serviceId` | service name | Namespace the service may claim on the hub |
| `managedIdentity` | `true` | Provision a persistent identity (slot `service:<name>`) |
| `startTimeoutMs` | `30000` | A `connected` service that does not connect in time is restarted |
| `stopTimeoutMs` | `5000` | Grace period before the process tree is killed |

Every other top-level field is a regular [hub config](../linkrpc-hub/README.md)
(listeners, endpoints, `forwardChecking`, …). Unlike a standalone hub,
`forwardChecking` defaults to `false`: the endpoints are private to the OS user,
which is the trust boundary of a per-user hub.

### What a change restarts

| Change | Effect |
| --- | --- |
| Formatting, comments, `$schema` | Nothing |
| Service added / removed | That service starts / stops |
| `command`, `env`, `cwd`, `serviceId`, `managedIdentity`, `readiness` | That service restarts |
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
    setup: ({ services }) => services.register(myInterface, myImplementation),
});
await host.done; // the hub disconnected: exit
process.exit(0);
```

**Exit when the hub connection closes.** Closing the connection is the portable
stop request (POSIX services additionally receive `SIGTERM`); after
`stopTimeoutMs` the whole process tree is killed. Write logs to stdout/stderr:
the last 1000 lines per service are kept for `service logs` and the tray app,
and everything goes to the daemon log file.

## Connecting an application

```ts
import { connectToLocalHub } from '@hediet/linkrpc-hub-daemon/client';

const hub = await connectToLocalHub();
const github = hub.connection.service('github').get(githubInterface);
```

`connectToLocalHub` uses `LINKRPC_ENDPOINT` when set (for managed services) and
otherwise the running daemon's discovery file (`hub.json` in the state
directory), which contains the endpoint and token. Other languages can read the
same file: `{ "version": 1, "pid": …, "endpoint": "<pipe or socket path>", "token": "…" }`.

## Locations

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Config | `%LOCALAPPDATA%\linkrpc\hub\config.json` | `~/Library/Application Support/linkrpc/hub/config.json` | `$XDG_CONFIG_HOME/linkrpc/hub/config.json` |
| State, log, discovery | `%LOCALAPPDATA%\linkrpc\hub` | same directory | `$XDG_STATE_HOME/linkrpc/hub` |
| Sockets | random named pipes | `…/hub/run` | `$XDG_RUNTIME_DIR/linkrpc-hub` |

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

Both discovery files are written with user-only permissions. Any process of the
same OS user can read them, so the management endpoint separates concerns
(managed services do not receive its token) rather than enforcing a security
boundary within one user account.

## CLI

```
linkrpc-hub-daemon [--home <dir>] <command>

  run [--keep-alive] [--quiet]     run in the foreground
  start | stop | restart | status [--json] | reload
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
