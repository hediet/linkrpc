# LinkRPC CLI and tooling backlog

## Current

- [ ] Add a CLI command that prints the full identity principal that `hub ls`
      and other connected commands would use.
  - Support the same global endpoint, config, provisioning, and `--principal`
    flags as `hub ls`.
  - Show the resolved principal rather than only the principal specification.
  - Provide stable JSON output for automation.

- [ ] Add non-interactive and interactive CLI commands for approving requests
      from hub access manifests.
  - Only approve capabilities whose audience/target is the CLI's resolved
    principal.
  - Reuse the manifest discovery, validation, narrowing, and approval machinery
    already implemented by the hub.
  - The non-interactive command must support inspection and explicit approval
    without a TUI; the interactive command should present the pending manifest
    requests and allow selective approval.
  - Never approve capabilities targeting another principal.

## Compatibility check: Agent Host Protocol

- [x] Attempt to use `hub call` for an Agent Host Protocol root command against
      the local development agent host at `ws://localhost:4123`.
  - Tested the bare `initialize` request with `--no-validate`, an
    `ahp-root://` channel, an AHP protocol version, and the connection token in
    the WebSocket `tkn` query parameter. The token is intentionally not recorded
    here.
  - The original `ws:` attempt did not send the AHP request because the LinkRPC
    connection first performs its mandatory `linkrpc::initialize` handshake.
    AHP sent no response to that unknown pre-initialize method, so LinkRPC threw
    when its 10-second handshake timeout expired.
  - The VS Code AHP server's pre-initialize dispatch currently returns without
    replying to unknown requests (`if (!client) return`). This also made the
    CLI's managed-identity discovery hang when first testing a raw connection.
    After a successful AHP initialize, the same unknown request receives an
    error immediately. `ws-no-init:` therefore bypasses LinkRPC signing and
    managed-identity setup so the requested AHP `initialize` is the first frame.
  - AHP itself uses one JSON-RPC message per WebSocket text frame, so the basic
    WebSocket message framing is compatible. The protocols differ at connection
    initialization: AHP expects a bare `initialize` request whose params include
    `channel: "ahp-root://"`, while the LinkRPC client initializes the LinkRPC
    transport first.
  - Implemented `ws-no-init:` for plain JSON-RPC over WebSocket. It preserves
    query parameters, skips LinkRPC initialization/signing, and successfully
    called AHP `initialize` with protocol version `0.6.0`.
  - AHP accepts the connection token during the WebSocket upgrade as the `tkn`
    query parameter; it is not an AHP `initialize` parameter.

## Future

- [ ] Build a read-only, non-blocking RPC man-in-the-middle proxy.
  - Accept WebSocket and Unix-socket clients and connect each client to another
    WebSocket or Unix-socket server.
  - Support multiple concurrent connections.
  - Observe traffic without blocking, rewriting, or influencing forwarding.
  - Optionally write the traffic log to a file.
  - Expose both snapshot access to the log and a live log stream through an
    interface.
  - Bound buffering so slow log consumers cannot apply backpressure to proxied
    traffic.

- [ ] Let the extension access approver use AI to review capability requests and
      propose narrower or wider capabilities before approval.
  - Keep the final decision explicit and auditable.
  - Show the original request and the proposed capability changes.
  - Never silently broaden authority.
