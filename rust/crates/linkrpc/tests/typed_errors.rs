use std::sync::Arc;

use linkrpc::prelude::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct MissingData {
    resource: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct RecursiveData {
    label: String,
    children: Vec<RecursiveData>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
struct BadParam;

impl Serialize for BadParam {
    fn serialize<S: serde::Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom(
            "intentional serialization failure",
        ))
    }
}

#[derive(Clone, Debug, PartialEq, linkrpc::ApplicationError)]
enum LookupError {
    #[rpc_error(code = 1001, message = "Missing")]
    Missing(MissingData),
    #[rpc_error(code = 1002, message = "Busy")]
    Busy,
    #[rpc_error(code = 1003, message = "Nullable")]
    Nullable(Option<String>),
    #[rpc_error(code = 1004, message = "Recursive")]
    Recursive(RecursiveData),
}

#[derive(Debug, linkrpc::ApplicationError)]
enum InvalidPayloadError {
    #[rpc_error(code = 1100, message = "Invalid float")]
    InvalidFloat(f64),
}

mod first {
    use super::*;
    #[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
    pub struct Payload {
        pub children: Vec<Payload>,
    }
    #[derive(Debug, linkrpc::ApplicationError)]
    pub enum Error {
        #[rpc_error(code = 1201, message = "First")]
        Value(Payload),
    }
}

mod second {
    use super::*;
    #[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
    pub struct Payload {
        pub label: String,
        pub child: Option<Box<Payload>>,
    }
    #[derive(Debug, linkrpc::ApplicationError)]
    pub enum Error {
        #[rpc_error(code = 1202, message = "Second")]
        Value(Payload),
    }
}

#[derive(Debug, linkrpc::ApplicationError)]
enum CombinedError {
    #[rpc_error(code = 1203, message = "Combined first")]
    First(first::Payload),
    #[rpc_error(code = 1204, message = "Combined second")]
    Second(second::Payload),
}

#[linkrpc::prelude::link_rpc_interface(id = "example.collisions")]
trait CollisionApi {
    async fn first() -> Result<(), first::Error>;
    async fn second() -> Result<(), second::Error>;
    async fn combined() -> Result<(), CombinedError>;
}

#[linkrpc::prelude::link_rpc_interface(id = "example.lookup")]
trait Lookup {
    async fn lookup(resource: String) -> Result<String, CallError<LookupError>>;

    async fn bad_param(value: BadParam) -> Result<String, LookupError>;

    async fn direct(resource: String) -> std::result::Result<String, LookupErrorAlias>;

    #[output_stream(String)]
    async fn streaming(resource: String) -> Result<String, CallError<LookupError>>;

    async fn legacy() -> Result<String, linkrpc::prelude::JsonRpcError>;
}

type LookupErrorAlias = LookupError;

struct Provider;

#[test]
#[should_panic(expected = "protocol-reserved")]
fn manually_authored_errors_cannot_bypass_validation() {
    let interface = InterfaceDefinition::new(
        InterfaceInfo::new("example.invalid-errors"),
        vec![(
            "check".into(),
            Member::Request(Box::new(RequestMember {
                params_schema: json!(true),
                result_schema: json!(true),
                client_stream_schema: None,
                server_stream_schema: None,
                errors: Some(vec![ErrorSchema {
                    code: -32603,
                    message: "Invalid application code".into(),
                    data: None,
                }]),
                error_components: None,
                docs: MemberDocs::default(),
            })),
        )],
    );
    interface.to_schema();
}

#[test]
#[should_panic(expected = "duplicate error code")]
fn imported_interfaces_reject_duplicate_codes() {
    let mut schema = lookup::interface().to_schema();
    let errors = schema
        .methods
        .get_mut("lookup")
        .unwrap()
        .errors
        .as_mut()
        .unwrap();
    errors[1].code = errors[0].code;
    InterfaceDefinition::from_schema(schema);
}

#[test]
#[should_panic(expected = "must not declare errors")]
fn imported_notifications_reject_even_empty_error_declarations() {
    let mut schema = lookup::interface().to_schema();
    let method = schema.methods.get_mut("lookup").unwrap();
    method.result = None;
    method.errors = Some(vec![]);
    InterfaceDefinition::from_schema(schema);
}

#[async_trait]
impl Lookup for Provider {
    async fn streaming(
        &self,
        _ctx: &CallCtx,
        resource: String,
        progress: StreamSender<String>,
    ) -> Result<String, CallError<LookupError>> {
        progress
            .send("started".into())
            .await
            .map_err(CallError::Local)?;
        match resource.as_str() {
            "unknown" => Err(CallError::Remote(JsonRpcError::new(9999, "Unknown"))),
            "malformed" => Err(CallError::Remote(JsonRpcError {
                code: 1001,
                message: "Missing".into(),
                data: Some(json!({ "resource": 42 })),
            })),
            _ => self
                .direct(_ctx, resource)
                .await
                .map_err(CallError::Application),
        }
    }

