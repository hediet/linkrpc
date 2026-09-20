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
import type { ApplicationErrorsOf, PublicApplicationErrorOf } from '@hediet/linkrpc';
import { contract } from './contract';

type CheckError = PublicApplicationErrorOf<
    ApplicationErrorsOf<typeof contract.members.check.errors>
>;

const outcome = await connection.get(contract).check({ mode: 'missing' }).result();
if (!outcome.ok && outcome.error.kind === 'application' && outcome.error.code === 1001) {
    const resource: string = outcome.error.data.resource;
}
```

The Rust-authored fixture produces error codes 1001 through 1005, with literal
messages and typed structured, absent, nullable, recursive, and numeric data.
The TypeScript-authored fixture produces codes 2001 through 2005; generated Rust
exposes these as `CheckError::Code2001(...)` through `CheckError::Code2005(...)`.
Unknown or malformed wire errors do not enter these application-error unions.

Both directions check success, structured and data-less variants, explicit nullable
data, numeric and recursive error data, invalid producer values (`NaN`), unknown and
protocol errors, mismatched messages, malformed or missing data, unexpected data,
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

- TypeScript calls still support ordinary `await`, `then`, and rejection handling.
  Only methods declaring typed errors add `.result()` to their public client type,
  so existing client mocks and streaming types remain compatible. Promise rejection
  types remain unchecked. The old `requestType` error-schema argument is retained
  for source compatibility, but checked errors require `.withErrors(...)`.
- Rust derives typed trait errors from `Result<T, E>` or `Result<T, CallError<E>>`,
  where `E` implements `ApplicationError`; no method error annotation is needed.
  Existing generic `JsonRpcError` methods retain their API. `RequestMember` struct literals now need
  the error declarations and error-component fields (empty for untyped methods).
- Error codes, exact messages, data presence, and normalized data schemas are part
  of the contract hash. Absent data is not interchangeable with `null`.
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
