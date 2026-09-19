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
            "missing" => Err(CallError::Application(CheckError::Code2001(
                CheckError2001Data::new("file".into()),
            ))),
            "busy" => Err(CallError::Application(CheckError::Code2002)),
            "nullable" => Err(CallError::Application(CheckError::Code2003(None))),
            "numeric" => Err(CallError::Application(CheckError::Code2005(42.5))),
            "invalid-encoding" => Err(CallError::Application(CheckError::Code2005(f64::NAN))),
            "recursive" => Err(CallError::Application(CheckError::Code2004(
                MethodCheckSchemaError3D2004Root::new(
                    "root".into(),
                    vec![MethodCheckSchemaError3D2004Root::new("leaf".into(), vec![])],
                ),
            ))),
            mode => Err(CallError::Remote(common::remote_error(mode, 2000))),
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
        CallError::Application(CheckError::Code2001(data)) => assert_eq!(data.resource, "file"),
        error => panic!("expected declared Missing, got {error:?}"),
    }
    assert!(matches!(
        client.check(CheckParams::new("busy".into())).await,
        Err(CallError::Application(CheckError::Code2002))
    ));
    assert!(matches!(
        client.check(CheckParams::new("nullable".into())).await,
        Err(CallError::Application(CheckError::Code2003(None)))
    ));
    match client
        .check(CheckParams::new("recursive".into()))
        .await
        .unwrap_err()
    {
        CallError::Application(CheckError::Code2004(data)) => {
            assert_eq!(data.label, "root");
            assert_eq!(data.children[0].label, "leaf");
        }
        error => panic!("expected declared Recursive, got {error:?}"),
    }
    assert!(matches!(
        client.check(CheckParams::new("numeric".into())).await,
        Err(CallError::Application(CheckError::Code2005(value))) if value == 42.5
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
        match client
            .check(CheckParams::new(mode.into()))
            .await
            .unwrap_err()
        {
            CallError::Remote(error) => assert_eq!(error, common::remote_error(mode, 2000)),
            error => panic!("{mode}: expected original generic error, got {error:?}"),
        }
    }
    assert!(matches!(
        client
            .check(CheckParams::new("invalid-encoding".into()))
            .await,
        Err(CallError::Remote(JsonRpcError {
            code: error_codes::INTERNAL_ERROR,
            ..
        }))
    ));
    let disconnected = client
        .check(CheckParams::new("disconnect".into()))
        .await
        .unwrap_err();
    assert!(
        matches!(
            disconnected,
            CallError::Transport(linkrpc::transport::message::TransportError::Closed)
        ),
        "transport closure must not masquerade as a remote error: {disconnected:?}",
    );
}

#[cfg(typed_error_negative_test)]
fn wrong_generated_payload() {
    let _ = CheckError::Code2001("not the generated data struct");
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
