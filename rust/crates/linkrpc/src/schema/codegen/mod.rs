//! Generate Rust source from a [`LinkRpcInterfaceSchema`] JSON document.
//!
//! This is the *schema-document → Rust* direction, the mirror image of the
//! [`link_rpc_interface`](linkrpc_macros::link_rpc_interface) trait macro (which
//! goes *Rust trait → interface*). Given a wire [`LinkRpcInterfaceSchema`] — for
//! example one fetched over `hubrpc.schemas::get`, or produced by the canonical
//! TypeScript toolchain — it emits:
//!
//! - a Rust `struct` / `enum` for each entry in `components.schemas`, with
//!   recursive `$ref`s handled via `Box` where a cycle would otherwise be
//!   infinitely sized,
//! - `struct`/`enum` types for inline method params/results,
//! - a bare trait annotated with `#[link_rpc_interface(schema_json = "...")]`,
//!   preserving the imported JSON and hash rather than re-deriving its schemas,
//! - through that shared macro, a typed async **client** whose methods encode params, issue the call over
//!   an [`RpcCall`](crate::client::RpcCall) transport abstraction, and decode
//!   the result. The client can address linkrpc members (`id::member`) *or* bare
//!   root-addressed method names (e.g. a CDP `Domain.method` channel).
//! - optionally, a typed async provider trait and server adapter implementing
//!   [`InterfaceHandler`](crate::connection::dispatch::InterfaceHandler) and
//!   [`ServiceExport`](crate::connection::dispatch::ServiceExport).
//!
//! Application-error enums also reuse the `ApplicationError` derive, referencing
//! the embedded contract for payload validation. The macros are re-exported by
//! `linkrpc`; generated payload types need Serde, not Schemars.
//!
//! The generator is intentionally **generic**: it contains no CDP- or
//! application-specific logic, and its output is deterministic (stable ordering,
//! stable identifier derivation) so it is safe to check generated files into a
//! repository.
//!
//! Constructs outside the representable subset (heterogeneous enums, tuple rest
//! schemas, standalone `const`, dangling `$ref`, …) are lowered to
//! `serde_json::Value` and reported both in a header comment of the generated
//! source and in [`GeneratedRust::unsupported`].
//!
//! ```
//! use linkrpc::schema::codegen::{generate_rust_interface, GenerateRustOptions};
//! use linkrpc::schema::interface_schema::LinkRpcInterfaceSchema;
//!
//! let doc = r##"{
//!   "id": "com.example.counter",
//!   "hash": "",
//!   "methods": { "increment": { "params": true, "result": { "type": "integer" } } }
//! }"##;
//! let schema: LinkRpcInterfaceSchema = serde_json::from_str(doc).unwrap();
//! let generated = generate_rust_interface(&schema, &GenerateRustOptions::default());
//! assert!(generated.code.contains("ComExampleCounterClient"));
//! ```

mod code_writer;
mod contract;
mod generator;
mod ident;

use crate::schema::interface_schema::LinkRpcInterfaceSchema;
use std::collections::BTreeMap;

pub use crate::schema::contract::InterfaceAddress;
pub use contract::{generate_rust_contract, GeneratedRustContract};

/// A named immutable, typed target emitted alongside the reusable interface.
#[derive(Debug, Clone)]
pub struct GenerateRustBinding {
    pub name: String,
    pub address: InterfaceAddress,
}

/// Options controlling [`generate_rust_interface`].
#[derive(Debug, Clone)]
pub struct GenerateRustOptions {
    /// Crate path used to reference linkrpc runtime items in generated code
    /// (`RpcCall`, `JsonRpcError`, `error_codes`). Defaults to `"linkrpc"`.
    pub linkrpc_path: String,

    /// Explicit name for the generated client struct. Defaults to a
    /// `PascalCase` form of the interface id with a `Client` suffix
    /// (e.g. `com.acme.pizza` → `ComAcmePizzaClient`).
    pub client_name: Option<String>,

    /// Emit a typed `<Base>Service` provider trait and `<Base>Server<T>`
    /// adapter. Disabled by default to preserve the output of existing
    /// client-only generation.
    pub generate_server: bool,

