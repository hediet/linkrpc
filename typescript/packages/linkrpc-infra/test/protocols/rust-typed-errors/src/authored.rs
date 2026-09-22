use std::{env, sync::Arc};

use async_trait::async_trait;
use linkrpc::prelude::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

mod common;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Detail {
    pub label: String,
    pub children: Vec<Detail>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetryBody {
    pub message: String,
    pub data: RetryData,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetryData {
    #[serde(rename = "retryAfter")]
    pub retry_after: f64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OptionalBody {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UnionBody {
    pub message: String,
    pub data: UnionData,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum UnionData {
    Text(String),
    Number(f64),
}

#[derive(Debug, linkrpc::ApplicationError)]
pub enum FixtureError {
    #[rpc_error(message = "Missing")]
    Missing { resource: String },
    #[rpc_error(message = "Busy")]
    Busy,
    #[rpc_error(code = 1003, message = "Nullable")]
    Nullable(Option<String>),
    #[rpc_error(code = 1004, message = "Recursive")]
    Recursive(Detail),
    #[rpc_error(code = 1005, message = "Numeric")]
    Numeric(f64),
    #[rpc_error(code = -32001, raw)]
    Retry(RetryBody),
    #[rpc_error(code = -32002, raw)]
    Optional(OptionalBody),
    #[rpc_error(code = -32003, raw)]
    Union(UnionBody),
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
            "missing" => Err(CallError::Application(FixtureError::Missing {
                resource: "file".into(),
            })),
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
            "raw" => Err(CallError::Application(FixtureError::Retry(RetryBody {
                message: "Retry after maintenance".into(),
                data: RetryData { retry_after: 5.0 },
            }))),
            mode => Err(CallError::Generic(linkrpc::client::RpcCallError::Remote(
                common::remote_error(mode, 1000),
            ))),
        }
    }
}

async fn client(connection: LinkRpcConnection) {
    let client = RustErrorsClient::new(connection.clone());
    assert_eq!(client.check("success".into()).await.unwrap(), "ok");
    match client.check("missing".into()).await.unwrap_err() {
        CallError::Application(FixtureError::Missing { resource }) => assert_eq!(resource, "file"),
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
    match client.check("changed-message".into()).await.unwrap_err() {
        CallError::Application(FixtureError::Missing { resource }) => assert_eq!(resource, "file"),
        error => panic!("expected Missing despite dynamic message, got {error:?}"),
    }
    for mode in common::RAW_MODES {
        match client.check(mode.into()).await.unwrap_err() {
            CallError::Application(FixtureError::Retry(body)) => {
                assert_eq!(mode, "raw");
                assert_eq!(body.message, "Retry after maintenance");
                assert_eq!(body.data.retry_after, 5.0);
            }
            CallError::Application(FixtureError::Optional(body)) => {
                assert_eq!(body.message, "Optional diagnostic");
                assert_eq!(
                    body.data,
                    match mode {
                        "raw-absent" | "raw-null" => None,
                        "raw-value" => Some(serde_json::json!({"arbitrary": ["data"]})),
                        _ => panic!("unexpected optional mode {mode}"),
                    }
                );
            }
            CallError::Application(FixtureError::Union(body)) => {
                assert_eq!(body.message, "Union diagnostic");
                match (mode, body.data) {
                    ("raw-string", UnionData::Text(value)) => assert_eq!(value, "file"),
                    ("raw-number", UnionData::Number(value)) => assert_eq!(value, 5.0),
                    (mode, data) => panic!("{mode}: unexpected union data {data:?}"),
                }
            }
            error => panic!("{mode}: expected typed plain JSON-RPC error, got {error:?}"),
        }
    }
    for mode in common::UNHANDLED_MODES
        .into_iter()
        .chain(common::NONCOMPLIANT_MODES)
    {
        common::assert_generic_error(client.check(mode.into()).await.unwrap_err(), mode, 1000);
    }
    assert!(matches!(
        client.check("invalid-encoding".into()).await,
        Err(CallError::Generic(linkrpc::client::RpcCallError::Remote(
            JsonRpcError {
                code: error_codes::INTERNAL_ERROR,
                ..
            }
        )))
    ));
    let disconnected = client.check("disconnect".into()).await.unwrap_err();
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
