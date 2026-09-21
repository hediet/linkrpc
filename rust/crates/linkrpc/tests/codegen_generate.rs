//! Determinism + no-drift guard for the generator.
//!
//! Regenerates the interface from the same schema and asserts the output is
//! byte-identical to the committed golden file (`generated_graph.rs`). If this
//! fails after an intentional generator change, re-bless with:
//! `cargo test -p linkrpc --test codegen_bless -- --ignored`.

use std::path::PathBuf;

use linkrpc::schema::codegen::{generate_rust_interface, GenerateRustOptions};
use linkrpc::schema::interface_schema::LinkRpcInterfaceSchema;

fn codegen_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("codegen")
}

fn generate() -> linkrpc::schema::codegen::GeneratedRust {
    let text = std::fs::read_to_string(codegen_dir().join("graph_interface.json")).unwrap();
    let schema: LinkRpcInterfaceSchema = serde_json::from_str(&text).unwrap();
    generate_rust_interface(&schema, &GenerateRustOptions::default())
}

fn generate_server() -> linkrpc::schema::codegen::GeneratedRust {
    let text = std::fs::read_to_string(codegen_dir().join("graph_interface.json")).unwrap();
    let schema: LinkRpcInterfaceSchema = serde_json::from_str(&text).unwrap();
    generate_rust_interface(
        &schema,
        &GenerateRustOptions {
            generate_server: true,
            default_server_methods: true,
            ..GenerateRustOptions::default()
        },
    )
}

fn schema(json: &str) -> LinkRpcInterfaceSchema {
    serde_json::from_str(json).expect("valid interface schema")
}

#[test]
fn matches_golden_file() {
    let generated = generate();
    let golden = std::fs::read_to_string(codegen_dir().join("generated_graph.rs")).unwrap();
    // Normalize line endings so the test is stable across platforms/git config.
    let got = generated.code.replace("\r\n", "\n");
    let want = golden.replace("\r\n", "\n");
    assert_eq!(
        got, want,
        "generated code drifted from golden file; re-bless with `cargo test -p linkrpc --test codegen_bless -- --ignored`"
    );
}

#[test]
fn server_matches_golden_file() {
    let generated = generate_server();
    let golden = std::fs::read_to_string(codegen_dir().join("generated_graph_server.rs")).unwrap();
    let got = generated.code.replace("\r\n", "\n");
    let want = golden.replace("\r\n", "\n");
    assert_eq!(
        got, want,
        "generated server code drifted from golden file; re-bless with `cargo test -p linkrpc --test codegen_bless -- --ignored`"
    );
}

#[test]
fn output_is_deterministic() {
    let a = generate().code;
    let b = generate().code;
    assert_eq!(a, b, "generator must be deterministic across runs");
}

#[test]
fn no_unsupported_constructs_for_this_schema() {
    let generated = generate();
    assert!(
        generated.unsupported.is_empty(),
        "unexpected unsupported constructs: {:#?}",
        generated.unsupported
    );
}

#[test]
fn recursion_uses_box_indirection() {
    let code = generate().code;
    // Direct self / mutual recursion is broken with Box.
    assert!(
        code.contains("pub parent: Option<Box<TreeNode>>"),
        "self-recursive field should be boxed"
    );
    assert!(
        code.contains("pub pong: Option<Box<Pong>>"),
        "mutually recursive field should be boxed"
    );
    assert!(
        code.contains("pub ping: Option<Box<Ping>>"),
        "mutually recursive field should be boxed"
    );
    // Recursion behind Vec/Map must NOT be boxed (heap indirection already).
    assert!(
        code.contains("Variant3(Vec<JsonNode>)"),
        "vec recursion should not be boxed"
    );
    assert!(
        code.contains("Variant4(std::collections::HashMap<String, JsonNode>)"),
        "map recursion should not be boxed"
    );
}

#[test]
fn components_emit_in_sorted_order() {
    let code = generate().code;
    let pos = |needle: &str| {
        code.find(needle)
            .unwrap_or_else(|| panic!("missing {needle}"))
    };
    // BTreeMap ordering: Bag < Color < JsonNode < ... < TreeNode.
    assert!(pos("pub struct Bag") < pos("pub enum Color"));
    assert!(pos("pub enum Color") < pos("pub enum JsonNode"));
    assert!(pos("pub enum JsonNode") < pos("pub struct TreeNode"));
}

