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

## Compatibility check: plain JSON-RPC over WebSocket

- [x] Implement `ws-no-init:` for remote JSON-RPC services that do not speak
      LinkRPC's initialization protocol.
  - Preserve endpoint query parameters and bypass LinkRPC initialization,
    signing, and managed-identity discovery.
  - Protocol-specific initialization, schema generation, and adapters belong
    in consuming applications; the generic transport forwards their frames.

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
