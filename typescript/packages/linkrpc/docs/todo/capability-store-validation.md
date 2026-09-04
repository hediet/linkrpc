# TODO: Capability-store validation and pruning

## Goal

Move persisted capability validation into LinkRPC so every managed principal
loads capabilities with the same fail-closed behavior.

Applications should not need to understand signature parsing, issuer-key
resolution, delegation chains, or capability freshness merely to reopen a
principal safely.

## Validation requirements

Validate each persisted capability for:

- complete structural shape
- supported signature metadata
- resolvable issuer signing key
- valid signature over canonical content
- expiration and configured freshness margin
- audience continuity through the delegation chain
- present and matching parent hashes
- maximum delegation depth
- cyclic parent chains

A capability is usable only when it belongs to at least one complete valid
chain ending at the managed principal's audience.

## Proposed API

Prefer validation as part of managed-principal initialization. Also expose an
explicit operation for stores loaded through custom integrations:

```ts
const result = await principal.capBag.pruneInvalid({
    nowMs,
    freshnessMarginMs,
});
```

The result should report retained and removed capability hashes with structured
reason codes. Callers may log those diagnostics, but invalid entries must never
be returned as usable authority.

## Persistence behavior

Pruning should:

1. validate the full snapshot before changing storage
2. retain every capability needed by a valid chain
3. atomically replace the persisted set where the backing store supports it
4. surface persistence failures instead of continuing with a success-shaped
   result

Concurrent additions must not be lost. The capability bag therefore needs
serialization or compare-and-swap semantics around load/prune/write.

## Migration

1. Define structured validation reason codes.
2. Move intrinsic signature/freshness validation into the capability module.
3. Add chain validation and pruning to `CapBag`.
4. Invoke it during managed-principal loading.
5. Migrate personal-bot and remove its duplicate cleanup implementation.