    async fn direct(&self, _ctx: &CallCtx, resource: String) -> Result<String, LookupErrorAlias> {
        match resource.as_str() {
            "known" => Ok("found".into()),
            "busy" => Err(LookupError::Busy),
            _ => Err(LookupError::Missing(MissingData { resource })),
        }
    }

    async fn lookup(
        &self,
        _ctx: &CallCtx,
        resource: String,
    ) -> Result<String, CallError<LookupError>> {
        Err(CallError::Application(LookupError::Missing(MissingData {
            resource,
        })))
    }

    async fn legacy(&self, _ctx: &CallCtx) -> Result<String, JsonRpcError> {
        Err(JsonRpcError::new(-31_000, "legacy"))
    }

    async fn bad_param(&self, _ctx: &CallCtx, _value: BadParam) -> Result<String, LookupError> {
        Ok("unused".into())
    }
}

#[test]
fn derive_requires_exact_wire_contract() {
    let known = JsonRpcError {
        code: 1001,
        message: "Missing".into(),
        data: Some(json!({ "resource": "a" })),
    };
    assert_eq!(
        LookupError::try_from_rpc_error(known),
        Ok(LookupError::Missing(MissingData {
            resource: "a".into()
        }))
    );
    assert_eq!(
        LookupError::try_from_rpc_error(JsonRpcError {
            code: 1003,
            message: "Nullable".into(),
            data: Some(JsonValue::Null),
        }),
        Ok(LookupError::Nullable(None))
    );
    let recursive = LookupError::Recursive(RecursiveData {
        label: "root".into(),
        children: vec![RecursiveData {
            label: "child".into(),
            children: vec![],
        }],
    })
    .into_rpc_error();
    assert!(matches!(
        LookupError::try_from_rpc_error(recursive),
        Ok(LookupError::Recursive(RecursiveData { children, .. })) if children.len() == 1
    ));

    for malformed in [
        JsonRpcError {
            code: 1001,
            message: "missing".into(),
            data: Some(json!({ "resource": "a" })),
        },
        JsonRpcError {
            code: 1003,
            message: "Nullable".into(),
            data: None,
        },
        JsonRpcError {
            code: 1001,
            message: "Missing".into(),
            data: None,
        },
        JsonRpcError {
            code: 1001,
            message: "Missing".into(),
            data: Some(json!({ "resource": "a", "extra": true })),
        },
        JsonRpcError {
            code: 1002,
            message: "Busy".into(),
            data: Some(JsonValue::Null),
        },
    ] {
        let original = malformed.clone();
        assert_eq!(LookupError::try_from_rpc_error(malformed), Err(original));
    }
}

#[test]
fn trait_schema_exports_declared_errors() {
    let schema = lookup::interface().to_schema();
    let errors = schema.methods["lookup"].errors.as_ref().unwrap();
    assert_eq!(errors.len(), 4);
    assert_eq!(errors[0].code, 1001);
    assert_eq!(errors[0].message, "Missing");
    assert!(errors[0].data.is_some());
    assert_eq!(errors[1].code, 1002);
    assert!(errors[1].data.is_none());
    assert!(schema.methods["legacy"].errors.is_none());
    assert!(schema
        .components
        .as_ref()
        .and_then(|components| components.schemas.as_ref())
        .is_some_and(|schemas| schemas.keys().any(|name| name.ends_with(".RecursiveData"))));
}

#[test]
fn outgoing_invalid_payload_becomes_internal_error_without_panicking() {
    let error = InvalidPayloadError::InvalidFloat(f64::NAN).into_rpc_error();
    assert_eq!(error.code, error_codes::INTERNAL_ERROR);
    assert!(error.data.is_none());
}

#[test]
fn derived_error_components_are_scoped_by_method_and_code() {
    let schema = collision_api::interface().to_schema();
    let schemas = schema.components.unwrap().schemas.unwrap();
    assert!(schemas
        .keys()
        .any(|name| name.starts_with("first.Code1201.")));
    assert!(schemas
        .keys()
        .any(|name| name.starts_with("second.Code1202.")));
    assert!(schemas
        .keys()
        .any(|name| name.starts_with("combined.Code1203.")));
    assert!(schemas
        .keys()
        .any(|name| name.starts_with("combined.Code1204.")));
    assert_eq!(schemas.len(), 4);
}

