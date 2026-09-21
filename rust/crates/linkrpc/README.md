# linkrpc

Typed, multiplexed RPC over a single bidirectional connection — a Rust implementation of the
[LinkRPC protocol](../../../spec).

## Installation

Add the published package to your project:

```toml
[dependencies]
linkrpc = "0.1.0"
```

The `linkrpc-macros` dependency is included automatically; its procedural macros
are re-exported by `linkrpc`.

linkrpc is a **specialization of [JSON-RPC 2.0](https://www.jsonrpc.org/specification)**: every
message on the wire is a valid JSON-RPC message, and linkrpc adds just enough on top to make many
strongly-typed services share one connection — an addressing grammar, content-hashed interface
identity, built-in reflection, and optional layers for streaming, signing, and capabilities.

You write a plain Rust trait. The `#[link_rpc_interface]` macro turns it into a server adapter, a
typed client, and a self-describing interface descriptor. The rest — routing, request/response
correlation, schema validation, reflection — is handled for you.

```rust
use linkrpc::prelude::*;

/// Order pizzas and track delivery.
#[link_rpc_interface(id = "com.acme.pizza")]
pub trait PizzaService {
    /// Place a new pizza order. Charges money.
    #[annotations(dangerous)]
    async fn order(kind: PizzaKind, size: Size, quantity: u32)
        -> Result<OrderConfirmation, JsonRpcError>;

    /// Fire-and-forget cancel request.
    #[notification]
    async fn cancel_order(order_id: String);
}
```

From that one trait you get:

| Generated item | Role |
|---|---|
| `PizzaService` (rewritten) | the trait your provider implements (`&self`, `&CallCtx`-first) |
| `PizzaServiceServer` | an `InterfaceHandler` adapter — register it and serve |
| `PizzaServiceClient` | a typed caller proxy with plain `async fn` methods |

## Typed application errors

Application errors are inferred from the method's `Result` error type; existing
`Result<T, JsonRpcError>` methods are unchanged. No error annotation is needed.

```rust
#[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
struct MissingData { resource: String }

#[derive(linkrpc::ApplicationError)]
enum LookupError {
    #[rpc_error(code = 1001, message = "Missing")]
    Missing(MissingData),
    #[rpc_error(code = -7, message = "Offline")]
    Offline,
}

#[link_rpc_interface(id = "example.lookup")]
trait Lookup {
    async fn lookup(resource: String) -> Result<String, LookupError>;
}
```

The server trait may return either `LookupError` directly or
`CallError<LookupError>` when it also needs to forward a raw remote error. The client returns
`Result<String, CallError<LookupError>>`. `CallError::Application` is produced
only when code, message, data presence, and schema all match. Otherwise
`CallError::Remote` retains the original `JsonRpcError`.
`CallError::Local` reports local serialization/decoding failures, while
`CallError::Transport` reports connection failures without inferring their
origin from a peer-controlled error code.

Codes are signed 32-bit integers. The reserved `-32768..=-32000` range and
LinkRPC cancellation code `-32800`,
duplicate codes within a method, and errors on notifications are rejected.
Unit variants require absent `data`; payload variants require present,
schema-valid `data` (including `null` when its schema permits it).
Schema-driven generation emits stable variants such as `Code1001` and
`CodeMinus7`.
| `pizza_service::interface()` / `::ID` | the interface descriptor and its content hash |

## Why content-hashed interfaces?

Every interface has an identity of the form `com.acme.pizza@<hash>`, where the hash is computed
from the *normalized* schema of its members (parameter types, result types, docs, annotations).
Two peers agree on an interface **only when their contracts are structurally identical** — so a
Rust server and a TypeScript client interoperate at
`com.acme.pizza@<hash>` only if their types line up exactly. Mismatches surface up front as a hash
disagreement instead of as a runtime decode error three calls later.

The hashing is byte-for-byte defined (RFC 8785 JCS → SHA-256, truncated to 16 hex chars) and pinned
by a shared [conformance corpus](../../../conformance), so independent implementations in different
languages compute the same hash for the same contract.

### Shared schemas in trait exports

Built-in reflection interfaces retain their original inline schemas and hashes.
For existing non-recursive contracts that must preserve that layout, use
`#[link_rpc_interface(id = "...", schema = "inline")]`. This reuses the standalone
Schemars conversion for params, results, and stream payloads; the default remains
shared schemas. Declared application-error components are retained independently.

Trait descriptors export reusable types once in `components.schemas`. Method parameters,
results, and nested types refer to those definitions with `#/components/schemas/...`.
The same type is shared across the entire interface, rather than expanded separately at
each use. Guarded recursive types (such as nodes containing child nodes) retain finite
references. Type and field descriptions remain part of the contract. This does not extend
the supported schema subset to arbitrary intersections or unguarded reference cycles.

Types are registered in schema-identity order, so reordering trait methods does not
change component allocation or the hash. Sharing uses Schemars' `JsonSchema::schema_id`,
not structural similarity. As with Schemars itself, custom implementations must give
different contracts different schema IDs; generic `#[schemars(rename = "...")]`
attributes should include their type parameters. Schemars can number colliding display
names, so adding another colliding type or changing nested type discovery can rename
components. Names are deterministic for a fixed type graph, not a promise of stable
names across contract edits.

Exports that now use shared definitions intentionally have different JSON and content
hashes from their previously inlined versions. Primitive-only exports need not change.
The hash algorithm has not changed: component names and reference topology are
part of the canonical document, so an inlined document and a referenced document need not
have the same hash even if they accept the same values. Regenerate consumers from the
exported interface JSON; do not hand-author matching TypeScript types or assume a separately
declared Zod interface has the same identity. For TypeScript CLI generation, use
`linkrpc codegen --preserve-wire-schema` to retain the exported contract exactly.
The JSON-to-Rust generator also consumes these existing component references.

### Imported JSON uses the same trait macro

`generate_rust_interface` emits data types and a bare trait annotated with
`#[link_rpc_interface(schema_json = "...")]`, not a second client/server
implementation. The JSON includes the original hash, components, descriptions,
and extensions. This mode uses that contract directly rather than deriving a
new Schemars schema from the generated Rust types:

```rust
use linkrpc::prelude::*;

#[link_rpc_interface(schema_json = r#"{
    "id": "example.echo",
    "hash": "",
    "methods": {
        "echoValue": {
            "params": { "type": "string" },
            "result": { "type": "string" }
        }
    }
}"#)]
trait Echo {
    #[name("echoValue")]
    async fn echo_value(#[params] value: String) -> Result<String, JsonRpcError>;
}
```

The macro infers the id from JSON. A supplied hash is preserved; an empty hash
is computed from the imported contract. It checks that the trait covers every
wire method with matching request/notification and stream directions.
Imported data types need Serde, but not `JsonSchema`. Stream validation retains
the JSON's constraints and component references, including explicit `false`.

Both authored and imported traits now use generic `RpcCall` clients (defaulting
to `LinkRpcConnection`). `new`, `root`, `with_service`, and `with_prefix` select
addressing without changing wire method names. Notifications may return either
`()`, as before, or `Result<(), JsonRpcError>`; `Server::dispatch_notification`
exposes decode and handler failures. Default trait method bodies are preserved.

Generated application-error enums use the same `ApplicationError` derive with
`#[rpc_error(schema = __linkrpc_interface::schema, method = "...", display)]`.
The referenced function exposes the one embedded contract: codecs validate its
original error payload schemas, not approximations inferred from Rust types.
Unknown or malformed remote errors remain generic, and invalid outgoing payloads
become internal errors.

The generator retains its existing public client/server/type names and
`generate_server`, `default_server_methods`, and `linkrpc_path` options. Its macro
options `client`, `server`, `module`, `runtime`, and `generate_server` carry those
choices; `#[server_notification]` retains event-only client generation.
Regenerated Rust bindings require a LinkRPC release with the `schema_json` macro
mode; the macros are included and re-exported by the `linkrpc` crate.
Source goldens change, but the shared JSON, hashes, and public call signatures do not.

The standalone `schema::schemars_to_subset` function retains its inline behavior for
callers that need the original Zod-compatible representation; it still rejects recursion.
Runtime message shapes and the generated trait client/server APIs are unchanged.

The [shared-schema interoperability fixture](../../../interop/shared-schemas) measures
the reduction and exercises the CLI-generated TypeScript and JSON-generated Rust peers.

## Serving and calling

A connection wraps any message transport and hosts a live registry of interfaces. Registering an
interface also lets you opt into reflection, so peers can discover and introspect your services
with no prior knowledge.

```rust
use linkrpc::prelude::*;
use std::sync::Arc;

// in-memory pair for tests; real transports live in `linkrpc-tokio`
let (a, b) = transport_pair();
let client_conn = LinkRpcConnection::new(Box::new(a));
let server_conn = LinkRpcConnection::new(Box::new(b));

server_conn.register(
    Arc::new(pizza_service::interface()),
    Arc::new(PizzaServiceServer::new(Arc::new(Shop::default()))) as Arc<dyn InterfaceHandler>,
    RegisterOptions::default(),
)?;
server_conn.enable_reflection();   // directory / schemas / defaults, for free

let pizza = PizzaServiceClient::new(client_conn.clone());
tokio::spawn(async move { server_conn.run().await });
tokio::spawn(async move { client_conn.run().await });

let confirmation = pizza.order(PizzaKind::Pepperoni, Size::Large, 2).await?;
```

See [`crates/linkrpc-tokio/tests/macro_pizza.rs`](../linkrpc-tokio/tests/macro_pizza.rs) for the full
runnable example.

## Reflection — discoverability built in

Calling `enable_reflection()` exposes three standard interfaces backed by the connection's live
registry:

- **`hubrpc.directory`** — which services and interfaces this connection serves (each with its `id@hash`).
- **`hubrpc.schemas`** — the full schema for any advertised interface.
- **`hubrpc.defaults`** — the connection's preset service/interface, if any.

Because a node's contract is observable from the boundary, tools and conformance checkers can
discover what a node offers rather than being told.

## A layered protocol

linkrpc is built in additive layers. Lower layers stand alone; higher ones ride in reserved
`$hubrpc`-prefixed members that a peer who doesn't implement them treats as opaque. That's what lets
a minimal "Core" node and a full "Capability" node interoperate on any call that needs no gated
authority.

| Layer | What it adds |
|---|---|
| Messages | JSON-RPC envelope, `::` method grammar, error codes |
| Transport | framed whole-message byte stream + endpoint URIs |
| Interfaces | schema format, JSON Schema subset, the interface hash |
| Reflection | `hubrpc.directory` / `.schemas` / `.defaults` |
| Streaming *(optional)* | in-flight correlated stream messages |
| Identity *(optional)* | Ed25519-signed calls |
| Capabilities *(optional)* | signed grants + an authorization gate |

The full normative protocol lives in the repository's shared [`spec/`](../../../spec) directory.

## The crates

| Crate | Contents |
|---|---|
| **`linkrpc`** (this crate) | protocol core, schema/hashing, the connection runtime, reflection |
| **`linkrpc-macros`** | the `#[link_rpc_interface]` procedural macro |
| **`linkrpc-tokio`** | Tokio transports (NDJSON over Unix sockets) |

## Status

This is a port-in-progress of the TypeScript `@hediet/linkrpc` framework. The **wire core, schema
hashing, connection runtime, reflection, typed streaming, and the `#[link_rpc_interface]` macro are
implemented and interop-tested** against the TS reference. Streaming methods use
`#[input_stream(T)]` for caller-to-provider payloads and `#[output_stream(T)]` for
provider-to-caller payloads. Identity (Ed25519) and capabilities are specified and on the roadmap
— see [`executionPlan.md`](../../executionPlan.md).

## License

MIT.
## Static contracts, typed bindings, and shared generated types

`schema::LinkRpcContract` describes an endpoint without coupling interface
definitions to exposure:

```json
{
  "interfaceSchemas": [],
  "services": [{ "serviceId": "", "interfaces": [] }],
  "bareInterfaces": []
}
```

`services`, `defaultInterface`, and `bareInterfaces` are optional. Every interface
reference is `{ "interfaceId": "...", "interfaceHash": "..." }` and resolves by **both** fields.
Call `contract.validate()` to check schema hashes, exact references, duplicate
services/interface routes, and conflicting bare prefixes. Nested prefixes are
allowed; dispatch selects the longest matching prefix. The default preset and
an empty bare prefix may reference the same exact interface, but conflicting
identities are rejected.

The macro-generated client type is also an `InterfaceContract` type witness:

```rust,ignore
use linkrpc::binding::{BindingAddress, InterfaceBinding};

const TARGET: InterfaceBinding<RuntimeClient> =
    InterfaceBinding::new(BindingAddress::Bare("Runtime."));

let client = TARGET.client(session_caller); // Any RpcCall, including a Channel.
let registration =
    TARGET.register(&connection, Arc::new(RuntimeServer::new(provider)))?;
```

Descriptors are immutable and transport-independent. Their private state pairs
the interface type with an address; `interface()`, `reference()`, `address()`,
and `prefix()` expose read-only views. Provider registration accepts only an
adapter implementing `InterfaceProvider` for that interface.

`target.descriptor()` returns a type-erased `InterfaceBindingDescriptor` with
read-only `schema()`, `prefix()`, and `address()` accessors. Heterogeneous
catalogues can therefore derive all metadata from their generated targets:

```rust,ignore
let interfaces = [runtime::TARGET.descriptor(), debugger::TARGET.descriptor()];
```

The schema comes from the generated interface's embedded contract. No schema
files, importer, package installation, or independent prefix table is needed at
runtime.

| Address | Wire method | Registration |
| --- | --- | --- |
| `Root` | `interface::member` | Root interface and reflection metadata |
| `Service("id")` | `id::interface::member` | Named service and reflection metadata |
| `Service("")` | `interface::member` | Same as root; no empty wire segment |
| `Default` | `member` | Root interface, reflection metadata, and default preset |
| `Bare("")` | `member` | Root interface, reflection metadata, and empty-prefix route |
| `Bare("Domain.")` | `Domain.member` | Root interface, reflection metadata, and exact-prefix route |

Bare descriptors reuse the existing `RegisterOptions::bare_prefix` semantics:
an additional prefix route on a reflected qualified registration. “Metadata-free”
describes their foreign-protocol calls, not hidden provider registrations.
`Default` retains native streaming support; `Bare` clients reject streaming
interfaces before sending any protocol frames. Use `try_client` for a fallible
constructor; `client` panics for an invalid streaming/bare combination.
Legacy client constructors retain their behavior. Register a `Default` or `Bare`
target once to expose its qualified and prefix routes; a second `Root`
registration would duplicate its root route.

### Standalone provider and event routing

`InterfaceRouter` exposes the connection's existing dispatcher without requiring
a transport. The same descriptors register into either runtime:

```rust,ignore
use linkrpc::binding::InterfaceRouter;
use linkrpc::prelude::{CallCtx, InterfaceHandler};

let router = InterfaceRouter::new();
runtime::TARGET.register(
    &router, Arc::new(runtime::RuntimeServer::new(runtime_provider)),
)?;
debugger::TARGET.register(
    &router, Arc::new(debugger::DebuggerServer::new(debugger_provider)),
)?;

// Full wire name; returns false for unknown methods, or INVALID_PARAMS for
// malformed known event payloads. Uses the generated adapter's typed decoder.
let handled = router.dispatch_notification("Runtime.changed", event_params).await?;
let result = InterfaceHandler::handle_request(
    &router, "Runtime.evaluate", request_params, CallCtx::default(),
).await?;
```

The router implements both `InterfaceHandler` and `RequestHandler`, so it can
also be passed directly to `Channel::new`. `connection.router()` returns a clone
sharing that connection's live registry, registrations, and disposal. There is
no second routing algorithm or manually implemented event decoder.

### Generating common types and reusable interfaces

Generate common components once, then use the returned exact name map for each
interface. The original schema and hash remain embedded in each interface; the
external map affects only Rust type emission.

```rust,ignore
use linkrpc::schema::codegen::{
    generate_rust_components, generate_rust_interface, GenerateRustBinding,
    GenerateRustOptions, InterfaceAddress,
};

let shared = generate_rust_components(&components, &GenerateRustOptions::default());
// Write shared.code to types.rs.
let generated = generate_rust_interface(&runtime_schema, &GenerateRustOptions {
    client_name: Some("RuntimeClient".into()),
    generate_server: true,
    default_server_methods: true,
    method_type_prefix: Some("Runtime".into()),
    external_components: shared.names.iter()
        .map(|(wire, rust)| (wire.clone(), format!("super::types::{rust}")))
        .collect(),
    bindings: vec![GenerateRustBinding {
        name: "TARGET".into(),
        address: InterfaceAddress::Bare("Runtime.".into()),
    }],
    ..Default::default()
});
// Write generated.code to runtime.rs, a sibling module of types.rs.
```

A local method `evaluate` now produces `RuntimeEvaluateParams` and
`RuntimeEvaluateResult`, while calls still use the local method name plus the
binding's exact prefix. Different domain clients/providers use the **same** Rust
component types. Recursive components retain the existing generator's boxing.
Default provider methods return method-not-found, including methods with typed
application errors; notification defaults are no-ops.

For a complete endpoint, `generate_rust_contract(&contract, &options)` validates
the contract and returns `GeneratedRustContract { files, modules, unsupported }`.
Write `files` into one directory: it contains `mod.rs`, `types.rs`, and a reusable
module for each exact interface identity. `modules` maps `{id, hash}` to its module
name (Rust fields `id`/`hash`, serialized as `interfaceId`/`interfaceHash`).
Bindings are named `ROOT`, `DEFAULT`, `SERVICE_<service-array-index>`, and
`BARE_<bare-array-index>` within the corresponding module. Schemas with no
exposure produce no targets. Shared component names must have identical schemas;
conflicting definitions are rejected rather than generating incompatible types.

All entry points use the existing type lowerer and trait macro. Every output has
a generated header. The original single-interface API and its default generated
source remain unchanged.