    /// Give generated service trait methods default implementations.
    ///
    /// Request defaults return `METHOD_NOT_FOUND`; notification defaults are
    /// no-ops. This lets providers implement only the supported subset of a
    /// large interface while the server adapter still validates every
    /// recognized notification payload before invoking the default.
    pub default_server_methods: bool,

    /// Expose representable params structs as individual method arguments.
    /// Enabled by default. Set to `false` to always take one `#[params]` object.
    /// Open objects, non-struct payloads, external fields without known type
    /// paths, and fields conflicting with injected arguments keep the object form.
    pub inline_params: bool,

    /// Component wire names mapped to existing Rust type paths. These components
    /// are referenced but not emitted, so interfaces can share one set of types.
    pub external_components: BTreeMap<String, String>,

    /// Prefix for method payload type names, independent of local wire names.
    pub method_type_prefix: Option<String>,

    /// Named typed binding constants. Empty by default.
    pub bindings: Vec<GenerateRustBinding>,
}

impl Default for GenerateRustOptions {
    fn default() -> Self {
        GenerateRustOptions {
            linkrpc_path: "linkrpc".to_string(),
            client_name: None,
            generate_server: false,
            default_server_methods: false,
            inline_params: true,
            external_components: BTreeMap::new(),
            method_type_prefix: None,
            bindings: Vec::new(),
        }
    }
}

/// The result of [`generate_rust_interface`].
#[derive(Debug, Clone)]
pub struct GeneratedRust {
    /// The generated Rust source. Deterministic for a given input.
    pub code: String,

    /// Human-readable notes for every schema construct that could not be
    /// represented natively and was lowered to a fallback (`serde_json::Value`).
    /// Empty when the whole interface lowered cleanly.
    pub unsupported: Vec<String>,
}

/// Shared component source and the exact names chosen by the type generator.
#[derive(Debug, Clone)]
pub struct GeneratedRustComponents {
    pub code: String,
    pub names: BTreeMap<String, String>,
    pub unsupported: Vec<String>,
}

/// Generate a common types module once, then pass its [`GeneratedRustComponents::names`]
/// (qualified with the module path) as [`GenerateRustOptions::external_components`].
pub fn generate_rust_components(
    components: &crate::schema::Components,
    options: &GenerateRustOptions,
) -> GeneratedRustComponents {
    generator::generate_components(components, options)
}

