# @hediet/linkrpc-compute-node

A LinkRPC service that gives remote access to this machine through the
[`linkrpc.computeNode.*` interfaces](../linkrpc-infra/README.md#compute-nodes):
shell commands (with streamed output and stdin), the file system, HTTP requests
to local ports, and TCP forwarding. It can also
[keep the machine awake](#keeping-the-machine-awake) while a caller needs it.

Run it as a [hub daemon](../linkrpc-hub-daemon/README.md) service:

```jsonc
"services": {
    "compute": { "command": ["node", "/path/to/linkrpc-compute-node/dist/cli.js"] }
}
```

It connects to `LINKRPC_ENDPOINT` and registers under the service ID the hub
grants, here `<hubServiceId>/compute`:

```sh
linkrpc hub call '<hubServiceId>/compute::linkrpc.computeNode.command::run' --params '{"command":"hostname"}'
```

It acts with the full rights of the OS user. Only run it on hubs that admit
trusted principals, e.g. with `forwardChecking` and your own identities in
`rootPrincipalIds`.

`hostComputeNode()` (the package entry) starts the same service in-process.

## Keeping the machine awake

A machine that goes to sleep drops its hub connection, e.g. a Mac driven by
remote agents through a [Dev Tunnels](../linkrpc-devtunnel/README.md) hub.
`linkrpc.computeNode.power::keepAwake` prevents idle sleep for as long as the
call stays open:

```sh
linkrpc hub call '<hubServiceId>/compute::linkrpc.computeNode.power::keepAwake' --params '{"displayOn":true,"reason":"agent session"}'
```

The call reports `{"type":"active",...}` as a stream message (on stderr) once
sleep prevention is in effect, then stays open; stop it with Ctrl+C. Options,
all optional:

- `displayOn`: also keep the display on (default `false`).
- `reason`: shown where the platform supports it (`systemd-inhibit --list`).
- `maxDurationMs`: release after this long even if the call is still open; the
  call then returns `{"reason":"expired"}`.

Sleep prevention lasts exactly as long as the call. It is released when the
caller cancels the call or disconnects (LinkRPC keeps open calls alive with
pings and cancels them when either side's connection drops), when
`maxDurationMs` elapses, and when the compute node exits, even if it is killed.
Every call holds its own lease, so concurrent callers do not affect each other.

Each lease is a helper process that holds the platform's request:

| Platform | Helper | `displayOn` |
| --- | --- | --- |
| macOS | `caffeinate -i` (prevents idle sleep) | adds `-d` |
| Windows | PowerShell calling `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` | adds `ES_DISPLAY_REQUIRED` |
| Linux | `systemd-inhibit --what=idle:sleep` | no extra request; desktops that honor logind idle inhibitors keep the screen on |

On Linux, `systemd-inhibit` must be installed and polkit must allow the
service's user to take the lock; otherwise the call fails with the reason (e.g.
`Failed to inhibit: Access denied` outside an active local session). Other
platforms are not supported.

This prevents *idle* sleep only. A Mac on battery still sleeps when its lid is
closed, and anything that explicitly puts the machine to sleep still does. A
sleeping machine cannot be woken through the hub or tunnel, so start
`keepAwake` before you leave the machine.

## In-process
`hostComputeNode()` (the package entry) starts the same service in-process.
