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
- Rust's typed trait error support is opt-in with `#[errors(E)]`; existing generic
  `JsonRpcError` methods retain their API. `RequestMember` struct literals now need
  the error declarations and error-component fields (empty for untyped methods).
- Error codes, exact messages, data presence, and normalized data schemas are part
  of the contract hash. Absent data is not interchangeable with `null`.
- The independently developed Rust streaming and trait-schema-dedup work was not
  imported. Integration touchpoints are the trait macro, `RequestMember`,
  interface-schema construction, schema-reference hoisting, and the Rust call path.
  Error components must be merged with other schema positions, not replace them.
