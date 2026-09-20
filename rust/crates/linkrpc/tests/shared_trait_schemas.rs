//! Black-box coverage of the trait exporter, independent of component naming details.

#![allow(dead_code)]

use linkrpc::prelude::*;
use linkrpc::schema::{
    compute_interface_hash, generate_rust_interface, schemars_to_subset, GenerateRustOptions,
    InterfaceSchemaCollector, LinkRpcInterfaceSchema, SchemarsSubsetError,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;

/// A target's display metadata.
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Metadata {
    pub title: String,
    pub format: String,
    pub definitions: bool,
}

/// A snapshot shared by requests, results, and notifications.
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Snapshot {
    /// The current display metadata.
    pub current: Metadata,
    pub history: Vec<Metadata>,
    pub previous: Option<Metadata>,
}

#[link_rpc_interface(id = "test.shared")]
pub trait Shared {
    async fn replace(#[params] snapshot: Snapshot) -> Result<Snapshot, JsonRpcError>;
    async fn inspect(snapshot: Snapshot) -> Result<Metadata, JsonRpcError>;
    #[notification]
    async fn changed(#[params] snapshot: Snapshot);
}

#[link_rpc_interface(id = "test.shared")]
pub trait RenamedShared {
    #[notification]
    async fn changed(#[params] snapshot: Snapshot);
    async fn inspect(snapshot: Snapshot) -> Result<Metadata, JsonRpcError>;
    async fn replace(#[params] snapshot: Snapshot) -> Result<Snapshot, JsonRpcError>;
}

mod first {
    use super::*;

    /// The first contract, even though the shape is shared.
    #[derive(Serialize, Deserialize, JsonSchema)]
    pub struct Contract {
        pub value: String,
    }
}

mod second {
    use super::*;

    /// A different contract with the same Rust schema name and shape.
    #[derive(Serialize, Deserialize, JsonSchema)]
    pub struct Contract {
        pub value: String,
    }
}

mod third {
    use super::*;

    #[derive(Serialize, Deserialize, JsonSchema)]
    pub struct Contract {
        pub value: bool,
    }
}

#[link_rpc_interface(id = "test.collision")]
pub trait Forward {
    async fn first(#[params] params: first::Contract) -> Result<second::Contract, JsonRpcError>;
    async fn second(#[params] params: third::Contract) -> Result<first::Contract, JsonRpcError>;
}

#[link_rpc_interface(id = "test.collision")]
pub trait Reverse {
    async fn second(#[params] params: third::Contract) -> Result<first::Contract, JsonRpcError>;
    async fn first(#[params] params: first::Contract) -> Result<second::Contract, JsonRpcError>;
}

/// A recursive tree node.
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Node {
    pub title: String,
    pub children: Vec<Node>,
    pub parent: Option<Box<Node>>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Left {
    pub rights: Vec<Right>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Right {
    pub left: Option<Box<Left>>,
}

#[link_rpc_interface(id = "test.recursive")]
pub trait Recursive {
    async fn tree(#[params] node: Node) -> Result<Node, JsonRpcError>;
    async fn mutual(#[params] left: Left) -> Result<Right, JsonRpcError>;
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "Path~/Value_{T}")]
pub struct Escaped<T> {
    pub value: T,
}

#[link_rpc_interface(id = "test.generic-names")]
pub trait GenericNames {
    async fn strings(#[params] params: Escaped<String>) -> Result<Escaped<String>, JsonRpcError>;
    async fn booleans(#[params] params: Escaped<bool>) -> Result<Escaped<bool>, JsonRpcError>;
}

#[link_rpc_interface(id = "test.primitive")]
pub trait Primitive {
    async fn echo(value: String) -> Result<String, JsonRpcError>;
}

#[link_rpc_interface(id = "test.identity-alias")]
pub trait IdentityAlias {
    async fn unbox(#[params] snapshot: Box<Snapshot>) -> Result<Snapshot, JsonRpcError>;
    async fn box_it(#[params] snapshot: Snapshot) -> Result<Box<Snapshot>, JsonRpcError>;
}

fn target<'a>(schema: &'a Value, node: &'a Value) -> &'a Value {
    match node.get("$ref").and_then(Value::as_str) {
        Some(reference) => {
            assert!(
                reference.starts_with("#/components/schemas/"),
                "{reference}"
            );
            schema.pointer(&reference[1..]).expect("reference resolves")
        }
        None => node,
    }
}

fn assert_closed(schema: &Value) {
    fn visit(root: &Value, node: &Value, used: &mut BTreeSet<String>) {
        match node {
            Value::Object(object) => {
                if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                    assert!(
                        reference.starts_with("#/components/schemas/"),
                        "{reference}"
                    );
                    assert!(root.pointer(&reference[1..]).is_some(), "{reference}");
                    used.insert(reference.to_owned());
                }
                for value in object.values() {
                    visit(root, value, used);
                }
            }
            Value::Array(array) => {
                for value in array {
                    visit(root, value, used);
                }
            }
            _ => {}
        }
    }
    let mut used = BTreeSet::new();
    visit(schema, schema, &mut used);
    assert!(!used.is_empty());
    let components = schema["components"]["schemas"].as_object().unwrap();
    for name in components.keys() {
        let escaped = name.replace('~', "~0").replace('/', "~1");
        assert!(
            used.contains(&format!("#/components/schemas/{escaped}")),
            "unused component {name}"
        );
    }
}

fn document(schema: LinkRpcInterfaceSchema) -> Value {
    assert_eq!(schema.hash, compute_interface_hash(&schema));
    let value = serde_json::to_value(schema).unwrap();
    assert_closed(&value);
    value
}

#[test]
fn shares_types_across_methods_params_results_and_notifications() {
    let definition = shared::interface();
    let schema = document(definition.to_schema());
    let replace = &schema["methods"]["replace"];
    assert!(replace["params"].get("$ref").is_some());
    assert_eq!(replace["params"], replace["result"]);
    assert_eq!(replace["params"], schema["methods"]["changed"]["params"]);

    let snapshot = target(&schema, &replace["params"]);
    let inspect = target(&schema, &schema["methods"]["inspect"]["params"]);
    assert_eq!(inspect["properties"]["snapshot"], replace["params"]);
    assert_eq!(
        snapshot["properties"]["history"]["items"],
        schema["methods"]["inspect"]["result"]
    );
    assert_eq!(
        snapshot["description"],
        "A snapshot shared by requests, results, and notifications."
    );
    assert_eq!(
        snapshot["properties"]["current"]["description"],
        "The current display metadata."
    );
    assert_eq!(
        snapshot["properties"]["current"]["$ref"],
        schema["methods"]["inspect"]["result"]["$ref"]
    );
    assert!(snapshot["properties"]["current"]["$ref"].is_string());

    let metadata = target(&schema, &schema["methods"]["inspect"]["result"]);
    assert_eq!(metadata["description"], "A target's display metadata.");
    assert_eq!(
        metadata["properties"],
        json!({
            "title": { "type": "string" },
            "format": { "type": "string" },
            "definitions": { "type": "boolean" }
        })
    );
    assert_eq!(
        metadata["required"],
        json!(["definitions", "format", "title"])
    );
    assert_eq!(
        metadata,
        &schemars_to_subset(&serde_json::to_value(schemars::schema_for!(Metadata)).unwrap())
            .unwrap()
    );
    assert_eq!(
        schema,
        serde_json::to_value(definition.to_schema()).unwrap()
    );
    assert_eq!(
        schema,
        serde_json::to_value(shared::interface().to_schema()).unwrap()
    );
    assert_eq!(schema, document(renamed_shared::interface().to_schema()));
}

#[test]
fn colliding_names_keep_distinct_contracts_and_are_traversal_order_independent() {
    let schema = document(forward::interface().to_schema());
    assert_eq!(schema, document(reverse::interface().to_schema()));
    let first = &schema["methods"]["first"];
    let second = &schema["methods"]["second"];
    assert_ne!(first["params"], first["result"]);
    assert_ne!(first["params"], second["params"]);
    assert_eq!(first["params"], second["result"]);
    assert_eq!(
        target(&schema, &first["params"])["description"],
        "The first contract, even though the shape is shared."
    );
    assert_eq!(
        target(&schema, &first["result"])["description"],
        "A different contract with the same Rust schema name and shape."
    );
    assert_eq!(
        target(&schema, &second["params"])["properties"]["value"]["type"],
        "boolean"
    );
}

#[test]
fn exports_self_and_mutual_recursion_without_expansion() {
    let schema = document(recursive::interface().to_schema());
    let tree = &schema["methods"]["tree"];
    assert_eq!(tree["params"], tree["result"]);
    let node = target(&schema, &tree["params"]);
    assert_eq!(node["properties"]["children"]["items"], tree["params"]);
    let serialized = serde_json::to_string(&schema).unwrap();
    assert!(serialized.len() < 8_000);
    assert_eq!(schema, document(recursive::interface().to_schema()));
}

#[test]
fn generic_schema_name_collisions_and_pointer_characters_resolve() {
    let schema = document(generic_names::interface().to_schema());
    let strings = &schema["methods"]["strings"];
    let booleans = &schema["methods"]["booleans"];
    assert_ne!(strings["params"], booleans["params"]);
    assert_eq!(strings["params"], strings["result"]);
    assert_eq!(booleans["params"], booleans["result"]);
    assert_eq!(
        target(&schema, &strings["params"])["properties"]["value"]["type"],
        "string"
    );
    assert_eq!(
        target(&schema, &booleans["params"])["properties"]["value"]["type"],
        "boolean"
    );
}

#[test]
fn existing_rust_generator_accepts_shared_recursive_and_colliding_schemas() {
    for schema in [
        shared::interface().to_schema(),
        recursive::interface().to_schema(),
        forward::interface().to_schema(),
        generic_names::interface().to_schema(),
    ] {
        let options = GenerateRustOptions {
            generate_server: true,
            ..GenerateRustOptions::default()
        };
        let generated = generate_rust_interface(&schema, &options);
        assert!(
            generated.unsupported.is_empty(),
            "{}: {:?}",
            schema.id,
            generated.unsupported
        );
        assert_eq!(
            generated.code,
            generate_rust_interface(&schema, &options).code
        );
    }
}

#[test]
fn primitive_only_interface_keeps_the_inline_contract() {
    let schema = primitive::interface().to_schema();
    assert!(schema.components.is_none());
    let expected: LinkRpcInterfaceSchema = serde_json::from_value(json!({
        "id": "test.primitive",
        "hash": "",
        "methods": {
            "echo": {
                "params": {
                    "type": "object",
                    "properties": { "value": { "type": "string" } },
                    "required": ["value"],
                    "additionalProperties": false
                },
                "result": { "type": "string" }
            }
        }
    }))
    .unwrap();
    assert_eq!(schema.hash, compute_interface_hash(&expected));
    assert_eq!(schema.methods, expected.methods);
}

#[test]
fn boxed_and_unboxed_roots_share_their_schemars_identity() {
    let schema = document(identity_alias::interface().to_schema());
    let unbox = &schema["methods"]["unbox"];
    let box_it = &schema["methods"]["box_it"];
    assert_eq!(unbox["params"], unbox["result"]);
    assert_eq!(unbox["params"], box_it["params"]);
    assert_eq!(unbox["params"], box_it["result"]);
}

#[test]
fn collector_keeps_only_the_referenced_transitive_closure() {
    let mut collector = InterfaceSchemaCollector::new();
    collector.register::<Snapshot>().unwrap();
    collector.register::<Node>().unwrap();
    collector.initialize().unwrap();
    let root = collector.root_schema::<Snapshot>().unwrap();
    let components = collector.components().unwrap().unwrap();
    let schemas = components.schemas.unwrap();
    assert_eq!(schemas.len(), 2);
    assert!(schemas
        .values()
        .all(|schema| schema["description"] != "A recursive tree node."));
    let value = json!({
        "methods": { "get": { "params": root } },
        "components": { "schemas": schemas }
    });
    assert_closed(&value);
}

struct ExternalReference;

impl JsonSchema for ExternalReference {
    fn schema_name() -> String {
        "ExternalReference".into()
    }

    fn json_schema(_: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
        schemars::schema::Schema::new_ref("https://example.invalid/schema.json".into())
    }
}

#[test]
fn collector_rejects_unresolvable_component_references() {
    let mut collector = InterfaceSchemaCollector::new();
    collector.register::<ExternalReference>().unwrap();
    collector.initialize().unwrap();
    collector.root_schema::<ExternalReference>().unwrap();
    assert!(matches!(
        collector.components(),
        Err(SchemarsSubsetError::UnresolvedRef(_))
    ));
}

struct LiteralMetadata;

fn literal_metadata() -> Value {
    json!({
        "title": "payload title",
        "format": "payload format",
        "definitions": { "literal": true },
        "$ref": "not a schema reference"
    })
}

impl JsonSchema for LiteralMetadata {
    fn schema_name() -> String {
        "LiteralMetadata".into()
    }

    fn json_schema(_: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
        serde_json::from_value(json!({ "enum": [literal_metadata()] })).unwrap()
    }
}

#[test]
fn schema_looking_literal_values_are_not_rewritten_or_followed() {
    let mut collector = InterfaceSchemaCollector::new();
    collector.register::<LiteralMetadata>().unwrap();
    collector.initialize().unwrap();
    let root = collector.root_schema::<LiteralMetadata>().unwrap();
    let components = collector.components().unwrap().unwrap();
    let schema = json!({ "components": components });
    assert_eq!(target(&schema, &root)["const"], literal_metadata());
}

struct RecursiveService;

#[async_trait::async_trait]
impl Recursive for RecursiveService {
    async fn tree(&self, _ctx: &CallCtx, node: Node) -> Result<Node, JsonRpcError> {
        Ok(node)
    }

    async fn mutual(&self, _ctx: &CallCtx, left: Left) -> Result<Right, JsonRpcError> {
        Ok(Right {
            left: Some(Box::new(left)),
        })
    }
}

#[tokio::test]
async fn recursive_trait_client_and_server_register_and_exchange_typed_values() {
    let (a, b) = transport_pair();
    let caller = LinkRpcConnection::new(Box::new(a));
    let server = LinkRpcConnection::new(Box::new(b));
    server
        .register_service(
            Arc::new(RecursiveServer::new(Arc::new(RecursiveService))),
            RegisterOptions::default(),
        )
        .unwrap();
    let client = RecursiveClient::new(caller.clone());
    let caller_task = tokio::spawn(async move { caller.run().await });
    let server_task = tokio::spawn(async move { server.run().await });
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let tree = client
            .tree(Node {
                title: "root".into(),
                children: vec![Node {
                    title: "child".into(),
                    children: vec![],
                    parent: None,
                }],
                parent: None,
            })
            .await
            .unwrap();
        assert_eq!(tree.children[0].title, "child");
        let right = client
            .mutual(Left {
                rights: vec![Right { left: None }],
            })
            .await
            .unwrap();
        assert!(right.left.unwrap().rights[0].left.is_none());
    })
    .await;
    caller_task.abort();
    server_task.abort();
    result.expect("recursive calls finish");
}
