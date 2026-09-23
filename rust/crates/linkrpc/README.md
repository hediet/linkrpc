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

Application errors are inferred from the method's `Result` error type. Authored
server signatures such as `Result<T, JsonRpcError>` remain unchanged, but their
generated clients return `Result<T, RpcCallError>` so error origins are retained.
No method-level error annotation is needed.

```rust
#[derive(Debug, linkrpc::ApplicationError)]
#[rpc_error(display)]
enum LookupError {
    #[rpc_error(message = "Resource {resource} not found")]
    NotFound { resource: String },
    #[rpc_error(message = "Offline")]
    Offline,
    #[rpc_error(generic)]
    Generic(RpcCallError),
}

#[link_rpc_interface(id = "example.lookup")]
trait Lookup {
    async fn lookup(resource: String) -> Result<String, LookupError>;
}
```

With `#[rpc_error(generic)]`, both server and client return `LookupError` directly.
The single-field fallback variant is not a wire variant and is excluded from schema
reflection. `From<RpcCallError>` decodes a remote error once and places every other
origin directly in the fallback. `From<CallError<LookupError>>` unwraps already
classified errors without decoding again, allowing `?` to forward failures.
The fallback's `into_rpc_error` converts back to the wire error only at the server
boundary; remote and noncompliant originals are preserved.

Enums without a generic variant retain `Result<T, CallError<E>>` clients, with
`CallError::Application` for declared errors and `CallError::Generic` for other
failures. An explicitly authored `Result<T, CallError<E>>` server signature
also retains that client surface, including for handwritten `ApplicationError`
implementations. The derive implements `ClientApplicationError` to select its
client surface. Handwritten codecs used directly as a method's error type can
implement this separate trait with `type ClientError = CallError<Self>` and
delegate `from_call_error` to `CallError::from_call_error`; the existing
`ApplicationError` trait itself requires no new members.

Application variants are produced only when the numeric code is declared and
its decoder succeeds.
For named errors, the message is descriptive, not a discriminator. Unknown codes
produce `Generic(RpcCallError::Remote(error))`. A known code with a
body that the decoder rejects produces
`Generic(RpcCallError::NonCompliantServer { original, issues })`.
Both this variant and `ApplicationErrorDecodeError::Invalid` retain the original
as `Box<JsonRpcError>` to keep the error enums compact. Pattern matching still
exposes `original` and `issues` directly; use `original.as_ref()` to borrow the
wire error or `*original` to recover ownership. The original error, including
absent versus null data, is retained. Each
`ValidationIssue { path, message }` uses a JSON Pointer relative to the wire
error object, such as `/data/type`, `/data/data/resource`, or `/data/resource`.
Decoding runs once per candidate, without a separate JSON Schema validation pass.
Serde is authoritative, including its normal treatment of missing and null
`Option<T>` fields and unknown struct fields. Compliance detection is limited
to what the decoder rejects; it does not enforce stricter schema semantics.
`Generic(RpcCallError::Local(error))` reports local serialization/decoding failures,
while `Generic(RpcCallError::Transport(error))` reports connection failures without inferring their
origin from a peer-controlled error code.

With `#[rpc_error(display)]`, named-field message templates use Rust formatting, including `{resource}` and
`{field:?}`; a single-payload variant can use `{0}` or `{}`. Escaped `{{` and `}}`
produce literal braces. The wire message and opt-in `#[rpc_error(display)]`
implementation use the same rendered text. Reflection retains the template,
not a particular instance's message. Without this opt-in, authored messages remain
literal strings for compatibility. Imported templates are opaque diagnostic
metadata, not Rust format strings or equality checks; generated foreign bindings
must accept any string message for a valid named envelope.

Methods without declared application errors return `RpcCallError` directly on
clients, including notification failures and streaming startup/final responses.
`StreamingCall<R, C, S, E = RpcCallError>` carries the selected final error type.
`StreamSender::send_detailed` retains local/transport origins; legacy `send` and
stream controls still expose wire errors. Low-level `RpcCall::call`, `notify`,
and `call_stream` remain wire-error compatibility APIs. Custom transports should
override their `_detailed` counterparts to preserve origins; defaults cannot
recover transport identity already lost by a legacy implementation.

