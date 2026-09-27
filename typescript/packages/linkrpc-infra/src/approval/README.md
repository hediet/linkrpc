# Observable approval client

The shared facade and reusable
approval, manifest aggregation, directory-discovery, permission, and consent
helpers live in the published `@hediet/linkrpc-infra/approval` entry point.
Terminal prompts remain the Node adapter `createTerminalConsentPrompt` from
`@hediet/linkrpc-hub`; neither the infrastructure entry point nor core depends
on terminal UI code.

`createApprovalClient` shares manifest discovery, approval preparation and
decisions between the CLI and server-side UI adapters. The connection must
already sign with the supplied `Principal` and read its live capability bag.
The factory does not replace the connection's signing identity or own its
lifetime.

```ts
import { createApprovalClient } from '@hediet/linkrpc-infra/approval';
import { autorun } from '@vscode/observables';

const client = await createApprovalClient({ connection, principal });
const subscription = autorun(reader => {
    const snapshot = client.snapshot.read(reader);
    // Render snapshot.state, snapshot.requests and snapshot.error.
});

// After selecting a request, render these exact permissions and proposals.
const prepared = await client.prepareApproval(requestId);

// After the operator confirms that preview:
const outcome = await client.approvePrepared(prepared);
// Only "applied" means the source acknowledged removal of the request.
// "still-pending" must not be rendered as a completed approval.

subscription.dispose();
client.dispose();
// The owner closes the connection separately.
```

The observable dependency is confined to the higher-level packages; core
`@hediet/linkrpc` does not depend on `@vscode/observables`.

### Authority

- A trusted root starts with an empty capability bag. It needs no delegation.
  Discovery installs a narrow self-signed directory/manifest capability.
- A delegated approver uses validated delegation chains from the same live bag.
  Discovery derives narrow self-invoke capabilities when the parent allows it.
  Receiving services, not the client, decide which roots are trusted.
- Request visibility considers both the approver itself and authenticated
  delegation roots, never equality with the requesting consumer's identity.
  Visibility is not proof that a delegation covers every requested permission:
  `prepareApproval` reports insufficient scope or unresolved discovery explicitly.
- Preparation uses core `prepareCapabilityIssuance`. Approval returns each
  signed child plus the ancestors needed to verify it. The requesting
  connection stores and presents that chain without application-level handling.
- Preparation does not sign the proposed bearer capabilities. Confirmation
  rechecks the request and the selected chain, including expiry, without
  switching to a different unreviewed authority path.

Prepared objects are bound to the client that created them and must not be
modified. A web adapter should retain the original object server-side, render
its preview to the browser, and map a confirmation token back to that object.
Do not deserialize a browser-supplied replacement and pass it to
`approvePrepared`.

Call `refresh()` after changing the principal's capability bag externally.
It reboots discovery authority and re-evaluates delegated-root visibility.
`deny`, `approve`, `requests`, and `refresh` remain available for one-shot callers.

### Health and lifecycle

The snapshot has `connecting`, `live`, or `stale` state. A failed or invalid
manifest-source read makes the aggregate stale, even when healthy sources have
no pending requests. Render the error instead of treating this as a healthy
empty inbox. Available requests are retained in the snapshot; imperative
reconciliation/decision methods reject while discovery is incomplete.

`runInteractive(signal, prompt)` requires an explicit `ConsentPrompt` and consumes
the same observable and prepared decision path. The CLI adapter supplies the
default terminal prompt. It serializes prompts and aborts a prompt when its request
changes, disappears, the caller aborts, or the client is disposed.

The three-identity flow is exercised in
[`approval.e2e.test.ts`](../../../linkrpc-hub/src/engine/approval.e2e.test.ts):
a root grants delegation, the
delegate approves a third client, and that client's ordinary connection invokes
a gated service. Presenting only the child without its parent is rejected.
