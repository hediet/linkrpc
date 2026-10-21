# @hediet/linkrpc-hub-desktop

Tray icon and management window for the per-user
[LinkRPC hub daemon](../../packages/linkrpc-hub-daemon). The app is only a
client of the daemon: closing the window keeps the tray, and quitting the tray
keeps the hub running.

- **Tray:** hub state at a glance (green: running, amber: a service failed or
  the config is invalid, gray: stopped), start/stop/restart, and the two startup
  options.
- **Window:** services with state, PID, restarts, and errors; enable/disable
  (persisted in the config), restart, and live logs per service; hub details;
  and a config editor that saves through the daemon (validated, conflict-checked,
  applied immediately).
- **Calls:** the daemon's [call log](../../packages/linkrpc-hub-daemon/README.md#call-log).
  "Record calls" and the level are saved in the daemon config (the tray menu
  has the same toggle). The table reads the log files through the management
  API (`queryCalls`), follows new calls live (`watchCalls`), and shows
  caller, target, principal, and the (redacted) payloads of a selected call.
  The filter takes the daemon's [query syntax](../../packages/linkrpc-hub-daemon/README.md#call-log)
  (`-` excludes, `method:` globs); right-clicking a call appends an exclusion
  for its service, its interface or method (on that service or on all
  services). "Errors only" limits the table to failures, and "Open Folder"
  opens the log directory. The filter, "Errors only", and "Live" are saved in
  the tray app's `settings.json` (Electron's user data directory) and
  restored on the next start.
- **Startup:** "Start hub at login" and "Start tray at login" are independent.

The daemon runs on Electron's own binary in Node.js mode, so an installed app
needs no separate Node.js. On Windows, login entries cannot set environment
variables; the hub entry therefore launches `<app> --linkrpc-hub-daemon`, which
starts the daemon's keep-alive watchdog and exits.

## Development

```sh
pnpm --filter @hediet/linkrpc-hub-desktop... build
pnpm --filter @hediet/linkrpc-hub-desktop start            # default hub
pnpm --filter @hediet/linkrpc-hub-desktop start -- --home /tmp/test-hub
```

`start` downloads the Electron binary on first use if the package manager
skipped Electron's install script. Starting the app again while it runs opens
its window.

## Security

The window is sandboxed with context isolation and without Node.js integration.
It reaches the main process only through the `hubDesktop` bridge in
[`preload.ts`](src/preload.ts); the main process accepts calls only from its
window and validates every action's parameters. Navigation and new windows are
blocked.

## Not yet included

Installers and signing (e.g. electron-builder), automatic updates, and hosting
VS Code apps.
