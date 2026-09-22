#[path = "codegen/generated_inline.rs"]
mod generated;

use generated::*;
use linkrpc::prelude::{CallCtx, InterfaceHandler, JsonRpcError, RpcCall};
use linkrpc::schema::codegen::{generate_rust_interface, GenerateRustOptions};
use linkrpc::schema::LinkRpcInterfaceSchema;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn fixture() -> LinkRpcInterfaceSchema {
    serde_json::from_str(include_str!("codegen/inline_interface.json")).unwrap()
}

#[test]
fn default_inlining_and_opt_out() {
    let schema = fixture();
    let generated = generate_rust_interface(
        &schema,
        &GenerateRustOptions {
            generate_server: true,
            ..Default::default()
        },
    );
    assert_eq!(generated.code, include_str!("codegen/generated_inline.rs"));
    assert!(generated.code.contains("async fn empty()"));
    assert!(generated.code.contains("async fn disable()"));
    assert!(!generated.code.contains("#[params(EmptyParams)]"));
    assert!(!generated.code.contains("#[params(EmptyPayload)]"));
    assert!(!generated.code.contains("#[params("));
    assert!(generated.code.contains(
        "async fn send(\n        #[serde(rename = \"camelCase\")] camel_case: String,\n        #[serde(default, skip_serializing_if = \"Option::is_none\")] optional: Option<bool>,\n        #[serde(default, skip_serializing_if = \"Option::is_none\")] payload: Option<serde_json::Value>,\n        r#type: String,\n        #[serde(rename = \"wire-key\")] wire_key: i64,\n    )"
    ));
    let legacy = generate_rust_interface(
        &schema,
        &GenerateRustOptions {
            inline_params: false,
            ..Default::default()
        },
    );
    assert!(legacy
        .code
        .contains("async fn empty(#[params] params: EmptyParams)"));
    assert!(legacy
        .code
        .contains("async fn send(#[params] params: SendParams)"));
    assert!(!legacy.code.contains("#[params(SendParams)]"));
    assert!(legacy
        .code
        .contains("async fn disable(#[params] params: EmptyPayload)"));
}

#[test]
fn shared_empty_params_need_no_type_annotation() {
    let generated = generate_rust_interface(
        &fixture(),
        &GenerateRustOptions {
            external_components: [("EmptyPayload".into(), "shared::EmptyPayload".into())].into(),
            ..Default::default()
        },
    );
    assert!(generated.code.contains("async fn disable()"));
    assert!(!generated.code.contains("#[params(shared::EmptyPayload)]"));
}

#[test]
fn unsupported_parameter_shapes_keep_whole_object_arguments() {
    for params in [
        json!(true),
        json!({"type": "string"}),
        json!({"type": "array", "items": {"type": "string"}}),
        json!({"type": "object", "additionalProperties": {"type": "string"}}),
        json!({"type": "object", "properties": {"id": {"type": "string"}}, "additionalProperties": true}),
        json!({"oneOf": [{"type": "string"}, {"type": "integer"}]}),
        json!({"$ref": "#/components/schemas/External"}),
    ]
    .into_iter()
    .chain(["ctx", "stream_receiver", "stream_sender"].map(|name| {
        json!({"type": "object", "properties": {name: {"type": "string"}}, "additionalProperties": false})
    })) {
        let schema = serde_json::from_value(json!({
            "id": "fallback",
            "hash": "",
            "methods": {"send": {"params": params, "result": true}},
            "components": {"schemas": {"External": {
                "type": "object",
                "properties": {"nested": {"enum": ["one", "two"]}},
                "additionalProperties": false
            }}}
        }))
        .unwrap();
        let generated = generate_rust_interface(
            &schema,
            &GenerateRustOptions {
                external_components: [("External".into(), "external::Params".into())].into(),
                ..Default::default()
            },
        );
        assert!(generated.code.contains("async fn send(#[params] params:"), "{}", generated.code);
    }
}

