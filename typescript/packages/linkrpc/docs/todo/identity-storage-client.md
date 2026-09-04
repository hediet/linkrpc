# TODO: Identity storage client abstraction

## Goal

Provide an idiomatic, testable client for the existing
`identity.storage` LinkRPC interface.

The wire interface already belongs to LinkRPC, but applications currently
repeat an adapter with this shape:

```ts
interface IdentityKeyValueStorage {
    get<T = JsonValue>(key: string): Promise<T | undefined>;
    set(key: string, value: JsonValue): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(prefix?: string): Promise<string[]>;
}
```

## Proposed API

Expose a helper from the package that owns `identityStorageInterface`:

```ts
function identityKeyValueStorage(
    connection: LinkRpcConnection,
): IdentityKeyValueStorage;
```

The adapter must use the participant's private root overlay and preserve the
current unsigned-call behavior.

Also provide an in-memory implementation for tests. It should round-trip
values through serialization or structured cloning so callers cannot mutate
stored values by reference.

## Schema validation

A convenience helper may read and validate a stored value:

```ts
readStoredValue(storage, key, schema)
```

Open decision: keep this helper in LinkRPC with the existing Zod peer
dependency, or leave schema-policy helpers to applications. Invalid persisted
data must produce an explicit diagnostic rather than silently behaving as a
valid missing value.

## Migration

1. Add the narrow storage interface and connection adapter.
2. Add an in-memory implementation and behavioral tests.
3. Migrate personal-bot consumers.
4. Remove the duplicate personal-bot adapter after adoption.