Codes are signed 32-bit integers and default to `DEFAULT_APPLICATION_ERROR_CODE`
(`1`, a LinkRPC convention, not a JSON-RPC standard code). Explicit codes still
use named envelopes. The reserved `-32768..=-32000` range and LinkRPC cancellation
code `-32800`, duplicate names within a method, and errors on notifications are
rejected. Names must be nonempty. Named variants may share a code, including
with a legacy unnamed declaration; named recognition is attempted first.
All declarations for a code form an explicit union: named branches are tried
before legacy branches, and any valid branch succeeds. If none match, the
result is a server compliance error, never an unhandled remote error.

The wire shape is `{ "code": 1, "message": "Not found", "data": {
"type": "NotFound", "data": { "resource": "widget" } } }`. Unit variants omit
the **inner** `data`; payload variants require it, including explicit `null`
when permitted. Wire names default to the Rust variant identifier; override with
`#[rpc_error(name = "stable-name", message = "...")]`. Named-field and single-payload
variants are supported. A private serde tagged enum performs decoding; the error
enum itself need not derive serde traits.

`ErrorSchema.type` carries the optional wire name, `code` always carries its
resolved numeric value, and `data` describes the inner payload. Imported
schemas without `type` retain legacy raw-data encoding and code/message
validation; generated legacy variants remain `Code1001` or `CodeMinus7`.

### Raw JSON-RPC errors

Use a raw variant for a foreign JSON-RPC error without a tagged envelope:

```rust
#[derive(linkrpc::ApplicationError)]
enum ForeignError {
    #[rpc_error(code = -32001, raw)]
    Busy { message: String, data: BusyData },
    #[rpc_error(code = -32002, raw)]
    Retry {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<String>,
    },
}
```

Raw variants require an explicit code and a body with a string `message`;
they cannot specify a literal `message` or `name` attribute. Named fields
(`message` and optional `data`) and a single serde/JsonSchema body struct are
supported; unit variants are rejected. Reserved foreign server codes are
allowed for raw bindings and imported legacy descriptors. A raw code cannot
be shared with any other variant. Named application errors retain the reserved-code guard.

The raw wire error is `{ "code": -32001, "message": "...", "data": ... }`.
Its canonical descriptor is `{ "code": -32001, "schema": BODY_SCHEMA }`, with
no `message`, `type`, or `data` siblings. `BODY_SCHEMA` is a general supported
JSON Schema applied to the body, excluding the code: it may be `true`, `false`,
a union, a reference, or a broad object schema. It is an additional constraint,
not a static proof of the JSON-RPC envelope shape. Actual raw bodies must still
contain a string `message`, optional JSON `data`, and no other fields.
The serializer enforces that protocol shape even for a permissive schema;
incoming `JsonRpcError` values already have typed protocol fields. In Rust,
`ErrorSchema.schema: Option<JsonValue>` selects that representation; existing
named and legacy descriptors use `schema: None`.

For authored named-field raw variants, `Option<T>` without a skip attribute
means required nullable data; `skip_serializing_if = "Option::is_none"` makes
the field optional with schema `T`. To represent optional **and** nullable data,
use `Option<Option<T>>` with a presence-preserving serde deserializer and skip
only the outer `None` if the application needs to distinguish these values.
Body newtypes use their declared `JsonSchema`. When both null and absence are
legal, ordinary serde `Option<T>` coalescing is allowed, including in generated
raw bodies. Validation runs before deserialization, and compliance errors always
retain the exact original wire data presence.

`ApplicationError::try_from_rpc_error_detailed` returns
`ApplicationErrorDecodeError::Unhandled(original)` or
`ApplicationErrorDecodeError::Invalid { original, issues }`. Its default
implementation preserves source compatibility for existing manual trait
implementers. The original `try_from_rpc_error` method remains available.
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
`()`, as before, `Result<(), JsonRpcError>`, or `Result<(), RpcCallError>`; `Server::dispatch_notification`
exposes decode and handler failures. Default trait method bodies are preserved.

