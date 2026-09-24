use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use linkrpc::prelude::*;
use serde_json::{json, Value};

fn interface(id: &str, requests: &[&str], notifications: &[&str]) -> Arc<InterfaceDefinition> {
    let mut members = Vec::new();
    for name in requests {
        members.push((
            (*name).to_string(),
            Member::Request(Box::new(RequestMember {
                params_schema: json!({ "type": "object" }),
                result_schema: json!({}),
                client_stream_schema: None,
                server_stream_schema: None,
                errors: None,
                error_components: None,
                docs: MemberDocs::default(),
            })),
        ));
    }
    for name in notifications {
        members.push((
            (*name).to_string(),
            Member::Notification(NotificationMember {
                params_schema: json!({ "type": "object" }),
                docs: MemberDocs::default(),
            }),
        ));
    }
    Arc::new(InterfaceDefinition::new(InterfaceInfo::new(id), members))
}

struct RecordingHandler {
    interface_id: String,
    service_id: Option<String>,
    notifications: Arc<Mutex<Vec<(String, JsonValue)>>>,
}

#[async_trait]
impl InterfaceHandler for RecordingHandler {
    async fn handle_request(
        &self,
        member: &str,
        params: JsonValue,
        _ctx: CallCtx,
    ) -> Result<JsonValue, JsonRpcError> {
        let mut result = json!({
            "interfaceId": self.interface_id,
            "member": member,
            "params": params,
        });
        if let Some(service_id) = &self.service_id {
            result["serviceId"] = json!(service_id);
        }
        Ok(result)
    }

    async fn handle_notification(&self, member: &str, params: JsonValue, _ctx: CallCtx) {
        self.notifications
            .lock()
            .unwrap()
            .push((member.to_string(), params));
    }
}

fn register(
    connection: &LinkRpcConnection,
    iface: Arc<InterfaceDefinition>,
    service_id: Option<&str>,
    notifications: Arc<Mutex<Vec<(String, JsonValue)>>>,
) {
    let interface_id = iface.id().to_string();
    let service_id = service_id.map(str::to_string);
    connection
        .register(
            iface,
            Arc::new(RecordingHandler {
                interface_id,
                service_id: service_id.clone(),
                notifications,
            }),
            RegisterOptions {
                service_id,
                ..Default::default()
            },
        )
        .unwrap();
}

fn register_bare(
    connection: &LinkRpcConnection,
    iface: Arc<InterfaceDefinition>,
    service_id: Option<&str>,
    bare_prefix: &str,
    notifications: Arc<Mutex<Vec<(String, JsonValue)>>>,
) -> linkrpc::prelude::InterfaceRegistration {
    let interface_id = iface.id().to_string();
    let service_id = service_id.map(str::to_string);
    connection
        .register(
            iface,
            Arc::new(RecordingHandler {
                interface_id,
                service_id: service_id.clone(),
                notifications,
            }),
            RegisterOptions {
                service_id,
                bare_prefix: Some(bare_prefix.to_string()),
                ..Default::default()
            },
        )
        .unwrap()
}

fn connected_pair() -> (LinkRpcConnection, LinkRpcConnection) {
    let (a, b) = transport_pair();
    let caller = LinkRpcConnection::new(Box::new(a));
    let provider = LinkRpcConnection::new(Box::new(b));
    let caller_task = caller.clone();
    let provider_task = provider.clone();
    tokio::spawn(async move { caller_task.run().await });
    tokio::spawn(async move { provider_task.run().await });
    (caller, provider)
}

fn bare_binding_vectors() -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("conformance")
        .join("vectors")
        .join("bare_bindings.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("bare binding vectors parse")
}