#[test]
fn server_notification_emits_no_client_send_method() {
    let code = generate().code;
    assert!(code.contains("generate_server = false"));
    assert!(code.contains("#[name(\"tree_changed\")]\n    #[server_notification]"));
    assert!(code.contains("async fn get_tree(#[params]"));
    assert!(code.contains("#[name(\"notify_changed\")]\n    #[notification]"));
}

#[test]
fn extensions_are_preserved_in_the_embedded_contract() {
    let code = generate().code;
    let embedded = code
        .lines()
        .find(|line| line.trim_start().starts_with("schema_json = "))
        .unwrap();
    assert!(embedded.contains("x-safety"));
    assert!(embedded.contains("identity-neutral codegen hint"));
    assert_eq!(code.matches("x-safety").count(), 1);
}

#[test]
fn struct_constructors_are_generated_for_named_objects() {
    let code = generate().code;

    // A params object with required + optional fields: `new` takes only the
    // required field, in emitted field order, and defaults the optional one.
    assert!(
        code.contains("impl ConfigureParams {"),
        "expected an inherent impl for ConfigureParams:\n{code}"
    );
    assert!(
        code.contains("pub fn new(id: String) -> Self {"),
        "constructor should take only the required field:\n{code}"
    );
    assert!(
        code.contains(
            "Self {\n            id,\n            label: None,\n            payload: None,\n        }"
        ),
        "optional field should default to None:\n{code}"
    );

    // An empty params object still gets a niladic `new()`.
    assert!(code.contains("pub struct ResetParams {}"));
    assert!(
        code.contains("impl ResetParams {")
            && code.contains("pub fn new() -> Self {\n        Self {}\n    }"),
        "empty struct should get a niladic constructor returning `Self {{}}`:\n{code}"
    );

    // An open object (required field + `#[serde(flatten)]` extra map): the
    // extra map is not a constructor parameter and defaults instead.
    assert!(code.contains("impl Bag {"));
    assert!(code.contains("pub fn new(id: String) -> Self {"));
    assert!(
        code.contains("id,\n            extra: Default::default(),"),
        "flattened extra map should default rather than being a parameter:\n{code}"
    );

    // Every generated struct constructor is a distinct inherent impl (no
    // duplicate `impl X {` blocks for the same type).
    let mut impl_headers: Vec<&str> = code
        .lines()
        .filter(|l| l.starts_with("impl ") && l.ends_with(" {"))
        .collect();
    let before = impl_headers.len();
    impl_headers.sort();
    impl_headers.dedup();
    assert_eq!(
        before,
        impl_headers.len(),
        "no two structs should emit the same inherent impl header"
    );
}

#[test]
fn struct_ctor_skipped_on_field_name_collision() {
    // Two distinct wire property names ("fooBar", "foo_bar") sanitize to the
    // same Rust identifier. The struct itself is unrepresentable, so no `new`
    // constructor should be emitted for it (rather than emitting broken code).
    let s = schema(
        r##"{
            "id": "x", "hash": "", "methods": {},
            "components": { "schemas": {
                "Collide": {
                    "type": "object",
                    "properties": {
                        "fooBar": { "type": "string" },
                        "foo_bar": { "type": "string" }
                    },
                    "required": ["fooBar", "foo_bar"],
                    "additionalProperties": false
                }
            }}
        }"##,
    );
    let g = generate_rust_interface(&s, &GenerateRustOptions::default());
    assert!(g.code.contains("pub struct Collide {"));
    assert!(
        !g.code.contains("impl Collide {"),
        "no constructor should be generated when fields collide on the same Rust name:\n{}",
        g.code
    );
}

#[test]
fn typed_error_output_matches_fixture() {
    let text = std::fs::read_to_string(codegen_dir().join("typed_errors_interface.json")).unwrap();
    let schema: LinkRpcInterfaceSchema = serde_json::from_str(&text).unwrap();
    let generated = generate_rust_interface(
        &schema,
        &GenerateRustOptions {
            generate_server: true,
            ..GenerateRustOptions::default()
        },
    );
    let golden = std::fs::read_to_string(codegen_dir().join("generated_typed_errors.rs")).unwrap();
    assert_eq!(
        generated.code.replace("\r\n", "\n"),
        golden.replace("\r\n", "\n")
    );
}