/// Render `schema` as a self-contained Rust source module.
///
/// Never fails: unrepresentable constructs degrade to `serde_json::Value` and
/// are surfaced through [`GeneratedRust::unsupported`].
pub fn generate_rust_interface(
    schema: &LinkRpcInterfaceSchema,
    options: &GenerateRustOptions,
) -> GeneratedRust {
    generator::generate(schema, options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(json: &str) -> LinkRpcInterfaceSchema {
        serde_json::from_str(json).expect("valid interface schema")
    }

    #[test]
    fn deterministic_output() {
        let s = schema(
            r##"{
                "id": "com.example.thing",
                "hash": "",
                "methods": {
                    "b_method": { "params": { "$ref": "#/components/schemas/Foo" }, "result": { "type": "string" } },
                    "a_method": { "params": true }
                },
                "components": { "schemas": {
                    "Foo": { "type": "object", "properties": { "n": { "type": "integer" } }, "required": ["n"], "additionalProperties": false },
                    "Bar": { "type": "object", "properties": { "foo": { "$ref": "#/components/schemas/Foo" } }, "additionalProperties": false }
                }}
            }"##,
        );
        let a = generate_rust_interface(&s, &GenerateRustOptions::default());
        let b = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert_eq!(a.code, b.code, "output must be deterministic");
        // Components emitted in sorted order: Bar before Foo.
        let bar = a.code.find("pub struct Bar").unwrap();
        let foo = a.code.find("pub struct Foo").unwrap();
        assert!(bar < foo, "components emit in sorted name order");
    }

    #[test]
    fn self_recursive_is_boxed() {
        let s = schema(
            r##"{
                "id": "x",
                "hash": "",
                "methods": {},
                "components": { "schemas": {
                    "Node": {
                        "type": "object",
                        "properties": {
                            "value": { "type": "string" },
                            "next": { "$ref": "#/components/schemas/Node" },
                            "children": { "type": "array", "items": { "$ref": "#/components/schemas/Node" } }
                        },
                        "required": ["value"],
                        "additionalProperties": false
                    }
                }}
            }"##,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        // Direct self-reference must be boxed; the Vec element must NOT be.
        assert!(g.code.contains("Option<Box<Node>>"), "{}", g.code);
        assert!(g.code.contains("Vec<Node>"), "{}", g.code);
        assert!(!g.code.contains("Vec<Box<Node>>"), "{}", g.code);
    }

    #[test]
    fn mutual_recursion_is_boxed() {
        let s = schema(
            r##"{
                "id": "x", "hash": "", "methods": {},
                "components": { "schemas": {
                    "A": { "type": "object", "properties": { "b": { "$ref": "#/components/schemas/B" } }, "required": ["b"], "additionalProperties": false },
                    "B": { "type": "object", "properties": { "a": { "$ref": "#/components/schemas/A" } }, "required": ["a"], "additionalProperties": false }
                }}
            }"##,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(g.code.contains("Box<B>"), "{}", g.code);
        assert!(g.code.contains("Box<A>"), "{}", g.code);
    }

    #[test]
    fn streaming_methods_generate_typed_duplex_bindings() {
        let s = schema(
            r##"{
                "id": "com.example.streams", "hash": "",
                "methods": {
                    "exchange": {
                        "params": { "type": "object", "additionalProperties": false },
                        "result": { "type": "integer" },
                        "clientStream": { "$ref": "#/components/schemas/Command" },
                        "serverStream": false
                    }
                },
                "components": { "schemas": {
                    "Command": {
                        "type": "object",
                        "properties": {
                            "next": { "$ref": "#/components/schemas/Command" }
                        },
                        "additionalProperties": false
                    }
                }}
            }"##,
        );
        let g = generate_rust_interface(
            &s,
            &GenerateRustOptions {
                generate_server: true,
                ..GenerateRustOptions::default()
            },
        );
        assert!(g.unsupported.is_empty(), "{:?}", g.unsupported);
        assert!(g.code.contains("#[linkrpc::prelude::link_rpc_interface("));
        assert!(g.code.contains("#[input_stream(Command)]"));
        assert!(g
            .code
            .contains("#[output_stream(linkrpc::prelude::NoStream)]"));
        assert!(g.code.contains(r#"\"serverStream\":false"#));
        assert!(g
            .code
            .contains(r##"\"clientStream\":{\"$ref\":\"#/components/schemas/Command\"}"##));
        assert!(g.code.contains("Option<Box<Command>>"));
    }

    #[test]
    fn rejects_streams_on_notifications() {
        let s = schema(
            r#"{
                "id": "com.example.bad", "hash": "",
                "methods": {
                    "bad": {
                        "params": true,
                        "clientStream": { "type": "string" }
                    }
                }
            }"#,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(g
            .unsupported
            .iter()
            .any(|note| note.contains("streams on notifications are invalid")));
        assert!(g
            .code
            .contains("compile_error!(\"linkrpc methods with streams must declare a result\")"));
    }

    #[test]
    fn tagged_union_and_string_enum() {
        let s = schema(
            r##"{
                "id": "x", "hash": "", "methods": {},
                "components": { "schemas": {
                    "Status": {
                        "oneOf": [
                            { "type": "object", "properties": { "state": { "const": "queued" } }, "required": ["state"], "additionalProperties": false },
                            { "type": "object", "properties": { "state": { "const": "baking" }, "progress": { "type": "number" } }, "required": ["state", "progress"], "additionalProperties": false }
                        ],
                        "discriminator": { "propertyName": "state" }
                    },
                    "Size": { "enum": ["small", "large"] }
                }}
            }"##,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(g.code.contains("#[serde(tag = \"state\")]"), "{}", g.code);
        assert!(
            g.code.contains("#[serde(rename = \"queued\")]"),
            "{}",
            g.code
        );
        assert!(g.code.contains("Baking {"), "{}", g.code);
        assert!(
            g.code.contains("#[serde(rename = \"small\")]"),
            "{}",
            g.code
        );
    }

    #[test]
    fn reserved_keyword_enum_variants_are_sanitized() {
        // `self` maps to the reserved word `Self`, which cannot be a raw
        // identifier and must be escaped with a trailing underscore. Other
        // keyword-shaped values (`type`, `match`, `crate`) must also stay valid.
        let s = schema(
            r##"{
                "id": "x", "hash": "", "methods": {},
                "components": { "schemas": {
                    "TargetHint": { "enum": ["blank", "self", "type", "match", "crate"] }
                }}
            }"##,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        // No bare reserved keyword variant should appear.
        assert!(!g.code.contains("\n    Self,"), "{}", g.code);
        // The sanitized variant is present with a serde rename to the wire value.
        assert!(g.code.contains("Self_,"), "{}", g.code);
        assert!(g.code.contains("#[serde(rename = \"self\")]"), "{}", g.code);
        // Every subsequent variant is still generated (parsing did not stop).
        assert!(g.code.contains("Blank,"), "{}", g.code);
        assert!(g.code.contains("Type,"), "{}", g.code);
        assert!(g.code.contains("Match,"), "{}", g.code);
        assert!(g.code.contains("Crate,"), "{}", g.code);
    }

    #[test]
    fn unsupported_is_reported() {
        let s = schema(
            r##"{
                "id": "x", "hash": "", "methods": {},
                "components": { "schemas": {
                    "Mixed": { "enum": ["a", 1, true] }
                }}
            }"##,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(!g.unsupported.is_empty());
        assert!(g.code.contains("serde_json::Value"));
    }

    #[test]
    fn params_object_ctor_takes_required_fields_in_field_order() {
        // Field order in the constructor must match the emitted struct field
        // order, which in turn follows property declaration order (the JSON
        // parser preserves insertion order).
        let s = schema(
            r##"{
                "id": "x", "hash": "",
                "methods": {
                    "do_thing": {
                        "params": {
                            "type": "object",
                            "properties": {
                                "second": { "type": "string" },
                                "first": { "type": "integer" },
                                "note": { "type": "string" }
                            },
                            "required": ["second", "first"],
                            "additionalProperties": false
                        }
                    }
                }
            }"##,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(
            g.code
                .contains("pub fn new(second: String, first: i64) -> Self {"),
            "{}",
            g.code
        );
        assert!(
            g.code
                .contains("second,\n            first,\n            note: None,"),
            "{}",
            g.code
        );
    }

    #[test]
    fn empty_object_gets_niladic_constructor() {
        let s = schema(
            r##"{
                "id": "x", "hash": "",
                "methods": {
                    "ping": {
                        "params": { "type": "object", "additionalProperties": false }
                    }
                }
            }"##,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(g.code.contains("pub struct PingParams {}"));
        assert!(g.code.contains("impl PingParams {"));
        assert!(g
            .code
            .contains("pub fn new() -> Self {\n        Self {}\n    }"));
    }

    #[test]
    fn open_object_extra_map_defaults_and_is_not_a_parameter() {
        let s = schema(
            r##"{
                "id": "x", "hash": "", "methods": {},
                "components": { "schemas": {
                    "Bag": {
                        "type": "object",
                        "properties": { "id": { "type": "string" } },
                        "required": ["id"],
                        "additionalProperties": true
                    }
                }}
            }"##,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(g.code.contains("pub fn new(id: String) -> Self {"));
        assert!(g.code.contains("extra: Default::default(),"));
        assert!(!g.code.contains("pub fn new(id: String, extra:"));
    }

    #[test]
    fn recursive_required_field_ctor_takes_boxed_type() {
        // A required field that is itself a same-SCC named reference is
        // rendered as `Box<T>` (finite size); the constructor parameter type
        // must match the field's rendered type exactly.
        let s = schema(
            r##"{
                "id": "x", "hash": "", "methods": {},
                "components": { "schemas": {
                    "Cons": {
                        "type": "object",
                        "properties": {
                            "value": { "type": "string" },
                            "next": { "$ref": "#/components/schemas/Cons" }
                        },
                        "required": ["value", "next"],
                        "additionalProperties": false
                    }
                }}
            }"##,
        );
        let g = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(g.code.contains("pub next: Box<Cons>,"), "{}", g.code);
        assert!(
            g.code
                .contains("pub fn new(value: String, next: Box<Cons>) -> Self {"),
            "{}",
            g.code
        );
    }

    #[test]
    fn server_generation_is_opt_in_and_uses_typed_provider_api() {
        let s = schema(
            r##"{
                "id": "com.example.echo", "hash": "frozen-hash",
                "methods": {
                    "echo": {
                        "params": { "type": "string" },
                        "result": { "type": "string" }
                    },
                    "stop": { "params": true },
                    "changed": {
                        "params": { "type": "string" },
                        "x-linkrpc-codegen": { "kind": "serverNotification" }
                    }
                }
            }"##,
        );
        let client_only = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(client_only.code.contains("generate_server = false"));

        let generated = generate_rust_interface(
            &s,
            &GenerateRustOptions {
                generate_server: true,
                ..GenerateRustOptions::default()
            },
        );
        assert!(generated.code.contains("pub trait ComExampleEchoService"));
        assert!(generated.code.contains("generate_server = true"));
        assert!(generated.code.contains("server = \"ComExampleEchoServer\""));
        assert!(generated
            .code
            .contains("pub use __linkrpc_interface::interface;"));
        assert!(generated.code.contains(
            "async fn echo(#[params] params: String) -> Result<String, linkrpc::prelude::JsonRpcError>;"
        ));
        assert!(generated.code.contains(
            "async fn stop(#[params] params: serde_json::Value) -> Result<(), linkrpc::prelude::JsonRpcError>;"
        ));
        assert!(generated.code.contains(
            "async fn changed(#[params] params: String) -> Result<(), linkrpc::prelude::JsonRpcError>;"
        ));
        assert!(generated.code.contains("#[server_notification]"));
        assert!(!generated.code.contains("impl<C"));
        assert!(!generated.code.contains("impl<T"));
        assert!(generated.code.contains("frozen-hash"));

        let generated_with_defaults = generate_rust_interface(
            &s,
            &GenerateRustOptions {
                generate_server: true,
                default_server_methods: true,
                ..GenerateRustOptions::default()
            },
        );
        assert!(generated_with_defaults.code.contains(
            "Err(linkrpc::prelude::JsonRpcError::new(linkrpc::prelude::error_codes::METHOD_NOT_FOUND, \"echo\"))"
        ));
        assert!(generated_with_defaults.code.contains(
            "async fn changed(#[params] params: String) -> Result<(), linkrpc::prelude::JsonRpcError> {\n        let _ = (ctx, params,);\n        Ok(())"
        ));
    }

    #[test]
    fn null_schema_lowers_to_unit_without_fallback_diagnostic() {
        let s = schema(
            r##"{
                "id": "example.null", "hash": "",
                "methods": {
                    "close": {
                        "params": { "type": "null" },
                        "result": { "type": "null" }
                    }
                },
                "components": { "schemas": {
                    "NullableText": {
                        "anyOf": [
                            { "type": "string" },
                            { "type": "null" }
                        ]
                    }
                }}
            }"##,
        );
        let generated = generate_rust_interface(&s, &GenerateRustOptions::default());
        assert!(
            generated.unsupported.is_empty(),
            "{:?}",
            generated.unsupported
        );
        assert!(generated
            .code
            .contains("async fn close(#[params] params: ()) -> Result<(),"));
        assert!(generated.code.contains("Variant1(())"));
        assert!(!generated.code.contains("`null` type"));
        assert_eq!(serde_json::to_value(()).unwrap(), serde_json::Value::Null);
        serde_json::from_value::<()>(serde_json::Value::Null).unwrap();
    }
}
