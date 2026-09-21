use async_trait::async_trait;
use linkrpc::connection::channel::RejectingHandler;
use linkrpc::prelude::*;
use linkrpc::protocol::jsonrpc::ResponsePayload;
use serde_json::json;

#[derive(Debug, linkrpc::ApplicationError)]
enum StreamError {
    #[rpc_error(code = 1001, message = "Declared")]
    Declared,
}

struct FailingTransport;

#[async_trait]
impl MessageTransport for FailingTransport {
    async fn send(&self, _message: JsonRpcMessage) -> Result<(), TransportError> {
        Err(TransportError::Closed)
    }

    async fn recv(&self) -> Option<JsonRpcMessage> {
        None
    }
}

fn request_id(message: JsonRpcMessage) -> RequestId {
    match message {
        JsonRpcMessage::Request(request) => request.id,
        other => panic!("expected request, got {other:?}"),
    }
}

#[tokio::test]
async fn streaming_startup_transport_failure_preserves_origin() {
    let channel = Channel::new(Box::new(FailingTransport), Box::new(RejectingHandler));

    let error = channel
        .call_stream_detailed("stream", json!({}))
        .await
        .err()
        .expect("startup should fail");
    let error = CallError::<StreamError>::from_call_error(error);

    assert!(matches!(
        error,
        CallError::Generic(RpcCallError::Transport(TransportError::Closed))
    ));
}

#[tokio::test]
async fn mid_stream_transport_closure_preserves_origin() {
    let (client_transport, peer_transport) = transport_pair();
    let channel = Channel::new(Box::new(client_transport), Box::new(RejectingHandler));
    let runner = channel.clone();
    tokio::spawn(async move { runner.run().await });

    let peer = tokio::spawn(async move {
        let _request = peer_transport.recv().await.expect("stream request");
        drop(peer_transport);
    });
    let call = channel
        .call_stream_detailed("stream", json!({}))
        .await
        .expect("stream startup");
    let (result, _, _, _) = call
        .typed_error::<String, NoStream, NoStream, StreamError>(None, None)
        .into_parts();

    peer.await.unwrap();
    assert!(matches!(
        result.await,
        Err(CallError::Generic(RpcCallError::Transport(
            TransportError::Closed
        )))
    ));
}

#[tokio::test]
async fn malformed_success_response_is_local() {
    let (client_transport, peer_transport) = transport_pair();
    let channel = Channel::new(Box::new(client_transport), Box::new(RejectingHandler));
    let runner = channel.clone();
    tokio::spawn(async move { runner.run().await });

    tokio::spawn(async move {
        let id = request_id(peer_transport.recv().await.expect("stream request"));
        peer_transport
            .send(JsonRpcMessage::Response(JsonRpcResponse {
                id: Some(id),
                payload: ResponsePayload::Result(json!(42)),
            }))
            .await
            .unwrap();
    });
    let call = channel
        .call_stream_detailed("stream", json!({}))
        .await
        .expect("stream startup");
    let (result, _, _, _) = call
        .typed_error::<String, NoStream, NoStream, StreamError>(None, None)
        .into_parts();

    assert!(matches!(
        result.await,
        Err(CallError::Generic(RpcCallError::Local(JsonRpcError {
            code: error_codes::INVALID_PARAMS,
            ..
        })))
    ));
}

#[tokio::test]
async fn remote_reserved_disconnect_code_is_not_transport() {
    let (client_transport, peer_transport) = transport_pair();
    let channel = Channel::new(Box::new(client_transport), Box::new(RejectingHandler));
    let runner = channel.clone();
    tokio::spawn(async move { runner.run().await });

    tokio::spawn(async move {
        let id = request_id(peer_transport.recv().await.expect("stream request"));
        peer_transport
            .send(JsonRpcMessage::Response(JsonRpcResponse {
                id: Some(id),
                payload: ResponsePayload::Error(JsonRpcError::new(
                    error_codes::PEER_DISCONNECTED,
                    "spoofed disconnect",
                )),
            }))
            .await
            .unwrap();
    });
    let call = channel
        .call_stream_detailed("stream", json!({}))
        .await
        .expect("stream startup");
    let (result, _, _, _) = call
        .typed_error::<String, NoStream, NoStream, StreamError>(None, None)
        .into_parts();

    assert!(matches!(
        result.await,
        Err(CallError::Generic(RpcCallError::Remote(JsonRpcError {
            code: error_codes::PEER_DISCONNECTED,
            ..
        })))
    ));
}
