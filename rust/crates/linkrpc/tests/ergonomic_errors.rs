use std::sync::Arc;

use linkrpc::connection::channel::RejectingHandler;
use linkrpc::prelude::*;
use linkrpc::protocol::jsonrpc::ResponsePayload;
use serde_json::json;

#[derive(Clone, Debug, PartialEq, ApplicationError)]
#[rpc_error(display)]
enum FrameError {
    #[rpc_error(message = "Frame {frame_index} not found")]
    Missing { frame_index: u32 },
    #[rpc_error(message = "Invalid frame {0:04}")]
    Invalid(u32),
    #[rpc_error(message = "Literal {{braces}}")]
    Braces,
    #[rpc_error(generic)]
    Generic(RpcCallError),
}

#[derive(Clone, Debug, PartialEq, ApplicationError)]
#[rpc_error(display)]
enum FormattingError {
    #[rpc_error(message = "Literal {{0}} {{}} {{:04}}")]
    Escaped(u32),
    #[rpc_error(message = "Frame {frame_index:04}: {reason:?}")]
    Renamed {
        #[serde(rename = "frameIndex")]
        frame_index: u32,
        reason: String,
    },
    #[rpc_error(message = "Payload {}")]
    Positional(u32),
}

#[derive(Debug, ApplicationError)]
enum LiteralError {
    #[rpc_error(message = "foreign {not-a-rust-field} and {}")]
    Literal,
}

#[derive(Debug, PartialEq, ApplicationError)]
#[rpc_error(display)]
enum GenericOnlyError {
    #[rpc_error(generic)]
    Generic(RpcCallError),
}

pub use linkrpc as alternate_runtime;

fn imported_schema() -> linkrpc::schema::LinkRpcInterfaceSchema {
    serde_json::from_value(json!({
        "id": "test.imported-errors", "hash": "", "methods": {
            "read": {"params": true, "result": true, "errors": [
                {"code": 1, "type": "Missing", "message": "Missing {foreign-key}",
                 "data": {"type": "object", "properties": {"wireKey": {"type": "integer"}},
                          "required": ["wireKey"], "additionalProperties": false}},
                {"code": -32001, "schema": {
                    "type": "object", "properties": {"message": {"type": "string"}},
                    "required": ["message"], "additionalProperties": false
                }}
            ]}
        }
    }))
    .unwrap()
}

#[derive(Clone, Debug, PartialEq, ApplicationError)]
#[rpc_error(schema = imported_schema, method = "read", runtime = "crate::alternate_runtime", display)]
enum ImportedError {
    #[rpc_error(message = "Missing {foreign-key}")]
    Missing {
        #[serde(rename = "wireKey")]
        key: u32,
    },
    #[rpc_error(code = -32001, raw)]
    Raw { message: String },
    #[rpc_error(generic)]
    Generic(RpcCallError),
}

#[test]
fn formatting_handles_escaped_tuple_braces_and_serde_names() {
    for (error, message) in [
        (FormattingError::Escaped(3), "Literal {0} {} {:04}"),
        (
            FormattingError::Renamed {
                frame_index: 3,
                reason: "gone".into(),
            },
            "Frame 0003: \"gone\"",
        ),
        (FormattingError::Positional(3), "Payload 3"),
    ] {
        assert_eq!(error.to_string(), message);
        let wire = error.clone().into_rpc_error();
        assert_eq!(wire.message, message);
        assert_eq!(FormattingError::try_from_rpc_error(wire), Ok(error));
    }
    assert_eq!(
        FormattingError::Renamed {
            frame_index: 3,
            reason: "gone".into()
        }
        .into_rpc_error()
        .data,
        Some(json!({"type": "Renamed", "data": {"frameIndex": 3, "reason": "gone"}}))
    );
    assert_eq!(
        LiteralError::Literal.into_rpc_error().message,
        "foreign {not-a-rust-field} and {}"
    );
}

#[test]
fn imported_and_raw_errors_remain_literal_with_a_generic_fallback() {
    let named = ImportedError::Missing { key: 3 };
    assert_eq!(named.to_string(), "Missing {foreign-key}");
    let mut wire = named.clone().into_rpc_error();
    assert_eq!(
        wire.data,
        Some(json!({"type": "Missing", "data": {"wireKey": 3}}))
    );
    wire.message = "any remote diagnostic".into();
    assert_eq!(ImportedError::from(RpcCallError::Remote(wire)), named);

    let raw = ImportedError::Raw {
        message: "raw {arbitrary} diagnostic".into(),
    };
    let wire = raw.clone().into_rpc_error();
    assert_eq!(
        wire,
        JsonRpcError::new(-32001, "raw {arbitrary} diagnostic")
    );
    assert_eq!(ImportedError::from(RpcCallError::Remote(wire)), raw);
    let wire = JsonRpcError {
        code: 1,
        message: "bad data".into(),
        data: Some(json!({"type": "Missing", "data": {"wireKey": "invalid"}})),
    };
    assert!(matches!(
        ImportedError::from(RpcCallError::Remote(wire.clone())),
        ImportedError::Generic(RpcCallError::NonCompliantServer { original, .. }) if *original == wire
    ));
    assert_eq!(ImportedError::error_schemas().len(), 2);
}

