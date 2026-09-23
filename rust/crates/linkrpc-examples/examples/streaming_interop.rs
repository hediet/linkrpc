//! Cross-language streaming fixture. See `interop/README.md`.
use std::sync::Arc;

use linkrpc::prelude::*;
use linkrpc_tokio::NdjsonTransport;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Command {
    Add { value: i64 },
    Finish,
}

#[link_rpc_interface(id = "dev.linkrpc.streaming-interop")]
trait StreamingInterop {
    #[input_stream(Command)]
    #[output_stream(Option<i64>)]
    async fn exchange(fail: bool) -> Result<i64, JsonRpcError>;

    #[output_stream(String)]
    async fn cancellable() -> Result<String, JsonRpcError>;
}

struct Service;

#[async_trait]
impl StreamingInterop for Service {
    async fn exchange(
        &self,
        ctx: &CallCtx,
        fail: bool,
        mut commands: StreamReceiver<Command>,
        events: StreamSender<Option<i64>>,
    ) -> Result<i64, JsonRpcError> {
        events.send(None).await?;
        ctx.ping().await?;
        let mut total = 0;
        while let Some(command) = commands.recv().await {
            match command {
                Command::Add { value } => {
                    total += value;
                    events.send(Some(total)).await?;
                }
                Command::Finish => {
                    events.send(Some(total)).await?;
                    if fail {
                        return Err(JsonRpcError {
                            code: 1234,
                            message: "expected failure".into(),
                            data: Some(serde_json::json!({ "total": total })),
                        });
                    }
                    return Ok(total);
                }
            }
        }
        Err(JsonRpcError::new(
            error_codes::PEER_DISCONNECTED,
            "input ended before Finish",
        ))
    }

    async fn cancellable(
        &self,
        ctx: &CallCtx,
        events: StreamSender<String>,
    ) -> Result<String, JsonRpcError> {
        events.send("ready".into()).await?;
        let reason = ctx.cancelled().await;
        Err(JsonRpcError::new(
            error_codes::CANCELLED,
            reason.unwrap_or_else(|| "cancelled".into()),
        ))
    }
}

async fn run_client(connection: LinkRpcConnection) -> Result<(), JsonRpcError> {
    let client = StreamingInteropClient::new(connection);
    for fail in [false, true] {
        let call = client.exchange(fail).await?;
        let (result, commands, mut events, control) = call.into_parts();
        assert_eq!(events.recv().await, Some(None));
        control.ping().await?;
        commands.send(Command::Add { value: 7 }).await?;
        commands.send(Command::Add { value: 5 }).await?;
        commands.send(Command::Finish).await?;
        let mut received = Vec::new();
        while let Some(event) = events.recv().await {
            received.push(event);
        }
        assert_eq!(received, vec![Some(7), Some(12), Some(12)]);
        if fail {
            let RpcCallError::Remote(error) = result.await.expect_err("final error") else {
                panic!("expected remote error");
            };
            assert_eq!(error.code, 1234);
            assert_eq!(error.data, Some(serde_json::json!({ "total": 12 })));
        } else {
            assert_eq!(result.await?, 12);
        }
        assert!(commands.send(Command::Finish).await.is_err());
    }
    let (result, _, mut events, control) = client.cancellable().await?.into_parts();
    assert_eq!(events.recv().await.as_deref(), Some("ready"));
    control.cancel(Some("interop cancellation".into())).await?;
    let RpcCallError::Remote(error) = result.await.expect_err("cancelled") else {
        panic!("expected remote cancellation");
    };
    assert_eq!(error.code, error_codes::CANCELLED);
    assert_eq!(error.message, "interop cancellation");
    assert_eq!(events.recv().await, None);
    Ok(())
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(run());
    // Tokio's stdin reader may still be blocking after the client finishes its assertions.
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
}

async fn run() {
    let mode = std::env::args().nth(1);
    if mode.as_deref() == Some("--schema") {
        println!(
            "{}",
            serde_json::to_string_pretty(&streaming_interop::interface().to_schema()).unwrap()
        );
        return;
    }
    let connection = LinkRpcConnection::new(Box::new(NdjsonTransport::new(
        tokio::io::stdin(),
        tokio::io::stdout(),
    )));
    if mode.as_deref() == Some("--client") {
        let driver = connection.clone();
        tokio::spawn(async move { driver.run().await });
        run_client(connection).await.expect("TypeScript peer");
    } else {
        connection
            .register_service(
                Arc::new(StreamingInteropServer::new(Arc::new(Service))),
                RegisterOptions::default(),
            )
            .unwrap();
        connection.enable_reflection();
        connection.run().await;
    }
}
