# Shared approval client: root and delegated authority

Status: shared client and delegated issuance implemented locally and tested.
The facade and reusable approval helpers now live in the published infrastructure
package's `@hediet/linkrpc-infra/approval` entry point; publication of this update
and personal-bot migration remain separate follow-ups.
Investigated against `main` at `cb15369` on 2026-09-27.

## Goal

CLI and web approvers should consume the same client. The caller supplies its
principal (signing identity plus current capability bag), connection, and UI.
Being a trusted root must not require an admin-issued delegation. Possessing
delegated authority must also work, including when the same identity is a root
for one service and a delegate for another.

No new wire protocol or frontend-maintained root allowlist is required for
capability issuance. Receiving services remain authoritative about trust.
Advertised acceptable roots guide selection; they do not confer authority.

## Starting implementation and gaps

The following describes the baseline before this work.

- `ApproveClient` (now in `@hediet/linkrpc-infra/approval`)
  already supplies serialized snapshots, reconnects, `connecting/live/stale`
  state, and acknowledged decisions. It filters by one `ownPrincipalId`.
- [ApprovalCommandClient](../../typescript/packages/linkrpc-cli/src/commands/approval.ts)
  adds preparation, unchanged-request checks, discovery, and a snapshot API,
  but is CLI-local and signs only direct-root grants.
- The CLI bootstrap creates a narrow root self-capability for directory and
  manifest access. It does not derive this access from delegation capabilities.
- [runManifestApprover](../../typescript/packages/linkrpc-hub/src/engine/manifestApprover.ts)
  has a separate minting path and can accept UI-supplied capability overrides.
  Delegation should not require each UI to implement those overrides.
- Core [capability verification](../../typescript/packages/linkrpc/src/identity/capability.ts)
  already verifies delegated chains, including signatures, audience links,
  scope intersection, expiry, and accepted roots. `issueCapability` accepts
  a parent, but does not select or validate a complete issuance authority.
- `AggregatingHubAccessManifest` (now in `@hediet/linkrpc-infra/approval`)
  logs and skips failed source reads. Consequently, a successful aggregate
  response can be partial or empty even while source discovery is failing.

## Implementation sequence

### 1. Extract the existing shared approval facade

Move the non-CLI parts of `ApprovalCommandClient` and its hub-discovery factory
into the UI-independent `@hediet/linkrpc-infra/approval` entry point. Keep terminal
formatting and Ink code in `@hediet/linkrpc-cli`. Expose snapshots through
`IObservable<ApprovalSnapshot>`, not a callback-based watch API. Observable
dependencies belong in the infrastructure layer, never core `@hediet/linkrpc`.

The same entry point owns `ApproveClient`, `AggregatingHubAccessManifest`,
manifest registration and directory watching, slot resolution, permission
preparation, call binding, and reusable consent types/helpers. No compatibility
re-exports remain in the Hub or private client package. The Node-only
`createTerminalConsentPrompt` stays in `@hediet/linkrpc-hub`.
`ApprovalClient.runInteractive(signal, prompt)` requires an explicit
`ConsentPrompt`; the CLI adapter preserves its default terminal prompt.

Preserve the existing prepare/approvePrepared/deny/refresh behavior,
request IDs, changed-request checks, and decision acknowledgement. Route
interactive and one-shot approvals through the same preparation and issuance
logic rather than maintaining two implementations.

Use `Principal` as the normal input: it already owns a signing identity and
live `CapBag`. Do not capture a permanently frozen capability array at startup.
Specify refresh/invalidation when persisted grants are added, expire, or are
replaced; approval must revalidate after user confirmation.

### 2. Add reusable capability issuance authority

Put generic chain selection/validation and child issuance in the core identity
layer, not in the CLI, React frontend, or a UI prompt callback. Reuse the existing
chain-verification semantics rather than creating a weaker parallel verifier.

The operation should prepare an issuance plan for an audience, requested
permissions, expiry, and acceptable roots:

- Direct-root candidate: sign directly as the identity, with no parent.
- Delegated candidates: find valid chains addressed to that identity, select
  delegating authority covering the requested permissions, create child grants
  with `parentHash`, and include the required ancestor capabilities.