#[test]
fn generic_only_enum_has_no_application_schema() {
    let wire = JsonRpcError::new(77, "undeclared");
    let error = RpcCallError::Remote(wire.clone());
    assert!(GenericOnlyError::error_schemas().is_empty());
    assert_eq!(
        GenericOnlyError::from(error.clone()),
        GenericOnlyError::Generic(error)
    );
    assert_eq!(
        GenericOnlyError::Generic(RpcCallError::Remote(wire.clone())).into_rpc_error(),
        wire
    );
}

#[link_rpc_interface(id = "test.frames")]
trait Frames {
    async fn get(frame_index: u32) -> Result<String, FrameError>;
    async fn plain() -> Result<String, JsonRpcError>;
    #[notification]
    async fn changed();
    #[output_stream(String)]
    async fn stream() -> Result<String, FrameError>;
    #[output_stream(String)]
    async fn plain_stream() -> Result<String, RpcCallError>;
}

#[test]
fn interpolation_display_and_wire_agree_without_changing_the_envelope() {
    for (error, message) in [
        (
            FrameError::Missing { frame_index: 17 },
            "Frame 17 not found",
        ),
        (FrameError::Invalid(3), "Invalid frame 0003"),
        (FrameError::Braces, "Literal {braces}"),
    ] {
        assert_eq!(error.to_string(), message);
        let mut wire = error.clone().into_rpc_error();
        assert_eq!(wire.code, 1);
        assert_eq!(wire.message, message);
        assert_eq!(
            FrameError::try_from_rpc_error(wire.clone()),
            Ok(error.clone())
        );
        wire.message = "diagnostic from another language".into();
        assert_eq!(FrameError::try_from_rpc_error(wire), Ok(error));
    }
    assert_eq!(
        FrameError::Missing { frame_index: 17 }
            .into_rpc_error()
            .data,
        Some(json!({"type": "Missing", "data": {"frame_index": 17}}))
    );
    let schema = frames::interface().to_schema();
    let errors = schema.methods["get"].errors.as_ref().unwrap();
    assert_eq!(errors.len(), 3);
    assert_eq!(errors[0].message, "Frame {frame_index} not found");
    assert!(!serde_json::to_string(&schema).unwrap().contains("Generic"));
    assert!(schema.methods["plain"].errors.is_none());
    assert!(schema.methods["plain_stream"].errors.is_none());
}

#[test]
fn conversions_decode_only_remote_errors_and_preserve_all_other_origins() {
    let declared = FrameError::Missing { frame_index: 17 }.into_rpc_error();
    assert_eq!(
        FrameError::from(RpcCallError::Remote(declared.clone())),
        FrameError::Missing { frame_index: 17 }
    );
    let unknown = JsonRpcError::new(12345, "unknown");
    let invalid = JsonRpcError {
        code: 1,
        message: "bad".into(),
        data: Some(json!({"type":"Missing"})),
    };
    let noncompliant = RpcCallError::NonCompliantServer {
        original: Box::new(invalid.clone()),
        issues: vec![ValidationIssue {
            path: "/custom".into(),
            message: "preserved".into(),
        }],
    };
    for error in [
        RpcCallError::Remote(unknown),
        RpcCallError::Local(declared.clone()),
        RpcCallError::Transport(TransportError::Closed),
        noncompliant,
    ] {
        assert_eq!(
            FrameError::from(error.clone()),
            FrameError::Generic(error.clone())
        );
        // Already classified CallError::Generic must not be decoded again.
        assert_eq!(
            FrameError::from(CallError::Generic(error.clone())),
            FrameError::Generic(error)
        );
    }
    assert_eq!(
        FrameError::from(CallError::Generic(RpcCallError::Remote(declared.clone()))),
        FrameError::Generic(RpcCallError::Remote(declared))
    );
    let FrameError::Generic(RpcCallError::NonCompliantServer { original, issues }) =
        FrameError::from(RpcCallError::Remote(invalid.clone()))
    else {
        panic!("compliance error")
    };
    assert_eq!(*original, invalid);
    assert!(!issues.is_empty());
}

#[derive(Clone)]
struct Caller(Result<JsonValue, RpcCallError>);

#[async_trait]
impl RpcCall for Caller {
    async fn call(&self, _: &str, _: JsonValue) -> Result<JsonValue, JsonRpcError> {
        panic!("generated clients must use the detailed boundary")
    }
    async fn call_detailed(&self, _: &str, _: JsonValue) -> Result<JsonValue, RpcCallError> {
        self.0.clone()
    }
    async fn notify(&self, _: &str, _: JsonValue) -> Result<(), JsonRpcError> {
        panic!("generated notifications must use the detailed boundary")
    }
    async fn notify_detailed(&self, _: &str, _: JsonValue) -> Result<(), RpcCallError> {
        self.0.clone().map(|_| ())
    }
}