fn reflection_defaults_vector() -> Value {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("conformance")
        .join("vectors")
        .join("reflection_defaults.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("reflection defaults vector parses")
}

#[test]
fn reflection_defaults_schema_and_hash_match_shared_fixture() {
    let expected = reflection_defaults_vector();
    let iface = linkrpc::connection::reflection::defaults_interface();
    let mut actual = serde_json::to_value(iface.to_schema()).unwrap();
    actual.as_object_mut().unwrap().remove("hash");
    assert_eq!(actual, expected["schema"]);
    assert_eq!(iface.schema_hash(), expected["hash"].as_str().unwrap());
}

#[test]
fn builtin_reflection_contracts_keep_their_inline_schema_layout() {
    for interface in [
        linkrpc::connection::reflection::defaults_interface(),
        linkrpc::connection::reflection::directory_interface(),
        linkrpc::connection::reflection::schemas_interface(),
    ] {
        let schema = interface.to_schema();
        assert!(schema.components.is_none(), "{}", schema.id);
        for method in schema.methods.values() {
            assert!(method.params.get("$ref").is_none(), "{}", schema.id);
            assert!(
                method.result.as_ref().unwrap().get("$ref").is_none(),
                "{}",
                schema.id
            );
        }
    }
}

#[tokio::test]
async fn shared_conformance_vectors_match_runtime_routing() {
    let vectors = bare_binding_vectors();
    for case in vectors["cases"].as_array().unwrap() {
        let (caller, provider) = connected_pair();
        let notifications = Arc::new(Mutex::new(Vec::new()));
        for binding in case["bindings"].as_array().unwrap() {
            let prefix = binding["prefix"].as_str().unwrap();
            let interface_id = binding["interfaceId"].as_str().unwrap();
            let service_id = binding["serviceId"].as_str();
            let members: Vec<&str> = binding["members"]
                .as_array()
                .unwrap()
                .iter()
                .map(|member| member.as_str().unwrap())
                .collect();
            register_bare(
                &provider,
                interface(interface_id, &members, &[]),
                service_id,
                prefix,
                notifications.clone(),
            );
        }

        let result = caller
            .call(case["method"].as_str().unwrap(), json!({}))
            .await;
        let expected = &case["expected"];
        if expected["error"] == "methodNotFound" {
            let err = result.unwrap_err();
            assert_eq!(
                err.code,
                error_codes::METHOD_NOT_FOUND,
                "case {:?}",
                case["name"]
            );
        } else {
            let result = result.unwrap_or_else(|e| panic!("case {:?}: {e:?}", case["name"]));
            assert_eq!(result["interfaceId"], expected["interfaceId"]);
            assert_eq!(result["member"], expected["member"]);
            assert_eq!(result.get("serviceId"), expected.get("serviceId"));
        }
    }
}

#[tokio::test]
async fn cdp_and_lsp_prefixes_route_requests_and_notifications() {
    let (caller, provider) = connected_pair();
    let notifications = Arc::new(Mutex::new(Vec::new()));
    register_bare(
        &provider,
        interface("cdp.DOM", &["getDocument"], &[]),
        None,
        "DOM.",
        notifications.clone(),
    );
    register_bare(
        &provider,
        interface("cdp.Runtime", &["evaluate"], &[]),
        None,
        "Runtime.",
        notifications.clone(),
    );
    register_bare(
        &provider,
        interface("lsp.lifecycle", &["initialize"], &[]),
        None,
        "",
        notifications.clone(),
    );
    register_bare(
        &provider,
        interface("lsp.textDocument", &["hover"], &[]),
        None,
        "textDocument/",
        notifications.clone(),
    );
    register_bare(
        &provider,
        interface("lsp.protocol", &[], &["cancelRequest"]),
        None,
        "$/",
        notifications.clone(),
    );

    let runtime = caller
        .call("Runtime.evaluate", json!({ "x": 1 }))
        .await
        .unwrap();
    assert_eq!(runtime["interfaceId"], "cdp.Runtime");
    assert_eq!(runtime["member"], "evaluate");
    let hover = caller.call("textDocument/hover", json!({})).await.unwrap();
    assert_eq!(hover["interfaceId"], "lsp.textDocument");
    let initialize = caller.call("initialize", json!({})).await.unwrap();
    assert_eq!(initialize["interfaceId"], "lsp.lifecycle");

    caller
        .notify("$/cancelRequest", json!({ "id": 7 }))
        .await
        .unwrap();
    for _ in 0..50 {
        if !notifications.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert_eq!(notifications.lock().unwrap()[0].0, "cancelRequest");
}

#[tokio::test]
async fn longest_prefix_wins_without_member_fallback_and_addressed_calls_are_unchanged() {
    let (caller, provider) = connected_pair();
    let notifications = Arc::new(Mutex::new(Vec::new()));
    register_bare(
        &provider,
        interface("test.short", &["bc"], &[]),
        None,
        "a",
        notifications.clone(),
    );
    register_bare(
        &provider,
        interface("test.long", &["other"], &[]),
        Some("tools"),
        "ab",
        notifications,
    );

    let err = caller.call("abc", json!({})).await.unwrap_err();
    assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);
    let err = caller.call("ab", json!({})).await.unwrap_err();
    assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);
    let err = caller.call("unbound", json!({})).await.unwrap_err();
    assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);

    let short = caller
        .call("test.short::bc", json!({}))
        .await
        .expect("interface-addressed call");
    assert_eq!(short["interfaceId"], "test.short");
    let named = caller
        .call("tools::test.long::other", json!({}))
        .await
        .expect("service-addressed call");
    assert_eq!(named["interfaceId"], "test.long");
}

