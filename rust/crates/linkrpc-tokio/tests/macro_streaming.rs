use std::sync::Arc;

use linkrpc::prelude::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct Command {
    amount: u32,
    next: Option<Box<Command>>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct Progress {
    value: u32,
    next: Option<Box<Progress>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
enum Control {
    Add(Command),
    Finish,
}

#[link_rpc_interface(id = "com.example.macro-streaming")]
trait StreamingService {
    #[input_stream(Control)]
    #[output_stream(Progress)]
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
        mut commands: StreamReceiver<Control>,
        progress: StreamSender<Progress>,
    ) -> Result<u32, JsonRpcError> {
        let mut value = initial + extra;
        while let Some(command) = commands.recv().await {
            match command {
                Control::Add(command) => {
                    value += command.amount;
                    progress
                        .send(Progress {
                            value,
                            next: Some(Box::new(Progress {
                                value: command.next.map_or(0, |next| next.amount),
                                next: None,
                            })),
                        })
                        .await?;
                }
                Control::Finish => return Ok(value),
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
    let schema = streaming_service::interface().to_schema();
    assert_eq!(
        schema.methods["exchange"].client_stream,
        Some(serde_json::json!({
            "$ref": "#/components/schemas/Control"
        }))
    );
    assert_eq!(
        schema.methods["exchange"].server_stream,
        Some(serde_json::json!({
            "$ref": "#/components/schemas/Progress"
        }))
    );
    let components = schema.components.unwrap().schemas.unwrap();
    assert!(components["Command"]
        .to_string()
        .contains(r##""$ref":"#/components/schemas/Command""##));
    assert!(components["Progress"]
        .to_string()
        .contains(r##""$ref":"#/components/schemas/Progress""##));

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
    commands
        .send(Control::Add(Command {
            amount: 5,
            next: Some(Box::new(Command {
                amount: 3,
                next: None,
            })),
        }))
        .await
        .unwrap();
    assert_eq!(
        progress.recv().await,
        Some(Progress {
            value: 16,
            next: Some(Box::new(Progress {
                value: 3,
                next: None,
            })),
        })
    );
    commands.send(Control::Finish).await.unwrap();
    assert_eq!(result.await.unwrap(), 16);
    assert_eq!(progress.recv().await, None);
}