#[tokio::test]
async fn generated_clients_return_direct_errors_and_forward_detailed_notifications() {
    let error = FrameError::Missing { frame_index: 2 }.into_rpc_error();
    let client = FramesClient::new(Caller(Err(RpcCallError::Remote(error.clone()))));
    let direct: Result<String, FrameError> = client.get(2).await;
    assert_eq!(direct, Err(FrameError::Missing { frame_index: 2 }));
    let plain: Result<String, RpcCallError> = client.plain().await;
    assert_eq!(plain, Err(RpcCallError::Remote(error)));
    let caller = Arc::new(Caller(Err(RpcCallError::Transport(TransportError::Closed))));
    let client = FramesClient::new(Box::new(&caller));
    assert_eq!(
        client.changed().await,
        Err(RpcCallError::Transport(TransportError::Closed))
    );
    assert_eq!(
        client.get(2).await,
        Err(FrameError::Generic(RpcCallError::Transport(
            TransportError::Closed
        )))
    );
    let client = FramesClient::new(Caller(Ok(json!(false))));
    assert!(matches!(client.plain().await, Err(RpcCallError::Local(_))));
    assert!(matches!(
        client.get(2).await,
        Err(FrameError::Generic(RpcCallError::Local(_)))
    ));
}

struct FailingTransport;

#[async_trait]
impl MessageTransport for FailingTransport {
    async fn send(&self, _: JsonRpcMessage) -> Result<(), TransportError> {
        Err(TransportError::Closed)
    }
    async fn recv(&self) -> Option<JsonRpcMessage> {
        None
    }
}

#[tokio::test]
async fn transport_errors_survive_notification_and_stream_startup() {
    let client = FramesClient::new(Channel::new(
        Box::new(FailingTransport),
        Box::new(RejectingHandler),
    ));
    assert_eq!(
        client.changed().await,
        Err(RpcCallError::Transport(TransportError::Closed))
    );
    assert!(matches!(
        client.plain_stream().await,
        Err(RpcCallError::Transport(TransportError::Closed))
    ));
    assert!(matches!(
        client.stream().await,
        Err(FrameError::Generic(RpcCallError::Transport(
            TransportError::Closed
        )))
    ));
}

async fn response_client(response: Option<ResponsePayload>) -> FramesClient<Channel> {
    let (transport, peer) = transport_pair();
    let channel = Channel::new(Box::new(transport), Box::new(RejectingHandler));
    let runner = channel.clone();
    tokio::spawn(async move { runner.run().await });
    tokio::spawn(async move {
        let JsonRpcMessage::Request(request) = peer.recv().await.unwrap() else {
            panic!("request")
        };
        if let Some(payload) = response {
            peer.send(JsonRpcMessage::Response(JsonRpcResponse {
                id: Some(request.id),
                payload,
            }))
            .await
            .unwrap();
        }
    });
    FramesClient::new(channel)
}

#[tokio::test]
async fn streaming_final_errors_use_the_same_surface_and_origins() {
    let wire = FrameError::Missing { frame_index: 7 }.into_rpc_error();
    let client = response_client(Some(ResponsePayload::Error(wire.clone()))).await;
    let (result, _, _, _) = client.stream().await.unwrap().into_parts();
    assert_eq!(result.await, Err(FrameError::Missing { frame_index: 7 }));
    let client = response_client(Some(ResponsePayload::Error(wire.clone()))).await;
    let (result, _, _, _) = client.plain_stream().await.unwrap().into_parts();
    assert_eq!(result.await, Err(RpcCallError::Remote(wire)));
    for typed in [false, true] {
        let client = response_client(None).await;
        if typed {
            let (result, _, _, _) = client.stream().await.unwrap().into_parts();
            assert_eq!(
                result.await,
                Err(FrameError::Generic(RpcCallError::Transport(
                    TransportError::Closed
                )))
            );
        } else {
            let (result, _, _, _) = client.plain_stream().await.unwrap().into_parts();
            assert_eq!(
                result.await,
                Err(RpcCallError::Transport(TransportError::Closed))
            );
        }
        let client = response_client(Some(ResponsePayload::Result(json!(false)))).await;
        if typed {
            let (result, _, _, _) = client.stream().await.unwrap().into_parts();
            assert!(matches!(
                result.await,
                Err(FrameError::Generic(RpcCallError::Local(_)))
            ));
        } else {
            let (result, _, _, _) = client.plain_stream().await.unwrap().into_parts();
            assert!(matches!(result.await, Err(RpcCallError::Local(_))));
        }
    }
}