- If the identity is itself acceptable, direct-root issuance remains available
  even when unrelated delegation capabilities are absent, invalid, or expired.
- Match roots per request/target, not via a global `isRoot` mode or a hardcoded
  admin principal. One identity may have several usable authority paths.
- Validate signatures, linked audiences, complete ancestry, expiry, delegation
  rights, target/member/hash restrictions, parameter restrictions, and call
  bindings. Mere presence of `canDelegate` is not sufficient.
- Bound child lifetime by the selected chain. Preserve requested duration and
  one-shot call binding.
- Return only relevant ancestors, not the entire capability bag.
- If multiple parents are needed, produce an explicitly reviewed set of child
  grants whose effective authority covers the request. Never report a partial
  grant as complete or silently broaden requested permissions.
- Recheck the selected authority at redemption; if it changed or expired,
  require refresh/review rather than issuing a different unseen grant.

For the first implementation, use conservative permission containment where
coverage cannot be proven. Unsupported combinations must produce an explicit
unsupported/insufficient-authority result, not optimistic approval. General
coverage of unions of parameter matchers should not block the ordinary root
path or straightforward wildcard/exact delegated paths.

Use the same issuance operation to bootstrap narrow directory/manifest access.
An existing invoke capability may already suffice; a delegate-only capability
can require a derived invoke child. The remote gate decides whether the supplied
direct or delegated chain is trusted.

### 3. Wire authority and health into the shared approval facade

Replace single-principal filtering with request-specific authority preparation:

- Retain requests compatible with the identity itself or a validated delegated
  root; do not filter on `consumer.principal === approver.principal`.
- Show why a request cannot be approved, distinguishing incompatible roots,
  insufficient delegated scope, and unresolved discovery.
- Retain byte-bound previews/proposals for remotely rendered approval UIs.
- Surface discovery/source failures as structured incomplete/stale state while
  allowing healthy sources to contribute requests. Zero requests with failed
  sources is not a healthy empty inbox.
- Expose authority and source-health changes through the snapshot API. Keep
  delegation status distinct from direct-root authority.

Deciding whether a UI hides an unsatisfiable request or displays it disabled is
presentation policy. The shared client must provide the reason either way.

### 4. Adopt in personal-bot without duplicating authority logic

The frontend-server becomes an adapter from authenticated user to `Principal`,
the shared approval facade, and the browser session stream. Keep database-backed
identity/delegation storage, login, audit logging, and preview confirmation.
Delete its custom delegation-only runtime and consumer-principal filtering once
equivalent shared behavior is covered.

The browser renders shared snapshot health and requests; it does not hold the
custodial private key or implement delegation chain selection.

## LinkRPC migration

The project owner confirms that LinkRPC/HubRPC interoperability is already
verified. Do not block this library work on repeating that investigation or
change wire identifiers as part of the approval fix.

Source inspection supports a coordinated migration, not an assertion that
changing one dependency name is sufficient:

- The legacy `hubrpc::initialize` handshake and protocol version 1 remain.
- Required hub server subpaths, including the node WebSocket server, exist in
  `@hediet/linkrpc-hub`.
- Connection naming uses `LinkRpcConnection`; coordinate imports and package
  dependencies rather than assuming all old TypeScript names are aliases.
- Shared interfaces, browser transports, service-common, and the approval server
  currently exchange old-package types/instances. Compile these boundaries
  together; do not paper over incompatibilities with casts.

Exercise discovery, watch/reconnect, root and delegated approval, preview
binding, actual authorized invocation, and denial in the LinkRPC integration
tests. Pin a tested LinkRPC version/artifact for the later frontend migration.
Do not combine this change with a whole-network upgrade. Keep release/publishing
changes explicit: pushing to main can publish a nightly version.

## Acceptance tests

1. Trusted root with an empty capability bag discovers and approves a request
   from a different consumer; no delegation prompt is created.
2. Root with an expired unrelated delegation still works as a root.
3. Non-root delegate with valid scope can discover, approve, and authorize a
   consumer's actual call through its complete chain.
4. Root A -> delegate B -> approver C works; invalid signatures, missing parents,
   expired links, and mismatched audiences fail explicitly.
