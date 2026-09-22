#[allow(unused_variables)]
#[path = "codegen/generated_streaming.rs"]
mod generated;

use std::sync::Arc;

use generated::*;
use linkrpc::prelude::*;

struct Provider;

#[async_trait]
impl ComExampleGeneratedStreamingService for Provider {
    async fn exchange(
        &self,
        _ctx: &CallCtx,
        initial: u32,
        mut commands: StreamReceiver<Command>,
        events: StreamSender<Event>,
    ) -> Result<u32, JsonRpcError> {
        let command = commands.recv().await.expect("one command");
        let total = initial + command.amount;
        events.send(Event::new(EventKind::Progress, total)).await?;
        Ok(total)
    }

    async fn server_silent(
        &self,
        _ctx: &CallCtx,
        _events: StreamSender<NoStream>,
    ) -> Result<(), JsonRpcError> {
        Ok(())
    }
}

struct RawProvider;

impl ServiceExport for RawProvider {
    fn interface() -> InterfaceDefinition {
        generated::interface()
    }
}

#[async_trait]
impl InterfaceHandler for RawProvider {
    async fn handle_request(
        &self,
        member: &str,
        _params: JsonValue,
        ctx: CallCtx,
    ) -> Result<JsonValue, JsonRpcError> {
        let stream = ctx.stream_sender::<JsonValue>()?;
        match member {
            "exchange" => {
                stream
                    .send(serde_json::json!({ "kind": "wrong", "total": 1 }))
                    .await?;
                stream
                    .send(serde_json::json!({
                        "kind": "progress", "total": 2, "extra": true
                    }))
                    .await?;
                stream
                    .send(serde_json::json!({ "kind": "progress", "total": 7 }))
                    .await?;
                Ok(serde_json::json!(7))
            }
            "server_silent" => {
                stream.send(serde_json::json!("not-never")).await?;
                Ok(JsonValue::Null)
            }
            _ => Err(JsonRpcError::new(error_codes::METHOD_NOT_FOUND, member)),
        }
    }
}

#[tokio::test]
async fn generated_duplex_binding_runs_end_to_end() {
    let (client_transport, server_transport) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(client_transport));
    let server_connection = LinkRpcConnection::new(Box::new(server_transport));
    server_connection
        .register_service(
            Arc::new(ComExampleGeneratedStreamingServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();

    let client_driver = client_connection.clone();
    let server_driver = server_connection.clone();
    tokio::spawn(async move { client_driver.run().await });
    tokio::spawn(async move { server_driver.run().await });

    let client = ComExampleGeneratedStreamingClient::new(client_connection);
    let (result, commands, mut events, _control) = client.exchange(10).await.unwrap().into_parts();
    commands.send(Command::new(5)).await.unwrap();
    assert_eq!(events.recv().await.unwrap().total, 15);
    assert_eq!(result.await.unwrap(), 15);
    assert!(events.recv().await.is_none());
}

#[test]
fn generated_interface_preserves_false_stream_schema() {
    let schema = generated::interface().to_schema();
    assert_eq!(
        schema.methods["server_silent"].server_stream,
        Some(serde_json::Value::Bool(false))
    );
}

#[tokio::test]
async fn generated_client_validates_literal_and_closed_stream_schemas() {
    let (client_transport, server_transport) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(client_transport));
    let server_connection = LinkRpcConnection::new(Box::new(server_transport));
    server_connection
        .register_service(Arc::new(RawProvider), RegisterOptions::default())
        .unwrap();
    let client_driver = client_connection.clone();
    let server_driver = server_connection.clone();
    tokio::spawn(async move { client_driver.run().await });
    tokio::spawn(async move { server_driver.run().await });

    let client = ComExampleGeneratedStreamingClient::new(client_connection);
    let (result, _, mut events, _) = client.exchange(0).await.unwrap().into_parts();
    let event = events.recv().await.unwrap();
    assert!(matches!(event.kind, EventKind::Progress));
    assert_eq!(event.total, 7);
    assert_eq!(result.await.unwrap(), 7);

    let (result, _, _never, _) = client.server_silent().await.unwrap().into_parts();
    result.await.unwrap();
}

#[tokio::test]
async fn generated_server_validates_recursive_component_stream_schema() {
    let (client_transport, server_transport) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(client_transport));
    let server_connection = LinkRpcConnection::new(Box::new(server_transport));
    server_connection
        .register_service(
            Arc::new(ComExampleGeneratedStreamingServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();
    let client_driver = client_connection.clone();
    let server_driver = server_connection.clone();
    tokio::spawn(async move { client_driver.run().await });
    tokio::spawn(async move { server_driver.run().await });

    let raw = RpcCall::call_stream(
        &client_connection,
        "com.example.generated-streaming::exchange",
        serde_json::json!({ "initial": 10 }),
    )
    .await
    .unwrap();
    let (result, commands, _events, _) = raw
        .typed::<u32, JsonValue, JsonValue>(
            Some(JsonValue::Bool(true)),
            Some(JsonValue::Bool(true)),
        )
        .into_parts();
    commands
        .send(serde_json::json!({
            "amount": 1,
            "next": { "amount": "not-an-integer" }
        }))
        .await
        .unwrap();
    commands
        .send(serde_json::json!({ "amount": 5 }))
        .await
        .unwrap();
    assert_eq!(result.await.unwrap(), 15);
}

#[test]
fn generated_streaming_fixture_has_no_codegen_drift() {
    let schema: LinkRpcInterfaceSchema =
        serde_json::from_str(include_str!("codegen/streaming_interface.json")).unwrap();
    let generated = linkrpc::schema::codegen::generate_rust_interface(
        &schema,
        &linkrpc::schema::codegen::GenerateRustOptions {
            generate_server: true,
            ..Default::default()
        },
    );
    assert!(generated.unsupported.is_empty());
    assert!(generated.code.contains("#[input_stream(Command)]"));
    assert!(generated
        .code
        .contains(r##"\"clientStream\":{\"$ref\":\"#/components/schemas/Command\"}"##));
    assert_eq!(
        generated.code.replace("\r\n", "\n"),
        include_str!("codegen/generated_streaming.rs").replace("\r\n", "\n")
    );
}
