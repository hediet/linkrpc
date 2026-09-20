#[path = "codegen/generated_typed_errors.rs"]
mod generated;

use generated::*;
use linkrpc::prelude::*;
use std::sync::Arc;

struct Provider;

#[async_trait]
impl DevLinkrpcTsErrorsService for Provider {
    async fn check(
        &self,
        _ctx: &CallCtx,
        _params: CheckParams,
    ) -> Result<String, CallError<CheckError>> {
        Err(CallError::Application(CheckError::Code2001(
            MissingData::new("gone".into()),
        )))
    }

    async fn stream_check(
        &self,
        _ctx: &CallCtx,
        params: StreamCheckParams,
        stream_sender: StreamSender<String>,
    ) -> Result<String, CallError<StreamCheckError>> {
        stream_sender.send("checking".into()).await.unwrap();
        match params.mode.as_str() {
            "missing" => Err(CallError::Application(StreamCheckError::Code2001(
                MissingData::new("streamed".into()),
            ))),
            "busy" => Err(CallError::Application(StreamCheckError::Code2002)),
            _ => {
                stream_sender.send("complete".into()).await.unwrap();
                Ok("found".into())
            }
        }
    }
}

struct RawErrorProvider;

#[async_trait]
impl DevLinkrpcTsErrorsService for RawErrorProvider {
    async fn check(
        &self,
        _ctx: &CallCtx,
        _params: CheckParams,
    ) -> Result<String, CallError<CheckError>> {
        Err(CallError::Remote(JsonRpcError {
            code: 29_999,
            message: "Undeclared".into(),
            data: Some(serde_json::json!({ "kept": true })),
        }))
    }

    async fn stream_check(
        &self,
        _ctx: &CallCtx,
        _params: StreamCheckParams,
        _stream_sender: StreamSender<String>,
    ) -> Result<String, CallError<StreamCheckError>> {
        unreachable!()
    }
}

struct WrongResultCaller;

#[async_trait]
impl RpcCall for WrongResultCaller {
    async fn call(&self, _method: &str, _params: JsonValue) -> Result<JsonValue, JsonRpcError> {
        Ok(serde_json::json!({ "not": "a string" }))
    }

    async fn notify(&self, _method: &str, _params: JsonValue) -> Result<(), JsonRpcError> {
        Ok(())
    }
}

#[tokio::test]
async fn generated_typed_error_round_trips_and_rejects_malformed_data() {
    let (a, b) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(a));
    let server_connection = LinkRpcConnection::new(Box::new(b));
    server_connection
        .register_service(
            Arc::new(DevLinkrpcTsErrorsServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();
    let client_run = client_connection.clone();
    let server_run = server_connection.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move { server_run.run().await });

    let error = DevLinkrpcTsErrorsClient::new(client_connection)
        .check(CheckParams::new("missing".into()))
        .await
        .unwrap_err();
    match error {
        CallError::Application(CheckError::Code2001(missing)) => {
            assert_eq!(missing.resource, "gone");
        }

        other => panic!("unexpected error: {other:?}"),
    }

    let malformed = JsonRpcError {
        code: 2001,
        message: "Missing".into(),
        data: Some(serde_json::json!({ "reason": "gone", "unknown": true })),
    };
    assert!(matches!(
        CheckError::try_from_rpc_error(malformed),
        Err(JsonRpcError { code: 2001, .. })
    ));

    let recursive = JsonRpcError {
        code: 2004,
        message: "Recursive".into(),
        data: Some(serde_json::json!({
            "label": "outer",
            "children": [{ "label": "inner", "children": [] }]
        })),
    };
    assert!(matches!(
        CheckError::try_from_rpc_error(recursive),
        Ok(CheckError::Code2004(RecursiveData { children, .. })) if children.len() == 1
    ));
}

#[tokio::test]
async fn generated_typed_stream_preserves_payloads_and_final_application_errors() {
    let (a, b) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(a));
    let server_connection = LinkRpcConnection::new(Box::new(b));
    server_connection
        .register_service(
            Arc::new(DevLinkrpcTsErrorsServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();
    let client_run = client_connection.clone();
    let server_run = server_connection.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move { server_run.run().await });
    let client = DevLinkrpcTsErrorsClient::new(client_connection);

    let call = client
        .stream_check(StreamCheckParams::new("ok".into()))
        .await
        .unwrap();
    let (result, _, mut payloads, _) = call.into_parts();
    assert_eq!(payloads.recv().await.as_deref(), Some("checking"));
    assert_eq!(payloads.recv().await.as_deref(), Some("complete"));
    assert_eq!(result.await.unwrap(), "found");
    assert_eq!(payloads.recv().await, None);

    let call = client
        .stream_check(StreamCheckParams::new("missing".into()))
        .await
        .unwrap();
    let (result, _, mut payloads, _) = call.into_parts();
    assert_eq!(payloads.recv().await.as_deref(), Some("checking"));
    assert!(matches!(
        result.await,
        Err(CallError::Application(StreamCheckError::Code2001(
            MissingData { resource }
        ))) if resource == "streamed"
    ));
    assert_eq!(payloads.recv().await, None);

    let call = client
        .stream_check(StreamCheckParams::new("busy".into()))
        .await
        .unwrap();
    let (result, _, mut payloads, _) = call.into_parts();
    assert_eq!(payloads.recv().await.as_deref(), Some("checking"));
    assert!(matches!(
        result.await,
        Err(CallError::Application(StreamCheckError::Code2002))
    ));
}

#[tokio::test]
async fn generated_server_preserves_raw_remote_error() {
    let server = DevLinkrpcTsErrorsServer::new(Arc::new(RawErrorProvider));
    let error = server
        .handle_request(
            "check",
            serde_json::json!({ "mode": "unknown" }),
            CallCtx::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        error,
        JsonRpcError {
            code: 29_999,
            message: "Undeclared".into(),
            data: Some(serde_json::json!({ "kept": true })),
        }
    );
}

#[tokio::test]
async fn generated_client_marks_response_decode_failures_local() {
    let error = DevLinkrpcTsErrorsClient::new(WrongResultCaller)
        .check(CheckParams::new("decode".into()))
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        CallError::Local(JsonRpcError {
            code: error_codes::INTERNAL_ERROR,
            ..
        })
    ));
}