Generated application-error enums use the same `ApplicationError` derive with
`#[rpc_error(schema = __linkrpc_interface::schema, method = "...", display)]`.
The referenced function exposes the one embedded contract: codecs validate its
original error payload schemas, not approximations inferred from Rust types.
Unknown or malformed remote errors remain generic, and invalid outgoing payloads
become internal errors.
Generated error enums include `#[rpc_error(generic)] Generic(RpcCallError)`.
Their generated traits and clients return the enum directly. Without declared
application errors, generated traits use `RpcCallError`, including notifications;
the server adapter converts failures to wire `JsonRpcError` at dispatch.
This differs from authored traits, whose server signatures are preserved.

The generator retains its existing public client/server/type names and
`generate_server`, `default_server_methods`, and `linkrpc_path` options. Its macro
options `client`, `server`, `module`, `runtime`, and `generate_server` carry those
choices; `#[server_notification]` retains event-only client generation.
Regenerated Rust bindings require a LinkRPC release with the `schema_json` macro
mode; the macros are included and re-exported by the `linkrpc` crate.
Regenerating changes Rust error signatures, but not shared JSON or hashes.

The standalone `schema::schemars_to_subset` function retains its inline behavior for
callers that need the original Zod-compatible representation; it still rejects recursion.
Runtime message shapes are unchanged.

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

By default, `GenerateRustOptions::inline_params` exposes params-struct fields as
individual arguments on the generated trait, client, and provider:

```rust,ignore
async fn evaluate(
    expression: String,
    #[serde(rename = "returnByValue")]
    return_by_value: Option<bool>,
) -> Result<RuntimeEvaluateResult, linkrpc::prelude::RpcCallError>;
```

The macro generates a private serialization wrapper and forwards parameter-level
`#[serde(...)]` attributes unchanged to its fields. These have the same behavior
as on an explicit params struct, including `default`, `alias`, `flatten`,
`skip_serializing_if`, `serialize_with`, `deserialize_with`, and `with`.
`#[param(name = "...")]` is only shorthand for `#[serde(rename = "...")]` and
can appear beside other Serde field attributes. Serde diagnoses conflicting
attributes just as it would on a struct.

In Rust-authored interfaces, an unannotated `Option<T>` keeps Serde's defaults: missing and null deserialize
to `None`, which serializes as null. Omission requires `skip_serializing_if`;
rejecting null requires the same custom deserializer an explicit struct would
use. There are no separate `optional` or `nonNull` parameter semantics.
Generated imported interfaces set `omit_optional_params = true` alongside
`schema_json` once per trait. The macro puts omission attributes on
the private wrapper's `Option<T>` fields when the corresponding schema property
is optional. Required nullable properties still serialize `None` as null.
Explicit Serde skip settings take precedence. Whole-payload `#[params]`
arguments are unchanged. This keeps generated signatures readable without
changing their wire behavior.
Generated fields combine their Serde settings into one attribute and omit
redundant `default` on ordinary `Option<T>` fields.

Imported field names are literal unless renamed; Rust-authored interfaces keep
their default camelCase naming. The embedded schema identity is unchanged.
Empty structs become zero-argument methods that encode `{}`. Arguments follow the generated
struct's field order. Open objects with flattened extra properties, non-struct payloads,
external fields without known type paths, and fields conflicting with injected
arguments retain `#[params] params: ParamsType`. `#[params]` means the argument
is the entire wire payload and must be the sole parameter; it cannot be combined
with `#[param(...)]` or field-level `#[serde(...)]` on that argument. Put Serde
attributes on the payload type's fields instead. Set `inline_params: false` to keep the previous
whole-object API for every method. Regeneration with the default is a Rust API
change: callers and providers must pass/receive individual fields instead.

For a complete endpoint, `generate_rust_contract(&contract, &options)` validates
the contract and returns `GeneratedRustContract { files, modules, unsupported }`.
Write `files` into one directory: it contains `mod.rs`, `types.rs`, and a reusable
module for each exact interface identity. `modules` maps `{id, hash}` to its module
name (Rust fields `id`/`hash`, serialized as `interfaceId`/`interfaceHash`).
Bindings are named `ROOT`, `DEFAULT`, `SERVICE_<service-array-index>`, and
`BARE_<bare-array-index>` within the corresponding module. Schemas with no
exposure produce no targets. Shared component names must have identical schemas;
conflicting definitions are rejected rather than generating incompatible types.

All entry points use the same type lowerer and trait macro. Every output has a
generated header.