#[tokio::test]
async fn typed_client_and_server_round_trip() {
    let (a, b) = transport_pair();
    let client_conn = LinkRpcConnection::new(Box::new(a));
    let server_conn = LinkRpcConnection::new(Box::new(b));
    server_conn
        .register_service(
            Arc::new(LookupServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();
    let client_run = client_conn.clone();
    let server_run = server_conn.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move { server_run.run().await });

    let client = LookupClient::new(client_conn);
    assert_eq!(
        client.lookup("widget".into()).await.unwrap_err(),
        CallError::Application(LookupError::Missing(MissingData {
            resource: "widget".into()
        }))
    );

    let legacy = client.legacy().await.unwrap_err();
    assert_eq!(legacy.code, -31_000);

    assert_eq!(client.direct("known".into()).await, Ok("found".into()));
    assert_eq!(
        client.direct("busy".into()).await,
        Err(CallError::Application(LookupError::Busy))
    );
    assert_eq!(
        client.direct("widget".into()).await,
        Err(CallError::Application(LookupError::Missing(MissingData {
            resource: "widget".into()
        })))
    );

    let schema = lookup::interface().to_schema();
    assert_eq!(schema.methods["direct"].errors.as_ref().unwrap().len(), 4);
    assert!(schema.methods["legacy"].errors.is_none());
}

#[tokio::test]
async fn inferred_errors_preserve_streaming_and_final_error_types() {
    let (a, b) = transport_pair();
    let client_conn = LinkRpcConnection::new(Box::new(a));
    let server_conn = LinkRpcConnection::new(Box::new(b));
    server_conn
        .register_service(
            Arc::new(LookupServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();
    let client_run = client_conn.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move { server_conn.run().await });
    let client = LookupClient::new(client_conn);

    for resource in ["known", "busy", "widget", "unknown", "malformed"] {
        let call = client.streaming(resource.into()).await.unwrap();
        let (result, _, mut progress, _) = call.into_parts();
        assert_eq!(progress.recv().await, Some("started".into()));
        let result: Result<String, CallError<LookupError>> = result.await;
        match resource {
            "known" => assert_eq!(result, Ok("found".into())),
            "busy" => assert_eq!(result, Err(CallError::Application(LookupError::Busy))),
            "widget" => assert_eq!(
                result,
                Err(CallError::Application(LookupError::Missing(MissingData {
                    resource: "widget".into(),
                })))
            ),
            "unknown" => {
                assert!(matches!(result, Err(CallError::Remote(error)) if error.code == 9999))
            }
            "malformed" => assert!(matches!(result, Err(CallError::Remote(error))
                if error.data == Some(json!({ "resource": 42 })))),
            _ => unreachable!(),
        }
        assert_eq!(progress.recv().await, None);
    }
}

#[tokio::test]
async fn authored_client_marks_param_serialization_failures_local() {
    let (transport, _peer) = transport_pair();
    let client = LookupClient::new(LinkRpcConnection::new(Box::new(transport)));
    let error = client.bad_param(BadParam).await.unwrap_err();
    assert!(matches!(
        error,
        CallError::Local(JsonRpcError {
            code: error_codes::INTERNAL_ERROR,
            ..
        })
    ));
}

#[tokio::test]
async fn typed_client_preserves_transport_origin_when_peer_closes() {
    let (client_transport, peer_transport) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(client_transport));
    let client_run = client_connection.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move {
        // Wait until the request is in flight, then simulate NDJSON EOF.
        let _request = peer_transport.recv().await;
        drop(peer_transport);
    });

    let error = LookupClient::new(client_connection)
        .lookup("disconnect".into())
        .await
        .unwrap_err();
    assert_eq!(error, CallError::Transport(TransportError::Closed));

    // A peer cannot spoof this branch with the JSON-RPC PEER_DISCONNECTED code:
    // wire errors always enter through Remote classification.
    let spoofed = CallError::<LookupError>::from_remote(JsonRpcError::new(
        error_codes::PEER_DISCONNECTED,
        "channel closed",
    ));
    assert!(matches!(spoofed, CallError::Remote(_)));
}

#[test]
fn generated_errors_are_typed_and_validate_against_components() {
    let schema: LinkRpcInterfaceSchema = serde_json::from_value(json!({
        "id": "example.generated",
        "hash": "",
        "methods": {
            "fetch": {
                "params": { "type": "object", "properties": {}, "additionalProperties": false },
                "result": { "type": "string" },
                "errors": [
                    {
                        "code": 1001,
                        "message": "Missing",
                        "data": { "$ref": "#/components/schemas/Problem" }
                    },
                    { "code": -7, "message": "Offline" }
                ]
            }
        },
        "components": {
            "schemas": {
                "Problem": {
                    "type": "object",
                    "properties": { "reason": { "type": "string" } },
                    "required": ["reason"],
                    "additionalProperties": false
                }
            }
        }
    }))
    .unwrap();
    let generated = generate_rust_interface(&schema, &GenerateRustOptions::default()).code;
    assert!(generated.contains("pub enum FetchError"));
    assert!(generated.contains("Code1001(Problem)"));
    assert!(generated.contains("CodeMinus7"));
    assert!(generated.contains("CallError<FetchError>"));
    assert!(generated.contains("#[derive(Clone, Debug, linkrpc::prelude::ApplicationError)]"));
    assert!(
        generated.contains("#[rpc_error(schema = __linkrpc_interface::schema, method = \"fetch\"")
    );
}