5. Insufficient scope, forbidden parameter values, and invoke-only parents
   cannot create effective delegated authority or a success-shaped result.
6. Root and delegated paths coexist across services with different accepted roots.
7. An initially missing grant can be added without restarting the approver;
   expiry or replacement while a preview is open is revalidated.
8. CLI interactive, CLI one-shot, and web adapter have matching decisions and
   request visibility. Preserve changed-request and one-shot preview protections.
9. Source failure, missing discovery authority, and ended watches are visible;
   reconnect restores authoritative snapshots and decisions are acknowledged.
10. The ordinary requesting client stores and sends the complete returned chain;
    its actual authorized invocation succeeds without manual cap attachment.

## Implementation and validation

The shared [observable client](../../typescript/packages/linkrpc-infra/src/approval/README.md)
in `@hediet/linkrpc-infra/approval` now owns the previously CLI-local approval
implementation. The CLI is an adapter. The private `@hediet/linkrpc-client-internal`
package no longer exports approval or depends on `@vscode/observables`.
Core provides `prepareCapabilityIssuance`, `issueCapabilities` and
`getDelegationRootIds` without an observable dependency. Both core and CLI
connection-cache checks now validate complete chains rather than accepting a
target match alone.

The requested root/delegate/third-client regression passes: root grants
delegate-only authority, the delegated client discovers and signs a child, and
the ordinary consumer connection invokes through the returned child and parent.
The same call is rejected when the parent is omitted. Existing requester code
already retained returned capability arrays; the missing pieces were generic
issuance/selection and chain-aware cache checks, not a new wire envelope.

Targeted validation commands from `typescript` after the infrastructure move:

```powershell
pnpm --filter @hediet/linkrpc-infra exec vitest run src\approval
pnpm --filter @hediet/linkrpc-client-internal exec vitest run src\hubSigning.test.ts
pnpm --filter @hediet/linkrpc-cli exec vitest run src\commands\approval.test.ts src\commands\approval.e2e.test.ts src\approval-ui
pnpm --filter @hediet/linkrpc-infra build
pnpm --filter @hediet/linkrpc-hub build
pnpm --filter @hediet/linkrpc-cli build
```

After the infrastructure move and internal-package rename:

- All six package builds pass, including CLI and MCP consumers.
- Infra typechecking passes.
- 15 infra approval tests, 34 hub consumer tests (including the three-identity
  flow), 34 CLI/approval-UI tests, 14 internal-client tests and 63 MCP tests pass.
- Core validation passed 87 relevant tests originally; a final focused rerun
  passed 73 capability and connection tests.

The full infra run also reaches unrelated generated-protocol fixture failures
on Windows: fixture paths start with `/D:/...`, and TypeScript cannot resolve
the core source import or Zod. The fixture file is unchanged from `cb15369`.
The broader cross-language run was stopped after it remained running; the
full suite is not claimed green.

Full client-suite validation produced 49 passes and one Windows stdio shutdown
failure (`node.exe: -e requires an argument`, then a timeout).
Client-wide `tsc --noEmit` reports four existing errors: two un-narrowed
`capabilities` accesses in `aggregatingManifest.e2e.test.ts`, and two imports of
unexported types in `hubSigningSender.ts`. The new approval code/tests introduce
no additional diagnostics. Both the same four diagnostics and the stdio failure
were reproduced with archived `cb15369` client sources and the installed
dependency builds; this is a client-source baseline, not a separately rebuilt
historical workspace. The unchanged Windows spawn helper uses `shell: true`
for every argv command. These unrelated baseline issues were left unchanged.

## Remaining integration work

- Publish and pin a validated version containing `@hediet/linkrpc-infra/approval`.
  The approval entry point is now part of a published package, rather than the
  private/source-only `@hediet/linkrpc-client-internal` package.
- Replace personal-bot's delegation-only backend runtime with the shared client.
  Preserve server-held identities and preview objects; stream snapshot health
  to the browser instead of reporting an empty inbox after startup failure.
- Validate the real authenticated web adapter, reconnection and confirmation
  flow before production rollout. The acceptance list above also describes
  that integration target; it is not a claim that the web adapter exists yet.

Personal-bot migration and production deployment are not included in this
LinkRPC change.
