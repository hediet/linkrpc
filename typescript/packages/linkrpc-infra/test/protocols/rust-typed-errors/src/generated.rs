use std::{env, sync::Arc};

use async_trait::async_trait;
use linkrpc::prelude::*;

mod common;
include!(concat!(env!("OUT_DIR"), "/contract.rs"));
use contract::*;

struct Service;

#[async_trait]
impl DevLinkrpcTsErrorsService for Service {
    async fn check(
        &self,
        _ctx: &CallCtx,
        params: CheckParams,
    ) -> Result<String, CallError<CheckError>> {
        match params.mode.as_str() {
            "success" => Ok("ok".into()),
            "missing" => Err(CallError::Application(CheckError::Missing(
                CheckErrorMissingData::new("file".into()),
            ))),
            "busy" => Err(CallError::Application(CheckError::Busy)),
            "nullable" => Err(CallError::Application(CheckError::Nullable(None))),
            "numeric" => Err(CallError::Application(CheckError::Numeric(42.5))),
            "invalid-encoding" => Err(CallError::Application(CheckError::Numeric(f64::NAN))),
            "recursive" => Err(CallError::Application(CheckError::Recursive(
                MethodCheckSchemaError3D2004Root::new(
                    "root".into(),
                    vec![MethodCheckSchemaError3D2004Root::new("leaf".into(), vec![])],
                ),
            ))),
            "raw" => Err(CallError::Application(CheckError::CodeNeg32001(
                serde_json::from_value(common::raw_body("raw")).unwrap(),
            ))),
            mode => Err(CallError::Generic(linkrpc::client::RpcCallError::Remote(
                common::remote_error(mode, 2000),
            ))),
        }
    }
}

async fn client(connection: LinkRpcConnection) {
    let client = DevLinkrpcTsErrorsClient::new(connection.clone());
    assert_eq!(
        client
            .check(CheckParams::new("success".into()))
            .await
            .unwrap(),
        "ok"
    );
    match client
        .check(CheckParams::new("missing".into()))
        .await
        .unwrap_err()
    {
        CallError::Application(CheckError::Missing(data)) => assert_eq!(data.resource, "file"),
        error => panic!("expected declared Missing, got {error:?}"),
    }
    assert!(matches!(
        client.check(CheckParams::new("busy".into())).await,
        Err(CallError::Application(CheckError::Busy))
    ));
    assert!(matches!(
        client.check(CheckParams::new("nullable".into())).await,
        Err(CallError::Application(CheckError::Nullable(None)))
    ));
    match client
        .check(CheckParams::new("recursive".into()))
        .await
        .unwrap_err()
    {
        CallError::Application(CheckError::Recursive(data)) => {
            assert_eq!(data.label, "root");
            assert_eq!(data.children[0].label, "leaf");
        }
        error => panic!("expected declared Recursive, got {error:?}"),
    }
    assert!(matches!(
        client.check(CheckParams::new("numeric".into())).await,
        Err(CallError::Application(CheckError::Numeric(value))) if value == 42.5
    ));
    match client
        .check(CheckParams::new("changed-message".into()))
        .await
        .unwrap_err()
    {
        CallError::Application(CheckError::Missing(data)) => assert_eq!(data.resource, "file"),
        error => panic!("expected Missing despite dynamic message, got {error:?}"),
    }
    for mode in common::RAW_MODES {
        let body = match (
            mode,
            client
                .check(CheckParams::new(mode.into()))
                .await
                .unwrap_err(),
        ) {
            ("raw", CallError::Application(CheckError::CodeNeg32001(body))) => {
                serde_json::to_value(body).unwrap()
            }
            (
                "raw-absent" | "raw-null" | "raw-value",
                CallError::Application(CheckError::CodeNeg32002(body)),
            ) => serde_json::to_value(body).unwrap(),
            (
                "raw-string" | "raw-number",
                CallError::Application(CheckError::CodeNeg32003(body)),
            ) => serde_json::to_value(body).unwrap(),
            (mode, error) => panic!("{mode}: expected typed plain JSON-RPC error, got {error:?}"),
        };
        assert_eq!(body["message"], common::raw_body(mode)["message"]);
        match mode {
            "raw" => assert_eq!(body["data"]["retryAfter"].as_f64(), Some(5.0)),
            "raw-number" => assert_eq!(body["data"].as_f64(), Some(5.0)),
            "raw-absent" | "raw-null" => assert!(body["data"].is_null()),
            _ => assert_eq!(body["data"], common::raw_body(mode)["data"]),
        }
    }
    for mode in common::UNHANDLED_MODES
        .into_iter()
        .chain(common::NONCOMPLIANT_MODES)
    {
        let error = client
            .check(CheckParams::new(mode.into()))
            .await
            .unwrap_err();
        if mode == "extra-property" {
            assert!(matches!(
                error,
                CallError::Application(CheckError::Missing(data)) if data.resource == "file"
            ));
        } else {
            common::assert_generic_error(error, mode, 2000);
        }
    }
    assert!(matches!(
        client
            .check(CheckParams::new("invalid-encoding".into()))
            .await,
        Err(CallError::Generic(linkrpc::client::RpcCallError::Remote(
            JsonRpcError {
                code: error_codes::INTERNAL_ERROR,
                ..
            }
        )))
    ));
    let disconnected = client
        .check(CheckParams::new("disconnect".into()))
        .await
        .unwrap_err();
    assert!(
        matches!(
            disconnected,
            CallError::Generic(linkrpc::client::RpcCallError::Transport(
                linkrpc::transport::message::TransportError::Closed
            ))
        ),
        "transport closure must not masquerade as a remote error: {disconnected:?}",
    );
}

#[cfg(typed_error_negative_test)]
fn wrong_generated_payload() {
    let _ = CheckError::Missing("not the generated data struct");
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mode = env::args().nth(1).expect("server or client");
    let connection = common::connection();
    match mode.as_str() {
        "server" => {
            connection
                .register_service(
                    Arc::new(DevLinkrpcTsErrorsServer::new(Arc::new(Service))),
                    RegisterOptions::default(),
                )
                .unwrap();
            connection.run().await;
        }
        "client" => {
            let driver = connection.clone();
            tokio::spawn(async move { driver.run().await });
            tokio::time::timeout(std::time::Duration::from_secs(30), client(connection))
                .await
                .expect("generated typed error client timed out");
        }
        _ => panic!("unexpected mode {mode}"),
    }
}
