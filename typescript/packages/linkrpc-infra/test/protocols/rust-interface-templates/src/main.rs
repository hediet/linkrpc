use std::{env, sync::Arc, time::Duration};

use async_trait::async_trait;
use linkrpc::prelude::*;
use linkrpc_tokio::NdjsonTransport;

include!(concat!(env!("OUT_DIR"), "/contract.rs"));
use contract::*;

struct Provider;

#[async_trait]
impl InteropTemplatesService for Provider {
    async fn read_number(&self, _ctx: &CallCtx, value: f64) -> Result<f64, ReadNumberError> {
        if value < 0.0 {
            Err(ReadNumberError::Missing(value))
        } else {
            Ok(value + 1.0)
        }
    }

    async fn numbers_exchange(
        &self,
        _ctx: &CallCtx,
        initial: f64,
        mut input: StreamReceiver<f64>,
        output: StreamSender<f64>,
    ) -> Result<f64, RpcCallError> {
        let total = initial + input.recv().await.expect("one numeric input");
        output.send_detailed(total).await?;
        Ok(total)
    }
}

async fn client(connection: LinkRpcConnection) {
    let client = InteropTemplatesClient::new(connection);
    assert_eq!(client.read_number(4.0).await.unwrap(), 5.0);
    match client.read_number(-1.0).await.unwrap_err() {
        ReadNumberError::Missing(value) => assert_eq!(value, -1.0),
        other => panic!("expected Missing(number), got {other:?}"),
    }
    let (result, input, mut output, _) = client.numbers_exchange(10.0).await.unwrap().into_parts();
    input.send(5.0).await.unwrap();
    assert_eq!(output.recv().await.unwrap(), 15.0);
    assert_eq!(result.await.unwrap(), 15.0);
    assert!(output.recv().await.is_none());
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mode = env::args().nth(1).expect("export, server, or client");
    if mode == "export" {
        println!(
            "{}",
            serde_json::to_string(&interface().to_schema()).unwrap()
        );
        return;
    }
    let connection = LinkRpcConnection::new(Box::new(NdjsonTransport::new(
        tokio::io::stdin(),
        tokio::io::stdout(),
    )));
    match mode.as_str() {
        "server" => {
            connection
                .register_service(
                    Arc::new(InteropTemplatesServer::new(Arc::new(Provider))),
                    RegisterOptions::default(),
                )
                .unwrap();
            connection.run().await;
        }
        "client" => {
            let driver = connection.clone();
            tokio::spawn(async move { driver.run().await });
            tokio::time::timeout(Duration::from_secs(20), client(connection))
                .await
                .expect("generated template client timed out");
            // Tokio's blocking stdin reader cannot be cancelled while the TS
            // peer keeps its output open. All client assertions have completed.
            std::process::exit(0);
        }
        _ => panic!("unexpected mode {mode}"),
    }
}
