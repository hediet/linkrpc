# Rust source generation

The published `linkrpc` crate includes a generic `linkrpc-codegen` binary:

```sh
cargo install --locked linkrpc --bin linkrpc-codegen
linkrpc-codegen --input definitions.json --output src/generated
linkrpc-codegen --input definitions.json --output src/generated --check
```

Use an exact `--version` when reproducing checked-in output. With no `--input`,
the CLI reads stdin. With no `--output`, it returns a JSON object containing
`files` (filename to Rust source), `unsupported` (fallback diagnostics), and
`interfaceHashes` (module name to computed hash). This lets adapters enforce
their own fallback policy before writing output. `--check` requires `--output`,
does not write, and rejects missing, stale, or obsolete files.

## Definitions versus source layout

The input is a `GenerateRustPackage`, not an endpoint contract:

```json
{
  "modules": [{
    "name": "counter",
    "schema": {
      "id": "example.counter",
      "hash": "",
      "methods": {
        "increment": {
          "params": { "type": "integer" },
          "result": { "type": "integer" }
        }
      }
    },
    "options": {
      "clientName": "CounterClient",
      "generateServer": true,
      "defaultServerMethods": true,
      "bindings": [{
        "name": "TARGET",
        "address": { "kind": "bare", "value": "Counter." }
      }]
    }
  }],
  "facades": [{
    "name": "Client",
    "catalog": "interfaces",
    "members": [{ "name": "counter", "module": "counter", "binding": "TARGET" }]
  }]
}
```

Each module carries a standard LinkRPC interface definition plus optional
`GenerateRustOptions` in camelCase. Empty hashes are filled in; supplied hashes
must match. Package-level `options` control shared types and provide defaults
for modules **without** an `options` override. An override is a complete options
object, with omitted fields taking `GenerateRustOptions::default()` values.
Named addresses serialize as `{ "kind": "root" }`, `{ "kind": "default" }`,
`{ "kind": "service", "value": "service-id" }`, or
`{ "kind": "bare", "value": "WirePrefix." }`.

Components are generated once in `types.rs`. Conflicting definitions of a shared
component are rejected. Other module files reference these same types.
`mod.rs` reexports the shared types and lists modules in input order.
Optional facades compose named bindings into typed client accessors and catalogs;
they do not define another addressing model. Catalog descriptions can be supplied
as `description`. A package `header` is prepended verbatim to every source file.

Different modules may bind the same prefix on **separate routers**, as with
commands offered by a remote endpoint and events consumed locally. A source
package does not claim these are unambiguous on one endpoint. For endpoint
exposure validation, continue using `LinkRpcContract` and
`generate_rust_contract`.

The library API `generate_rust_package` uses the existing interface/component
lowering, preserving defaults, server adapters, wire identity, and unsupported
schema fallbacks. Generated source needs `linkrpc`, `serde` (with `derive`), and
`serde_json`. No protocol-specific adaptation is embedded in the Rust CLI.