#[test]
fn legacy_helper_names_reserve_later_named_wire_types() {
    let schema = schema(
        r#"{
        "id": "colliding.errors", "hash": "", "methods": {
            "check": { "params": true, "result": true, "errors": [
                { "code": 2001, "message": "Legacy" },
                { "code": 2001, "type": "Code2001", "message": "Named" }
            ] }
        }
    }"#,
    );
    schema.validate().unwrap();
    let code = generate_rust_interface(&schema, &GenerateRustOptions::default()).code;
    assert!(code.contains("#[rpc_error(code = 2001, message = \"Legacy\", name = \"Code20012\")]"));
    assert!(code.contains("#[rpc_error(code = 2001, message = \"Named\", name = \"Code2001\")]"));
}

#[test]
fn invalid_error_contracts_are_rejected() {
    for (method, expected) in [
        (
            r#""bad":{"params":true,"result":true,"errors":[{"code":1,"type":"","message":"a"}]}"#,
            "error type must not be empty",
        ),
        (
            r#""bad":{"params":true,"result":true,"errors":[{"code":1,"type":"Busy","message":"a"},{"code":2,"type":"Busy","message":"b"}]}"#,
            "duplicate error type `Busy`",
        ),
        (
            r#""bad":{"params":true,"result":true,"errors":[{"code":7,"message":"a"},{"code":7,"message":"b"}]}"#,
            "duplicate error code 7",
        ),
        (
            r#""bad":{"params":true,"result":true,"errors":[{"code":-32600,"message":"reserved"}]}"#,
            "error code -32600 is protocol-reserved",
        ),
        (
            r#""bad":{"params":true,"result":true,"errors":[{"code":-32800,"message":"cancelled"}]}"#,
            "error code -32800 is protocol-reserved",
        ),
        (
            r#""bad":{"params":true,"errors":[{"code":7,"message":"notification"}]}"#,
            "notification `bad` must not declare errors",
        ),
    ] {
        let schema = schema(&format!(
            r#"{{"id":"invalid","hash":"","methods":{{{method}}}}}"#
        ));
        let error = schema.validate().unwrap_err().to_string();
        assert!(error.contains(expected), "{error:?}");
        let generated = generate_rust_interface(&schema, &GenerateRustOptions::default());
        assert!(generated.code.contains("compile_error!"));
    }
}

#[test]
fn nullable_option_lowering_is_scoped_to_error_payloads() {
    let schema = schema(
        r#"{
            "id": "legacy.nullable", "hash": "",
            "methods": {
                "get": {
                    "params": true,
                    "result": { "anyOf": [{ "type": "string" }, { "type": "null" }] }
                }
            }
        }"#,
    );
    let code = generate_rust_interface(&schema, &GenerateRustOptions::default()).code;
    assert!(
        code.contains("pub enum GetResult"),
        "ordinary nullable result must retain historical union lowering:\n{code}"
    );
    assert!(
        !code.contains("Result<Option<String>,"),
        "error-only nullable lowering must not alter ordinary result APIs:\n{code}"
    );
}

#[test]
fn generated_errors_reuse_the_schema_preserving_derive() {
    let schema = schema(
        r#"{
            "id": "errors.outgoing", "hash": "",
            "methods": {
                "check": {
                    "params": true,
                    "result": true,
                    "errors": [{
                        "code": 9001,
                        "message": "Number",
                        "data": { "type": "number" }
                    }]
                }
            }
        }"#,
    );
    let code = generate_rust_interface(&schema, &GenerateRustOptions::default()).code;
    assert!(code.contains("#[derive(Clone, Debug, linkrpc::prelude::ApplicationError)]"));
    assert!(code.contains("#[rpc_error(schema = __linkrpc_interface::schema, method = \"check\""));
    assert!(code.contains("#[rpc_error(code = 9001, message = \"Number\")]"));
    assert!(!code.contains("fn into_rpc_error"));
    assert!(!code.contains("fn try_from_rpc_error"));
}
