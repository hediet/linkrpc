# Shared Rust trait schema regression fixture

`shared-schemas-contract` declares one daemon-shaped
`#[link_rpc_interface]` trait. Its `Snapshot` graph covers repeated nested
records, `title`/`format`/`definitions` property names, options, lists, maps,
and a tagged union.

`shared-schemas-peer` exports that trait's canonical JSON and uses the same
JSON at build time with `generate_rust_interface`. The CLI Vitest fixture
passes the export through `linkrpc codegen --preserve-wire-schema`, type-checks
and executes generated TypeScript client/server wrappers, and covers all four
Rust/TS client/server directions (original trait and JSON-generated Rust).
Every request method, including `restore` and `archive`, runs through both Rust
implementations. The Rust build fails if JSON codegen reports any unsupported
construct.

The test also runs CLI codegen without `--preserve-wire-schema` and explicitly
asserts that its Zod-regenerated contract does not retain the Rust canonical
hash (currently `21d808c9c90e6118` versus canonical `9fac39d9607de325`).

The `measure` mode constructs the real legacy contract by calling the retained
`schemars_to_subset(schema_for!(T))` path for every fixture parameter and
result, while preserving method metadata from the trait export. It separately
expands the new shared graph and requires exact structural equality with that
legacy contract before comparing compact JSON bytes.

The frozen old-inline form is **58,829 compact UTF-8 bytes**, with 325 repeated
object schemas across 8 methods. The shared form is **3,384 bytes**, with 5
components and 10 object schemas. The Vitest assertion pins both byte and
duplication counts and requires more than 50% reduction.

Run from the repository root:

```sh
cargo run --locked --manifest-path interop/shared-schemas/Cargo.toml \
  -p shared-schemas-peer -- measure
cd typescript
pnpm --filter @hediet/linkrpc-cli exec vitest --run src/commands/sharedSchemas.test.ts
```
