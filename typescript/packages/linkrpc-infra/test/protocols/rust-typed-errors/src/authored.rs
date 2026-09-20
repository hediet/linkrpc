use std::{env, sync::Arc};

use async_trait::async_trait;
use linkrpc::prelude::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

mod common;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MissingData {
    pub resource: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Detail {
    pub label: String,
    pub children: Vec<Detail>,
}

#[derive(Debug, linkrpc::ApplicationError)]
pub enum FixtureError {
    #[rpc_error(code = 1001, message = "Missing")]
    Missing(MissingData),
    #[rpc_error(code = 1002, message = "Busy")]
    Busy,
    #[rpc_error(code = 1003, message = "Nullable")]
    Nullable(Option<String>),
    #[rpc_error(code = 1004, message = "Recursive")]
    Recursive(Detail),
    #[rpc_error(code = 1005, message = "Numeric")]
    Numeric(f64),
}

#[link_rpc_interface(id = "dev.linkrpc.rust-errors")]
pub trait RustErrors {
    async fn check(mode: String) -> Result<String, CallError<FixtureError>>;
}

struct Service;

#[async_trait]
impl RustErrors for Service {
    async fn check(&self, _ctx: &CallCtx, mode: String) -> Result<String, CallError<FixtureError>> {
        match mode.as_str() {
            "success" => Ok("ok".into()),
            "missing" => Err(CallError::Application(FixtureError::Missing(MissingData {
                resource: "file".into(),
            }))),
            "busy" => Err(CallError::Application(FixtureError::Busy)),
            "nullable" => Err(CallError::Application(FixtureError::Nullable(None))),
            "numeric" => Err(CallError::Application(FixtureError::Numeric(42.5))),
            "invalid-encoding" => Err(CallError::Application(FixtureError::Numeric(f64::NAN))),
            "recursive" => Err(CallError::Application(FixtureError::Recursive(Detail {
                label: "root".into(),
                children: vec![Detail {
                    label: "leaf".into(),
                    children: vec![],
                }],
            }))),
            mode => Err(CallError::Remote(common::remote_error(mode, 1000))),
        }
    }
}

async fn client(connection: LinkRpcConnection) {
    let client = RustErrorsClient::new(connection.clone());
    assert_eq!(client.check("success".into()).await.unwrap(), "ok");
    match client.check("missing".into()).await.unwrap_err() {
        CallError::Application(FixtureError::Missing(data)) => assert_eq!(data.resource, "file"),
        error => panic!("expected Missing, got {error:?}"),
    }
    assert!(matches!(
        client.check("busy".into()).await,
        Err(CallError::Application(FixtureError::Busy))
    ));
    assert!(matches!(
        client.check("nullable".into()).await,
        Err(CallError::Application(FixtureError::Nullable(None)))
    ));
    match client.check("recursive".into()).await.unwrap_err() {
        CallError::Application(FixtureError::Recursive(data)) => {
            assert_eq!(data.label, "root");
            assert_eq!(data.children[0].label, "leaf");
        }
        error => panic!("expected Recursive, got {error:?}"),
    }
    assert!(matches!(
        client.check("numeric".into()).await,
        Err(CallError::Application(FixtureError::Numeric(value))) if value == 42.5
    ));
    for mode in [
        "unknown",
        "protocol",
        "spoof-transport",
        "wrong-message",
        "wrong-data",
        "missing-data",
        "extra-data",
        "missing-nullable",
        "extra-property",
        "bad-recursion",
    ] {
        match client.check(mode.into()).await.unwrap_err() {
            CallError::Remote(error) => assert_eq!(error, common::remote_error(mode, 1000)),
            error => panic!("{mode}: expected original generic error, got {error:?}"),
        }
    }
    assert!(matches!(
        client.check("invalid-encoding".into()).await,
        Err(CallError::Remote(JsonRpcError {
            code: error_codes::INTERNAL_ERROR,
            ..
        }))
    ));
    let disconnected = client.check("disconnect".into()).await.unwrap_err();
    assert!(
        matches!(
            disconnected,
            CallError::Transport(linkrpc::transport::message::TransportError::Closed)
        ),
        "transport closure must not masquerade as a remote error: {disconnected:?}",
    );
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mode = env::args().nth(1).expect("export, server, or client");
    if mode == "export" {
        println!(
            "{}",
            serde_json::to_string(&rust_errors::interface().to_schema()).unwrap()
        );
        return;
    }
    let connection = common::connection();
    match mode.as_str() {
        "server" => {
            connection
                .register_service(
                    Arc::new(RustErrorsServer::new(Arc::new(Service))),
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
                .expect("typed error client timed out");
        }
        _ => panic!("unexpected mode {mode}"),
    }
}