#[test]
fn shared_params_use_mapped_types_and_preserve_recursive_boxing() {
    let schema = serde_json::from_value(json!({
        "id": "shared", "hash": "",
        "methods": {"send": {
            "params": {"$ref": "#/components/schemas/Node"},
            "result": true
        }},
        "components": {"schemas": {
            "Node": {
                "type": "object",
                "properties": {
                    "next": {"$ref": "#/components/schemas/Node"},
                    "value": {"$ref": "#/components/schemas/Value"}
                },
                "required": ["value"],
                "additionalProperties": false
            },
            "Value": {"type": "string"}
        }}
    }))
    .unwrap();
    let generated = generate_rust_interface(
        &schema,
        &GenerateRustOptions {
            external_components: [
                ("Node".into(), "shared::RenamedNode".into()),
                ("Value".into(), "shared::RenamedValue".into()),
            ]
            .into(),
            ..Default::default()
        },
    );
    assert!(generated.unsupported.is_empty());
    assert!(!generated.code.contains("pub struct"));
    assert!(!generated.code.contains("#[params(shared::RenamedNode)]"));
    assert!(generated.code.contains(
        "async fn send(\n        #[serde(default, skip_serializing_if = \"Option::is_none\")] next: Option<Box<shared::RenamedNode>>,\n        value: shared::RenamedValue,\n    )"
    ));
}

struct Echo;

#[async_trait::async_trait]
impl InlineService for Echo {
    async fn disable(&self, _ctx: &CallCtx) -> Result<Value, JsonRpcError> {
        Ok(json!({}))
    }

    async fn send(
        &self,
        _ctx: &CallCtx,
        camel_case: String,
        optional: Option<bool>,
        payload: Option<Value>,
        r#type: String,
        wire_key: i64,
    ) -> Result<Value, JsonRpcError> {
        Ok(serde_json::to_value(SendParams {
            camel_case,
            optional,
            payload,
            r#type,
            wire_key,
        })
        .unwrap())
    }

    async fn empty(&self, _ctx: &CallCtx) -> Result<(), JsonRpcError> {
        Ok(())
    }
}

struct Loopback {
    server: InlineServer<Echo>,
    sent: Arc<Mutex<Vec<Value>>>,
}

#[async_trait::async_trait]
impl RpcCall for Loopback {
    async fn call(&self, method: &str, params: Value) -> Result<Value, JsonRpcError> {
        self.sent.lock().unwrap().push(params.clone());
        self.server
            .handle_request(
                method.strip_prefix("inline::").unwrap(),
                params,
                CallCtx::default(),
            )
            .await
    }

    async fn notify(&self, _method: &str, params: Value) -> Result<(), JsonRpcError> {
        self.sent.lock().unwrap().push(params.clone());
        assert!(self.server.dispatch_notification("empty", params).await?);
        Ok(())
    }
}

#[tokio::test]
async fn inline_arguments_preserve_wire_encoding_and_server_decoding() {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let client = InlineClient::new(Loopback {
        server: InlineServer::new(Arc::new(Echo)),
        sent: sent.clone(),
    });
    let without_optional = client
        .send("value".into(), None, None, "kind".into(), 42)
        .await
        .unwrap();
    assert_eq!(
        without_optional,
        json!({"camelCase": "value", "type": "kind", "wire-key": 42})
    );
    let with_optional = client
        .send(
            "value".into(),
            Some(false),
            Some(json!({"nested": true})),
            "kind".into(),
            42,
        )
        .await
        .unwrap();
    assert_eq!(
        with_optional,
        json!({
            "camelCase": "value", "optional": false, "payload": {"nested": true},
            "type": "kind", "wire-key": 42
        })
    );
    let null_payload = client
        .send("value".into(), None, Some(Value::Null), "kind".into(), 42)
        .await
        .unwrap();
    assert_eq!(null_payload, without_optional);
    assert_eq!(client.disable().await.unwrap(), json!({}));
    client.empty().await.unwrap();
    assert_eq!(
        *sent.lock().unwrap(),
        vec![
            without_optional,
            with_optional,
            json!({"camelCase": "value", "payload": null, "type": "kind", "wire-key": 42}),
            json!({}),
            json!({})
        ]
    );
    let server = InlineServer::new(Arc::new(Echo));
    assert_eq!(
        server
            .handle_request(
                "send",
                json!({"camelCase": "missing required fields"}),
                CallCtx::default()
            )
            .await
            .unwrap_err()
            .code,
        linkrpc::prelude::error_codes::INVALID_PARAMS
    );
    assert_eq!(interface().to_schema().methods, fixture().methods);
}
