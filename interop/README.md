# LinkRPC interoperability

Cross-language tests live alongside the TypeScript infrastructure harness in
[`typescript/packages/linkrpc-infra/test/protocols`](../typescript/packages/linkrpc-infra/test/protocols).

## Typed application errors

Run from `typescript/`:

```sh
pnpm --filter @hediet/linkrpc --filter @hediet/linkrpc-hub build
pnpm --filter @hediet/linkrpc-infra test:typed-errors-interop
```

The test uses the existing NDJSON process transport and actual LinkRPC CLI, not a
handwritten copy of the peer's contract:

| Authoring source | Wire contract | Generated peer | Calls exercised |
| --- | --- | --- | --- |
| Rust trait and application-error enum | Rust-exported interface JSON | CLI-generated TypeScript | TS client / Rust server and Rust client / TS server |
| TypeScript request and error definitions | TypeScript-exported interface JSON | Generated Rust client, service trait, and adapter | TS client / Rust server and Rust client / TS server |

The authored inputs are
[`authored.rs`](../typescript/packages/linkrpc-infra/test/protocols/rust-typed-errors/src/authored.rs)
and [`typedErrorsContract.ts`](../typescript/packages/linkrpc-infra/test/protocols/typedErrorsContract.ts).
The test exports their schemas, runs code generation, and compiles and executes
[`typedErrorsPeer.ts.template`](../typescript/packages/linkrpc-infra/test/protocols/typedErrorsPeer.ts.template)
against each generated contract. Rust trait methods infer the error contract from
their `Result` error type; no `#[errors(...)]` annotation is required.

For a CLI-generated TypeScript definition named `contract`, the application-error
union can be named without repeating any wire declarations:

```ts
import { isRpcFailure, type ApplicationErrorsOf, type PublicApplicationErrorOf } from '@hediet/linkrpc';
import { contract } from './contract';

type CheckError = PublicApplicationErrorOf<
    ApplicationErrorsOf<typeof contract.members.check.errors>
>;

const outcome = await connection.get(contract).check({ mode: 'missing' });
if (isRpcFailure(outcome) && outcome.error.code === 1 && outcome.error.type === 'Missing') {
    const resource: string = outcome.error.data.resource;
}
```

Both fixtures declare named variants `Missing`, `Busy`, `Nullable`, `Recursive`,
and `Numeric`. `Missing` and `Busy` share the default LinkRPC application code `1`;
the remaining variants demonstrate optional explicit codes (1003 through 1005 in
Rust, 2003 through 2005 in TypeScript). Generated Rust exposes named enum variants.
JSON-RPC `error.data` contains `{ type, data? }`, with the variant payload in the
inner `data`. Human-readable messages do not select named variants.
Unknown or malformed wire errors do not enter these application-error unions.

The same fixtures also declare plain JSON-RPC errors with codes `-32001`,
`-32002`, and `-32003`. These have no `type` envelope:

```ts
rpcError(-32001, {
    message: z.string(),
    data: z.object({ retryAfter: z.number() }),
});
```

They exercise dynamic diagnostics, structured data, optional arbitrary data
(absent, explicit null, and an object), and a string-or-number payload union.
Clients discriminate these errors by numeric code. Generated bindings preserve
the foreign wire representation rather than inserting a LinkRPC discriminator.

Handledness is code-first: unknown codes remain generic remote errors, while a
response failing the schema for a declared code becomes a noncompliant-server
failure. Tests verify the original error and validation issues are preserved.
The normal TypeScript client throws `NonCompliantServerError`; its result client
returns the same error class under `generic`. Rust exposes
`RpcCallError::NonCompliantServer { original, issues }`.

Both directions check success, structured and data-less variants, explicit nullable
data, numeric and recursive error data, invalid producer values (`NaN`), unknown and
protocol errors, dynamic messages, unknown or absent types, wrong codes,
malformed or missing data, unexpected data,
and closed-object validation. The tests also check
interface hashes, compile the actual generated contracts and their usages, exercise
TypeScript negative type assertions, and deliberately reject an invalid generated
Rust error payload at compile time. Temporary generated files are removed after the
test; Cargo build output is cached under `rust/target/typed-errors-interop`.

Transport closure is tested separately from a peer returning the same reserved
disconnect code: classification follows local versus remote origin, not the number.

Only authored schemas and generated contracts define wire types. Fixture assertions
name expected codes and fields, but do not supply mirror error declarations to the
other language. The full generated-protocol suite remains available with
`pnpm --filter @hediet/linkrpc-infra test:generated-interop`.

## Compatibility and integration notes

- TypeScript's normal client returns successes or branded application failures.
  Generic failures reject the promise. `connection.getResultClient(contract)`
  instead returns both application and generic failures as branded values, including
  for methods without declared errors. Use `isRpcFailure` or a descriptor's `.is`
  matcher rather than interpreting an ordinary JSON object's shape as failure.
  The old `requestType` error-schema argument is retained
  for source compatibility, but checked errors require `.withErrors(...)`.
- Rust derives typed trait errors from `Result<T, E>` or `Result<T, CallError<E>>`,
  where `E` implements `ApplicationError`; no method error annotation is needed.
  Clients separate `CallError::Application(E)` from `CallError::Generic(...)`;
  generic failures preserve remote, local, and transport provenance and identify
  server compliance failures separately.
  Existing generic `JsonRpcError` methods retain their API. `RequestMember` struct literals now need
  the error declarations and error-component fields (empty for untyped methods).
- Error types, codes, default messages, data presence, and normalized payload/body schemas
  are part of the contract hash. Absent data is not interchangeable with `null`.
  Legacy declarations without a type retain code/message-based wire recognition.
  Adding a type changes the wire representation and hash, so requires migrating
  both ends of that interface contract.
- Plain JSON-RPC declarations export as `{ code, schema }`, where `schema`
  describes `{ message, data? }` without the code. They allow documented
  reserved JSON-RPC codes and do not treat diagnostic messages as discriminators
  unless the body schema explicitly restricts them.
- Error components are merged with shared parameter, result, and streaming schema
  components rather than replacing them.

## Typed streaming over real stdio

The Rust `streaming_interop` example defines the contract once with
`#[link_rpc_interface]`. The actual LinkRPC CLI generates the TypeScript binding
from its exported schema; no independently maintained TypeScript schema is used.

From the repository root:

```sh
cd typescript
pnpm install --frozen-lockfile
pnpm turbo build --filter @hediet/linkrpc-cli
cd ..
node interop/generate-streaming.mjs --check
cd typescript
LINKRPC_STREAMING_INTEROP=1 pnpm --filter @hediet/linkrpc test src/connection/streamingInterop.test.ts
```

Omit `--check` to regenerate the fixture after changing the Rust contract.
The opt-in test starts real Rust processes and exercises both client/server
directions, bidirectional typed payloads (including JSON null), both directions
of ping/pong, final payload ordering, structured final errors, advisory
cancellation, disconnect, and exported schema/hash equality.

The ordinary TypeScript suite skips these process tests so it does not require
a Rust toolchain. The package CI runs them explicitly.