#[test]
fn invalid_and_duplicate_prefixes_roll_back_registration() {
    let (_a, b) = transport_pair();
    let provider = LinkRpcConnection::new(Box::new(b));
    let notifications = Arc::new(Mutex::new(Vec::new()));

    register_bare(
        &provider,
        interface("cdp.DOM", &["getDocument"], &[]),
        None,
        "DOM.",
        notifications,
    );
    let vectors = bare_binding_vectors();
    for (index, prefix) in vectors["invalidPrefixes"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let prefix = prefix.as_str().unwrap();
        let iface = interface(&format!("invalid.{index}"), &["run"], &[]);
        assert!(
            matches!(
                provider.register(
                    iface,
                    Arc::new(RecordingHandler {
                        interface_id: format!("invalid.{index}"),
                        service_id: None,
                        notifications: Arc::new(Mutex::new(Vec::new())),
                    }),
                    RegisterOptions {
                        bare_prefix: Some(prefix.to_string()),
                        ..Default::default()
                    },
                ),
                Err(ConnError::InvalidBarePrefix)
            ),
            "{prefix:?}"
        );
    }
    let duplicate = interface("duplicate", &["run"], &[]);
    assert!(matches!(
        provider.register(
            duplicate,
            Arc::new(RecordingHandler {
                interface_id: "duplicate".into(),
                service_id: Some("named".into()),
                notifications: Arc::new(Mutex::new(Vec::new())),
            }),
            RegisterOptions {
                service_id: Some("named".into()),
                bare_prefix: Some("DOM.".into()),
                ..Default::default()
            },
        ),
        Err(ConnError::BarePrefixAlreadyBound(prefix)) if prefix == "DOM."
    ));
    assert_eq!(provider.list_registered().len(), 1);
}

#[tokio::test]
async fn directory_lists_tags_of_each_implemented_interface() {
    let (caller, provider) = connected_pair();
    let tagged = Arc::new(InterfaceDefinition::new(
        InterfaceInfo::new("example.tagged").with_tags(["ui", "search", "ui"]),
        vec![],
    ));
    register(
        &provider,
        tagged.clone(),
        Some("service"),
        Arc::new(Mutex::new(vec![])),
    );
    let opaque_schema: linkrpc::schema::LinkRpcInterfaceSchema = serde_json::from_value(json!({
        "id": "example.opaque", "hash": "", "tags": ["explicit"], "methods": {},
        "x-interface-templates": {
            "templates": "unrecognized future format",
            "instances": [{ "template": "unrecognized" }],
            "tags": ["must-not-contribute"]
        }
    }))
    .unwrap();
    register(
        &provider,
        Arc::new(InterfaceDefinition::from_schema(opaque_schema.clone())),
        Some("service"),
        Arc::new(Mutex::new(vec![])),
    );
    provider.enable_reflection();
    let listed = caller
        .call("hubrpc.directory::list", json!({}))
        .await
        .unwrap();
    let row = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["interfaceId"] == "example.tagged")
        .unwrap();
    assert_eq!(row["tags"], json!(["search", "ui"]));
    assert_eq!(row["interfaceHash"], tagged.schema_hash());
    let opaque_row = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["interfaceId"] == "example.opaque")
        .unwrap();
    assert_eq!(opaque_row["tags"], json!(["explicit"]));
    let reflected = caller
        .call(
            "hubrpc.schemas::get",
            json!({ "interfaceId": "example.opaque" }),
        )
        .await
        .unwrap();
    assert_eq!(
        reflected["schema"]["x-interface-templates"],
        opaque_schema.extensions["x-interface-templates"]
    );
    assert_eq!(
        reflected["schema"]["tags"],
        json!(opaque_schema.tags.unwrap())
    );
    assert_eq!(
        provider
            .list_registered()
            .iter()
            .find(|row| row.interface_id == "example.tagged")
            .unwrap()
            .tags,
        Some(vec!["search".into(), "ui".into()])
    );
}

