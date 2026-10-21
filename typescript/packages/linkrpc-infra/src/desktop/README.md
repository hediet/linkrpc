# Desktop interface template

`@hediet/linkrpc-infra/desktop` defines a source-independent, parameterized
`linkrpc.desktop.v1` interface template, following the console template pattern.
The `linkrpc.desktop` tag is only a discovery hint. `desktopInstances` validates
the reflected template definition and resolves its instance name, parameter
schema, and mapped wire members.

```ts
const desktops = defineInterface({ id: 'example.screens' }, {
    screen: DesktopTemplate({ params: object({ id: string() }) })
        .mapMembers({ info: 'describeScreen', attach: 'controlScreen' }),
});

connection.register(desktops, {
    screen: desktopHandlers(({ id }) => {
        const source = sources.get(id);
        if (!source) throw new Error(`Unknown desktop: ${id}`);
        return source;
    }),
});
```

The source resolver must reject unknown selectors. Share each `DesktopHost`
across all connections for that source: it owns the exclusive controller.
Implement `DesktopBackend` for another RFB source without changing clients.

## Wire and ownership

- `info({params})` returns title, advisory availability, and `protocol: "rfb"`.
- `attach({params, offer, viewport})` is the long-lived authorization/ownership
  request. `offer` and the first server stream message, `answer`, contain complete
  SDP including ICE candidates; v1 does not use trickle ICE.
- The caller creates one **ordered, reliable, binary** RTC data channel named
  `linkrpc.desktop.rfb.v1`. It carries the RFB byte stream, not JSON, base64,
  framebuffer messages, or video. Message boundaries are not RFB boundaries.
- Subsequent client stream messages carry CSS viewport dimensions and DPR.
  Server acknowledgements follow successful source DPI updates. The RFB
  `SetDesktopSize` extension controls the physical framebuffer dimensions.
- `attach` remains pending until the source closes; completion is `{reason:
  "closed"}`. Errors are RPC failures. There is no resumable desktop session or
  detached controller.

Both endpoints probe using the **existing request stream `ping()`/pong**
every **20 seconds**. Only a successful round trip renews the **60-second**
lease. At most one probe is outstanding. RFB traffic, outgoing probes and
ordinary progress messages do not renew it.

The hub's request-idle timeout is insufficient: it defaults to 30 minutes and
traffic in either direction renews it. This template adds a stricter lease
without adding a competing heartbeat wire protocol.

Explicit cancellation, observed control disconnection, service shutdown or
request completion synchronously disables source input/output and closes the
peer/source. A silent partition is bounded by 60 seconds since the last pong,
not instantaneous. The browser enforces the same policy independently.
Reconnection requires a new request and fresh ICE/DTLS negotiation.

Backends must clean partially opened resources when setup fails or is aborted.
`dispose()` must synchronously prevent all further input/output and be
idempotent. Source, peer and viewport errors end the attachment. Pending
viewport work is bounded; excessive updates terminate the attachment.

Authorization is the hub's normal per-request authorization. This template does
not add dynamic capability-revocation checks to an already authorized request.

## Tests

From `typescript`:

```text
pnpm --filter @hediet/linkrpc-infra exec vitest run src/desktop/desktop.test.ts src/console/consoleHost.test.ts
```
