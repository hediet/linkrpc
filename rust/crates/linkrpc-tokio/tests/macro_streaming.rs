use std::sync::Arc;

use linkrpc::prelude::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
enum Command {
    Add(u32),
    Finish,
}

#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct Progress(u32);

#[link_rpc_interface(id = "com.example.macro-streaming")]
trait StreamingService {
    #[outgoing_stream(Command)]
    #[incoming_stream(Progress)]
    async fn exchange(stream_receiver: u32, stream_sender: u32) -> Result<u32, JsonRpcError>;
}

struct Provider;

#[async_trait]
impl StreamingService for Provider {
    async fn exchange(
        &self,
        _ctx: &CallCtx,
        initial: u32,
        extra: u32,
        mut commands: StreamReceiver<Command>,
        progress: StreamSender<Progress>,
    ) -> Result<u32, JsonRpcError> {
        let mut value = initial + extra;
        while let Some(command) = commands.recv().await {
            match command {
                Command::Add(amount) => {
                    value += amount;
                    progress.send(Progress(value)).await?;
                }
                Command::Finish => return Ok(value),
            }
        }
        Err(JsonRpcError::new(
            error_codes::CANCELLED,
            "missing application-level Finish command",
        ))
    }
}

#[tokio::test]
async fn macro_duplex_streams_are_typed_end_to_end() {
    let (client_transport, server_transport) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(client_transport));
    let server_connection = LinkRpcConnection::new(Box::new(server_transport));
    server_connection
        .register_service(
            Arc::new(StreamingServiceServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();

    let client_driver = client_connection.clone();
    let server_driver = server_connection.clone();
    tokio::spawn(async move { client_driver.run().await });
    tokio::spawn(async move { server_driver.run().await });

    let call = StreamingServiceClient::new(client_connection)
        .exchange(10, 1)
        .await
        .unwrap();
    let (result, commands, mut progress, _control) = call.into_parts();
    commands.send(Command::Add(5)).await.unwrap();
    assert_eq!(progress.recv().await, Some(Progress(16)));
    commands.send(Command::Finish).await.unwrap();
    assert_eq!(result.await.unwrap(), 16);
    assert_eq!(progress.recv().await, None);
}