#[tokio::test]
async fn unregister_removes_routes_and_allows_reregistration() {
    let (caller, provider) = connected_pair();
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let lifecycle = interface("lsp.lifecycle", &["run"], &[]);
    let lifecycle_hash = lifecycle.schema_hash().to_string();
    let registration = register_bare(&provider, lifecycle, None, "", notifications.clone());
    let runtime = interface("cdp.Runtime", &["evaluate"], &[]);
    let runtime_hash = runtime.schema_hash().to_string();
    register_bare(
        &provider,
        runtime,
        Some("browser"),
        "Runtime.",
        notifications.clone(),
    );
    provider.enable_reflection();

    let routed = caller.call("run", json!({})).await.unwrap();
    assert_eq!(routed["interfaceId"], "lsp.lifecycle");

    let defaults = caller
        .call("hubrpc.defaults::get", json!({}))
        .await
        .unwrap();
    assert_eq!(defaults["interfaceId"], "lsp.lifecycle");
    assert_eq!(defaults["interfaceHash"], lifecycle_hash);

    let listed = caller
        .call("hubrpc.defaults::listBindings", json!({}))
        .await
        .unwrap();
    assert_eq!(
        listed["bindings"],
        json!([
            {
                "prefix": "",
                "interfaceId": "lsp.lifecycle",
                "interfaceHash": lifecycle_hash,
            },
            {
                "prefix": "Runtime.",
                "serviceId": "browser",
                "interfaceId": "cdp.Runtime",
                "interfaceHash": runtime_hash,
            }
        ])
    );

    assert!(registration.unregister());
    assert!(!registration.unregister());
    assert_eq!(
        caller.call("run", json!({})).await.unwrap_err().code,
        error_codes::METHOD_NOT_FOUND
    );
    let replacement = register_bare(
        &provider,
        interface("lsp.lifecycle", &["run"], &[]),
        None,
        "",
        notifications,
    );
    assert_eq!(
        caller.call("run", json!({})).await.unwrap()["interfaceId"],
        "lsp.lifecycle"
    );
    assert!(replacement.unregister());
}

#[tokio::test]
async fn defaults_get_only_reports_the_empty_prefix_binding() {
    let (caller, provider) = connected_pair();
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let runtime = interface("cdp.Runtime", &["evaluate"], &[]);
    let runtime_hash = runtime.schema_hash().to_string();
    register(
        &provider,
        runtime.clone(),
        Some("browser"),
        notifications.clone(),
    );
    provider.enable_reflection();

    let defaults = caller
        .call("hubrpc.defaults::get", json!({}))
        .await
        .unwrap();
    assert_eq!(defaults, json!({}));

    let registration = provider
        .register(
            interface("cdp.Runtime.bare", &["evaluate"], &[]),
            Arc::new(RecordingHandler {
                interface_id: "cdp.Runtime.bare".into(),
                service_id: Some("browser".into()),
                notifications: notifications.clone(),
            }),
            RegisterOptions {
                service_id: Some("browser".into()),
                bare_prefix: Some("Runtime.".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let defaults = caller
        .call("hubrpc.defaults::get", json!({}))
        .await
        .unwrap();
    assert_eq!(defaults, json!({}));

    registration.unregister();
    register_bare(&provider, runtime, Some("browser2"), "", notifications);
    let defaults = caller
        .call("hubrpc.defaults::get", json!({}))
        .await
        .unwrap();
    assert_eq!(
        defaults,
        json!({
            "serviceId": "browser2",
            "interfaceId": "cdp.Runtime",
            "interfaceHash": runtime_hash,
        })
    );
}
