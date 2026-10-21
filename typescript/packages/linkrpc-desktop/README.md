# LinkRPC WebRTC desktop

A first implementation of the parameterized
[`linkrpc.desktop.v1` template](../linkrpc-infra/src/desktop/README.md):

```text
browser <-- ordered reliable WebRTC / lossless RFB --> VncBackend <-- WebSocket --> VNC
browser <-- loopback LinkRPC control --> viewer <-- hub control --> DesktopHost
```

The hub and local viewer handle signaling, viewport/DPI and request lifetime.
They never forward desktop bytes. The local viewer keeps hub credentials out of
the page and discovers any compatible template instance, including instances
with different containing interfaces, method names or parameter schemas.

## Build and run

From `typescript`:

```text
pnpm --filter @hediet/linkrpc-desktop... build
```

The service uses the hub endpoint/token injected by a daemon-managed process,
claims its granted service namespace, and publishes reflection:

```text
node packages/linkrpc-desktop/dist/cli.js serve --source ws://127.0.0.1:6080/websockify --dpi http://127.0.0.1:6080/api/dpi --title "Docker Desktop" --managed-identity
```

`--managed-identity` requires an endpoint provisioned with a managed identity.
Without it, the service uses the endpoint's ordinary admission policy. `--service`
can select a descendant of the granted namespace. It cannot claim an arbitrary
namespace. Neither command changes hub configuration or restarts the daemon.

For example, register the process with an existing daemon (substitute absolute
paths for `NODE` and `CLI`):

```text
linkrpc hub services run --id desktop-webrtc --persistent --restart on-failure --detach -- NODE CLI serve --source ws://127.0.0.1:6080/websockify --dpi http://127.0.0.1:6080/api/dpi --managed-identity
```

Use the returned service ID to open a generic viewer:

```text
node packages/linkrpc-desktop/dist/cli.js view --service SERVICE --endpoint ENDPOINT
```

This prints a loopback HTTP URL. Open it in a local browser. Keep the command
running; stopping it disconnects the viewer. `LINKRPC_ENDPOINT` and
`LINKRPC_TOKEN` can replace `--endpoint`. Use `--managed-identity` when that
connection is provisioned with the hub's managed identity overlay; it signs calls
and negotiates capabilities through the standard consent front door. The CLI
does not independently load the main `linkrpc` CLI's context configuration.

Selectors: `--interface ID --instance NAME --params '{"id":"screen-1"}'`.
Ambiguous matches and invalid parameters fail explicitly. `startDesktopViewer`
also accepts a caller-supplied authorized hub connection factory.

## Lifetime and scope

- Exactly one controller per source, across all caller connections.
- Both control hops and both WebRTC endpoints enforce the 20-second probe /
  60-second successful-pong lease. A lost browser cannot leave an orphaned hub
  request or peer. Reconnect is a fresh attachment, not resumption.
- Explicit disconnect closes input/output immediately; an undetected network
  partition expires within one minute of the last successful control pong.
- RFB output is flow-controlled with a 256-KiB high-water mark and a 4-MiB hard
  limit. Input/source frames are also bounded. Overflow closes the attachment,
  rather than silently dropping or indefinitely accumulating RFB bytes.
- No audio, clipboard synchronization, file transfer, spectators, automatic
  reconnection, VNC password prompt or video codec in this first version.

## Pixel fidelity and application DPI

The bundled viewer serves a pinned noVNC 1.7.0 with small, exact-match-checked
patches. Upstream drift fails before the viewer starts, not silently:

- Request `round(CSS width × DPR)` by `round(CSS height × DPR)` from VNC.
- Present the framebuffer at exactly `1 / DPR`, **not** fit-to-container scaling.
  Fractional dimensions may extend by less than half a physical pixel; fitting
  both axes would resample every pixel when rounding changes the aspect ratio.
- Use pixelated CSS and disable both visible/backbuffer Canvas2D smoothing,
  including after backing-store dimension resets.
- Advertise only lossless RFB encodings; Hextile is preferred. Do not advertise
  JPEG, ordinary Tight or H.264.
- Watch both container resize and DPR changes.

The optional, trusted `dpiUrl` receives `POST {"devicePixelRatio":...}` over the
authorized control path. The Docker reproduction's adapter updates X11/Xft DPI
and restarts the exact VS Code main process group when DPR changes, without
restarting TigerVNC or the viewer. A generic backend need not use HTTP for DPI.
Viewport-only resizing must not restart applications.

The desktop surface leads; chrome stays minimal. Status is a live region.
**Ctrl+Alt+Escape** releases remote keyboard focus to the native Disconnect
button. RFB is pixels, not an accessibility tree; the page explicitly describes
this limitation rather than claiming screen-reader access to the remote desktop.

## Networking and security

Only trusted administrator configuration chooses the WebSocket/DPI URLs and ICE
servers. Callers cannot turn the provider into an arbitrary URL proxy. The
viewer binds `127.0.0.1`, uses an unpredictable capability URL, validates the
WebSocket Origin, and does not expose hub tokens. Treat its URL as a secret.
The local bridge is for a trusted single-user machine, not a public web server.

RFB runs inside DTLS-protected WebRTC. Full SDP necessarily contains connection
candidates; avoid logging SDP or capability URLs. There is no hub-data fallback.
`VncSource.peerConfig` and browser `connectDesktop`'s `iceServers` allow trusted
STUN/TURN configuration programmatically. The CLI defaults to host candidates;
WAN/NAT traversal and TURN deployments are not automatically configured.
Do not expose an unauthenticated/root VNC source to the network.

## Validation

From `typescript`:

```text
pnpm --filter @hediet/linkrpc-desktop build
pnpm --filter @hediet/linkrpc-desktop exec tsc --noEmit --customConditions @hediet/source
pnpm --filter @hediet/linkrpc-desktop test:e2e
```

E2E tests run a real Chromium peer against werift, a real routing Hub, the
loopback control bridge, and a binary WebSocket source. They check byte-exact
bidirectional transfer without hub traffic, control cancellation, caller/provider
disconnect, service shutdown, bounded output, a real 60-second control-only
blackhole while desktop traffic continues, and new credentials on reattachment.
On Windows they use installed Edge. Elsewhere install Playwright Chromium or set
`LINKRPC_TEST_BROWSER` to an existing Chromium executable.

The optional real-desktop test needs a VNC source with live `SetDesktopSize`:

```powershell
$env:LINKRPC_TEST_VNC_URL = 'ws://127.0.0.1:6080/websockify'
$env:LINKRPC_TEST_VNC_DPI_URL = 'http://127.0.0.1:6080/api/dpi'
# Optional independent server-side verification on Windows/WSL:
$env:LINKRPC_TEST_WSL_DISTRO = 'Ubuntu-24.04'
$env:LINKRPC_TEST_DOCKER_CONTAINER = 'vnc-browser-poc'
pnpm --filter @hediet/linkrpc-desktop exec vitest run test/desktop.e2e.test.ts -t 'real VNC desktop'
```

Close other viewers first: VNC has one shared framebuffer. The test checks the
same canvas through resize and DPR changes, physical-pixel mapping within CSS
layout quantization, no interpolation, and (when WSL variables are set)
framebuffer/Xft DPI, application scale, stable VNC PID and DPR-only application
restarts. Physical monitor movement, WAN and TURN require separate validation.
