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
        _mode: String,
    ) -> Result<String, CallError<CheckError>> {
        Err(CallError::Application(CheckError::NotFound(
            MissingData::new("gone".into()),
        )))
    }

    async fn stream_check(
        &self,
        _ctx: &CallCtx,
        mode: String,
        stream_sender: StreamSender<String>,
    ) -> Result<String, CallError<StreamCheckError>> {
        stream_sender.send("checking".into()).await.unwrap();
        match mode.as_str() {
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
        _mode: String,
    ) -> Result<String, CallError<CheckError>> {
        Err(CallError::Generic(RpcCallError::Remote(JsonRpcError {
            code: 29_999,
            message: "Undeclared".into(),
            data: Some(serde_json::json!({ "kept": true })),
        })))
    }

    async fn stream_check(
        &self,
        _ctx: &CallCtx,
        _mode: String,
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
        .check("missing".into())
        .await
        .unwrap_err();
    match error {
        CallError::Application(CheckError::NotFound(missing)) => {
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

#[test]
fn generated_named_and_legacy_contracts_keep_distinct_encodings() {
    let named = CheckError::NotFound(MissingData::new("gone".into())).into_rpc_error();
    assert_eq!(named.code, 1);
    assert_eq!(
        named.data,
        Some(serde_json::json!({
            "type": "NotFound", "data": { "resource": "gone" }
        }))
    );
    let mut renamed_message = named.clone();
    renamed_message.message = "A diagnostic for humans".into();
    assert!(matches!(
        CheckError::try_from_rpc_error(renamed_message),
        Ok(CheckError::NotFound(_))
    ));
    let mut wrong_code = named.clone();
    wrong_code.code = 2001;
    assert!(CheckError::try_from_rpc_error(wrong_code).is_err());
    let mut malformed = named;
    malformed.data.as_mut().unwrap()["data"]["resource"] = serde_json::json!(42);
    assert_eq!(
        CallError::<CheckError>::from_remote(malformed.clone()).into_rpc_error(),
        malformed
    );

    let unit = CheckError::Busy.into_rpc_error();
    assert_eq!(unit.data, Some(serde_json::json!({ "type": "Busy" })));
    assert!(matches!(
        CheckError::try_from_rpc_error(unit),
        Ok(CheckError::Busy)
    ));
    let nullable = CheckError::NullableValue(None).into_rpc_error();
    assert_eq!(
        nullable.data,
        Some(serde_json::json!({ "type": "nullable-value", "data": null }))
    );
    assert!(matches!(
        CheckError::try_from_rpc_error(nullable),
        Ok(CheckError::NullableValue(None))
    ));
    let recursive =
        CheckError::Recursive(RecursiveData::new("root".into(), vec![])).into_rpc_error();
    assert!(matches!(
        CheckError::try_from_rpc_error(recursive),
        Ok(CheckError::Recursive(_))
    ));

    let legacy = CheckError::Code2001(MissingData::new("gone".into())).into_rpc_error();
    assert_eq!(legacy.data, Some(serde_json::json!({ "resource": "gone" })));
    let mut wrong_message = legacy.clone();
    wrong_message.message = "Different".into();
    assert!(CheckError::try_from_rpc_error(wrong_message).is_err());
    assert!(matches!(
        CheckError::try_from_rpc_error(legacy),
        Ok(CheckError::Code2001(_))
    ));
    assert_eq!(CheckError::Code2002.into_rpc_error().data, None);
    assert_eq!(
        CheckError::Code2003(None).into_rpc_error().data,
        Some(serde_json::Value::Null)
    );
}

#[test]
fn legacy_identifier_collisions_do_not_change_wire_encoding() {
    let legacy = CheckError::Code2001(MissingData::new("legacy".into())).into_rpc_error();
    assert_eq!(legacy.code, 2001);
    assert_eq!(
        legacy.data,
        Some(serde_json::json!({ "resource": "legacy" }))
    );
    assert!(matches!(CheckError::try_from_rpc_error(legacy),
        Ok(CheckError::Code2001(MissingData { resource })) if resource == "legacy"));

    let named = CheckError::Code20012(true).into_rpc_error();
    assert_eq!(named.code, 2001);
    assert_eq!(
        named.data,
        Some(serde_json::json!({ "type": "Code2001", "data": true }))
    );
    assert!(matches!(
        CheckError::try_from_rpc_error(named),
        Ok(CheckError::Code20012(true))
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
        .stream_check("ok".into())
        .await
        .unwrap();
    let (result, _, mut payloads, _) = call.into_parts();
    assert_eq!(payloads.recv().await.as_deref(), Some("checking"));
    assert_eq!(payloads.recv().await.as_deref(), Some("complete"));
    assert_eq!(result.await.unwrap(), "found");
    assert_eq!(payloads.recv().await, None);

    let call = client
        .stream_check("missing".into())
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
        .stream_check("busy".into())
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
        .check("decode".into())
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        CallError::Generic(RpcCallError::Local(JsonRpcError {
            code: error_codes::INTERNAL_ERROR,
            ..
        }))
    ));
}
