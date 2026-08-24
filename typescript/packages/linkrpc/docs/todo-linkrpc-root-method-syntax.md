# TODO: Root method syntax — `interfaceId::method` → `::interfaceId::method`

## Goal

Change the **root (interface-form)** method wire/display syntax from
`interfaceId::method` to `::interfaceId::method`, everywhere (wire + CLI input +
display).

- Keep the bare `member` form (preset dispatch) unchanged.
- Full form `serviceId::interfaceId::method` stays the same.
- Net effect: an interface-form method is now "a full form with an empty
  serviceId," made explicit by the leading `::`.

## Decisions

- **`$stream::send`** → change to `::$stream::send` too (recommended) for a
  zero-exception grammar. It is matched via the `STREAM_METHOD` constant on both
  ends, so only the constant + comments/tests need touching.
- **Legacy 2-part `iface::method` on CLI input** → keep accepting as a
  deprecated alias (parser maps both to interface form) while emitting
  `::iface::method` in all suggestions/UI. (Alternative: hard-cut.)

---

## 1. Canonical grammar — the linchpin

`linkrpc/src/protocol/methodName.ts` — `parseMethodName`. Single source of truth.

- New parsing rules:
  - 1 part, non-empty → `bare` (unchanged)
  - 3 parts, **first empty**, other two non-empty → `interface` (root) — new `::iface::member`
  - 3 parts, all non-empty → `full`
  - everything else (incl. old 2-part `iface::member`) → malformed
- `methodNameToTarget` keeps mapping `interface` → `{ serviceId: "", ... }`.
- Decide whether old 2-part still parses as `interface` for back-compat (wire:
  reject; CLI: tolerate — see §5).

## 2. Wire-string composition sites (must emit leading `::`)

- [ ] `linkrpc/src/connection/linkRpcConnection.ts` `_buildClient` (~L270): root branch
      `${iface.info.id}::${name}` → `::${iface.info.id}::${name}`.
- [ ] `linkrpc-cli/src/methodRef.ts` `getMethodOnWire` (~L52): interface branch →
      `::${interfaceId}::${methodName}`.
- [ ] `linkrpc-cli/src/ui/UiModel.ts` `peekPendingCall` + `submit` (~L320): root
      branches → `::${interfaceId}::${methodName}`.
- [ ] `linkrpc-cli/src/reflection.ts` (~L71): non-target branches
      `"linkrpc.directory::list"` / `"linkrpc.schemas::get"` →
      `"::linkrpc.directory::list"` / `"::linkrpc.schemas::get"`.
- [ ] `linkrpc-cli/src/hubSigning.ts` `_resolveHubAccessMethod` (~L68): `bare` →
      `::hubAccess::requestAccess`, whoami → `::hubInfo::whoami`, **and fix the
      form-3 concat** `${hubServiceId}::${bare}` (bare now starts with `::`) →
      build `${hubServiceId}::hubAccess::requestAccess` from parts.
- [ ] `linkrpc-cli/src/commands/tunnel.ts` `CLAIM_METHOD` (~L11) → `::hubParticipant::register`.
- [ ] `linkrpc-hub/src/engine/runHub.ts` `REGISTER_METHOD` (~L78) → `::hubParticipant::register`.
- [ ] `linkrpc-cli/src/suggest.ts` (~L176) and completion builders in
      `linkrpc-cli/src/completions/complete.ts` (~L194) — emit root methods as `::iface::method`.

## 3. Branching logic that assumes "3 segments = full"

Breaks because `::iface::method` now also has 3 segments — use `parseMethodName`
instead of counting `::`:

- [ ] `linkrpc-mcp/src/server.ts` (~L336) `isForm3 = method.split("::").length === 3`
      → `parseMethodName(method)?.kind === "full"`.
- [ ] `linkrpc-cli/src/hubSigning.ts` (~L165) `wireMethod.split('::')` — re-derive via parse.
- [ ] `linkrpc-cli/src/completions/complete.ts` (~L169) `_completeMethodRef`
      separator-count logic — reshape so leading `::` drives root-interface completion.

## 4. `$stream::send` wire constant

- [ ] `linkrpc/src/streaming.ts` (~L141) `STREAM_METHOD = "$stream::send"` →
      `::$stream::send`. Matched exactly in:
  - `linkrpc/src/hub/server/routingHub.ts` (~L400)
  - `linkrpc/src/connection/jsonRpcChannel.ts` (~L192, L235)
  - `linkrpc/src/hub/server/overlaySplitter.ts` (~L11)
  - Only the constant + comments/tests need touching (comparisons use the constant).

## 5. CLI input parsing & back-compat

- [ ] `linkrpc-cli/src/methodRef.ts` `parseMethodRef` (~L9): accept leading `::`
      (empty first segment) as explicit root form.
- [ ] `linkrpc-cli/src/completions/complete.ts` (~L260) core/parts handling.
- [ ] Keep legacy `iface::method` accepted on CLI as deprecated alias (both map
      to interface form); emit `::iface::method` in suggestions/UI. (Or hard-cut.)

## 6. Tests, smoke scripts, docs

- [ ] `linkrpc-cli/src/methodRef.test.ts`
- [ ] `linkrpc-cli/src/completions/complete.test.ts`
- [ ] `linkrpc-mcp/src/taskRegistry.test.ts` (`svc::iface::m`, `a::b::c`)
- [ ] `linkrpc/src/identity/metaEnvelope.test.ts`
- [ ] `linkrpc/src/hub/server/forwardedCallGate.test.ts`
- [ ] `linkrpc/src/hub/server/overlaySplitter.test.ts`
- [ ] `linkrpc/src/connection/linkRpcConnection.test.ts`
- [ ] `methodName` tests
- [ ] `linkrpc/scripts/smoke-hub.ts`: `hubDirectory::listPrefixes` → `::hubDirectory::listPrefixes`
- [ ] Doc-comment occurrences of `hubAccess::…`, `hubParticipant::register`,
      `hubInfo::whoami`, `$stream::send`, `scriptRunner::run`, etc. across
      `cliConsent.ts`, `config.ts`, and READMEs (cosmetic).

## 7. Verification

- [ ] `pnpm exec vitest run` in `linkrpc/linkrpc` and the CLI/MCP packages.
- [ ] `pnpm exec tsc --noEmit` on touched packages.
- [ ] Run `scripts/smoke-hub.ts` end-to-end (real routing + reflection).

## Suggested execution order

1. `methodName.ts` grammar + its tests (lock the contract).
2. Composition sites (§2) + `STREAM_METHOD` (§4).
3. Branching fixes (§3).
4. CLI parsing/completions/back-compat (§5).
5. Sweep tests/smoke/docs (§6), then verification (§7).
