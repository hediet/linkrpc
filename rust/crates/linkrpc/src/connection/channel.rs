//! `Channel`: correlates outbound requests with their responses and dispatches inbound
//! requests/notifications to a [`RequestHandler`]. Runtime-agnostic — the caller drives the
//! read loop by spawning [`Channel::run`] on whatever executor they use.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use async_trait::async_trait;
use futures::channel::oneshot;
use futures::stream::{FuturesUnordered, StreamExt};
use futures::FutureExt;
use futures_timer::Delay;

use crate::connection::dispatch::CallCtx;
use crate::connection::streaming::{OutboundLifetime, RawStreamingCall, StreamState};
use crate::protocol::json_value::JsonValue;
use crate::protocol::jsonrpc::{
    error_codes, JsonRpcError, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest,
    JsonRpcResponse, RequestId, ResponsePayload,
};
use crate::transport::message::MessageTransport;

/// Handles inbound requests and notifications arriving on a [`Channel`].
#[async_trait]
pub trait RequestHandler: Send + Sync {
    /// Handle an inbound request, producing a result or a JSON-RPC error.
    async fn handle_request(
        &self,
        method: String,
        params: JsonValue,
    ) -> Result<JsonValue, JsonRpcError>;

    /// Handle an inbound notification (no response is sent).
    async fn handle_notification(&self, _method: String, _params: JsonValue) {}

    async fn handle_request_with_context(
        &self,
        method: String,
        params: JsonValue,
        _ctx: CallCtx,
    ) -> Result<JsonValue, JsonRpcError> {
        self.handle_request(method, params).await
    }

    async fn handle_notification_with_context(
        &self,
        method: String,
        params: JsonValue,
        _ctx: CallCtx,
    ) {
        self.handle_notification(method, params).await
    }
}

/// A no-op handler that rejects every request with `methodNotFound`.
pub struct RejectingHandler;

#[async_trait]
impl RequestHandler for RejectingHandler {
    async fn handle_request(
        &self,
        method: String,
        _params: JsonValue,
    ) -> Result<JsonValue, JsonRpcError> {
        Err(JsonRpcError::new(
            error_codes::METHOD_NOT_FOUND,
            format!("method not found: {method}"),
        ))
    }
}

type PendingMap = Mutex<HashMap<RequestId, oneshot::Sender<Result<JsonValue, JsonRpcError>>>>;
type DispatchFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

pub(super) struct ChannelInner {
    pub(super) transport: Box<dyn MessageTransport>,
    handler: Box<dyn RequestHandler>,
    pending: PendingMap,
    outbound_streams: Mutex<HashMap<RequestId, Arc<StreamState>>>,
    inbound_streams: Mutex<HashMap<RequestId, Arc<StreamState>>>,
    next_id: AtomicI64,
    next_nonce: AtomicI64,
}

#[derive(Clone, Copy)]
pub(super) enum StreamRole {
    Outbound,
    Inbound,
}

impl StreamRole {
    pub(super) fn outbound_dir(self) -> &'static str {
        match self {
            StreamRole::Outbound => "toCallee",
            StreamRole::Inbound => "toCaller",
        }
    }
}

/// A bidirectional JSON-RPC channel over a single transport.
#[derive(Clone)]
pub struct Channel {
    inner: Arc<ChannelInner>,
}

impl Channel {
    pub fn new(transport: Box<dyn MessageTransport>, handler: Box<dyn RequestHandler>) -> Self {
        Channel {
            inner: Arc::new(ChannelInner {
                transport,
                handler,
                pending: Mutex::new(HashMap::new()),
                outbound_streams: Mutex::new(HashMap::new()),
                inbound_streams: Mutex::new(HashMap::new()),
                next_id: AtomicI64::new(1),
                next_nonce: AtomicI64::new(1),
            }),
        }
    }

    /// Issue a request and await its response.
    pub async fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, JsonRpcError> {
        let id = RequestId::Number(self.inner.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(id.clone(), tx);

        let request = JsonRpcMessage::Request(JsonRpcRequest {
            id: id.clone(),
            method: method.to_string(),
            params: Some(params),
        });
        if self.inner.transport.send(request).await.is_err() {
            self.inner.pending.lock().unwrap().remove(&id);
            return Err(JsonRpcError::new(
                error_codes::INTERNAL_ERROR,
                "transport closed before request was sent",
            ));
        }

        match rx.await {
            Ok(result) => result,
            Err(_) => Err(JsonRpcError::new(
                error_codes::PEER_DISCONNECTED,
                "channel closed before response arrived",
            )),
        }
    }

    /// Start a streaming request and return after the request has been sent.
    pub async fn call_stream(
        &self,
        method: &str,
        params: JsonValue,
    ) -> Result<RawStreamingCall, JsonRpcError> {
        let id = RequestId::Number(self.inner.next_id.fetch_add(1, Ordering::SeqCst));
        let (state, result) = StreamState::outbound(id.clone());
        self.inner
            .outbound_streams
            .lock()
            .unwrap()
            .insert(id.clone(), state.clone());
        let mut registration = StreamRegistration {
            channel: Arc::downgrade(&self.inner),
            id: id.clone(),
            armed: true,
        };
        let request = JsonRpcMessage::Request(JsonRpcRequest {
            id,
            method: method.to_string(),
            params: Some(params),
        });
        self.inner.transport.send(request).await.map_err(|_| {
            JsonRpcError::new(
                error_codes::INTERNAL_ERROR,
                "transport closed before request was sent",
            )
        })?;
        registration.armed = false;
        let lifetime =
            OutboundLifetime::new(&state, Arc::downgrade(&self.inner), registration.id.clone());
        Ok(RawStreamingCall {
            state,
            result,
            channel: Arc::downgrade(&self.inner),
            lifetime,
        })
    }

    /// Fire a notification (no response expected).
    pub async fn notify(&self, method: &str, params: JsonValue) -> Result<(), JsonRpcError> {
        let note = JsonRpcMessage::Notification(JsonRpcNotification {
            method: method.to_string(),
            params: Some(params),
        });
        self.inner
            .transport
            .send(note)
            .await
            .map_err(|_| JsonRpcError::new(error_codes::INTERNAL_ERROR, "transport closed"))
    }

    #[cfg(test)]
    fn outbound_stream_count(&self) -> usize {
        self.inner.outbound_streams.lock().unwrap().len()
    }

    /// Drive the inbound read loop until the transport closes. Spawn this on your executor.
    pub async fn run(&self) {
        let mut dispatches = FuturesUnordered::<DispatchFuture>::new();
        let mut receive = self.inner.transport.recv();
        let mut keepalive = Delay::new(Duration::from_secs(10 * 60)).fuse();
        loop {
            let dispatch = async {
                if dispatches.is_empty() {
                    futures::future::pending::<()>().await;
                } else {
                    let _ = dispatches.next().await;
                }
            }
            .fuse();
            futures::pin_mut!(dispatch);
            // Poll newly accepted handlers before reading the next wire frame. In particular,
            // this installs the declared stream schema before a queued payload is capacity
            // accounted, while inbound correlation was already registered synchronously.
            futures::select_biased! {
                _ = dispatch => {}
                message = receive.as_mut().fuse() => {
                    let Some(message) = message else {
                        break;
                    };
                    receive = self.inner.transport.recv();
                    self.accept_message(message, &mut dispatches);
                }
                _ = keepalive => {
                    self.queue_keepalives(&mut dispatches);
                    keepalive = Delay::new(Duration::from_secs(10 * 60)).fuse();
                }
            }
        }
        self.fail_all_pending();
    }

    fn accept_message(
        &self,
        message: JsonRpcMessage,
        dispatches: &mut FuturesUnordered<DispatchFuture>,
    ) {
        match message {
            JsonRpcMessage::Response(response) => self.resolve_response(response),
            JsonRpcMessage::Request(request) => {
                let state = StreamState::inbound(request.id.clone());
                self.inner
                    .inbound_streams
                    .lock()
                    .unwrap()
                    .insert(request.id.clone(), state.clone());
                let channel = self.clone();
                dispatches.push(Box::pin(async move {
                    channel.dispatch_request(request, state).await;
                }));
            }
            JsonRpcMessage::Notification(notification) => {
                if notification.method == "$stream::send" {
                    self.accept_stream_notification(notification, dispatches);
                    return;
                }
                let channel = self.clone();
                dispatches.push(Box::pin(async move {
                    let params = notification.params.unwrap_or(JsonValue::Null);
                    channel
                        .inner
                        .handler
                        .handle_notification_with_context(
                            notification.method,
                            params,
                            CallCtx::new(None),
                        )
                        .await;
                }));
            }
        }
    }

    fn resolve_response(&self, resp: JsonRpcResponse) {
        let Some(id) = resp.id else { return };
        let stream_state = {
            self.inner
                .outbound_streams
                .lock()
                .unwrap()
                .get(&id)
                .cloned()
        };
        if let Some(state) = stream_state {
            let result = match resp.payload {
                ResponsePayload::Result(v) => Ok(v),
                ResponsePayload::Error(e) => Err(e),
            };
            state.settle(Some(result));
            self.inner.outbound_streams.lock().unwrap().remove(&id);
            return;
        }
        let sender = self.inner.pending.lock().unwrap().remove(&id);
        if let Some(sender) = sender {
            let result = match resp.payload {
                ResponsePayload::Result(v) => Ok(v),
                ResponsePayload::Error(e) => Err(e),
            };
            let _ = sender.send(result);
        }
    }

    fn accept_stream_notification(
        &self,
        notification: JsonRpcNotification,
        dispatches: &mut FuturesUnordered<DispatchFuture>,
    ) {
        let Some(JsonValue::Object(params)) = notification.params else {
            return;
        };
        let Some(id) = params.get("requestId").and_then(request_id_from_value) else {
            return;
        };
        let Some(dir) = params.get("dir").and_then(JsonValue::as_str) else {
            return;
        };
        let (state, role) = match dir {
            "toCaller" => (
                self.inner
                    .outbound_streams
                    .lock()
                    .unwrap()
                    .get(&id)
                    .cloned(),
                StreamRole::Outbound,
            ),
            "toCallee" => (
                self.inner.inbound_streams.lock().unwrap().get(&id).cloned(),
                StreamRole::Inbound,
            ),
            _ => return,
        };
        let Some(state) = state else { return };

        if let Some(JsonValue::Object(control)) = params.get("control") {
            match control.get("type").and_then(JsonValue::as_str) {
                Some("cancel") if dir == "toCallee" => {
                    state.cancel(
                        control
                            .get("reason")
                            .and_then(JsonValue::as_str)
                            .map(str::to_owned),
                    );
                }
                Some("pong") => {
                    if let Some(nonce) = control.get("nonce").and_then(JsonValue::as_str) {
                        state.pong(nonce);
                    }
                }
                Some("ping") => {
                    if let Some(nonce) = control
                        .get("nonce")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned)
                    {
                        let channel = self.inner.clone();
                        let state = state.clone();
                        let opposite = if dir == "toCaller" {
                            "toCallee"
                        } else {
                            "toCaller"
                        };
                        dispatches.push(Box::pin(async move {
                            let _ = channel
                                .send_stream_control(&state, opposite, "pong", None, Some(nonce))
                                .await;
                        }));
                    }
                }
                _ => {}
            }
            return;
        }

        // Key presence is significant: `null` is a valid application payload.
        if let Some(payload) = params.get("payload").cloned() {
            if let Err(error) = state.push_payload(payload) {
                self.inner.remove_stream_state(role, &id);
                if matches!(role, StreamRole::Inbound) {
                    let channel = self.clone();
                    dispatches.push(Box::pin(async move {
                        channel.send_inbound_terminal_error(id, state, error).await;
                    }));
                }
            }
        }
    }

    fn queue_keepalives(&self, dispatches: &mut FuturesUnordered<DispatchFuture>) {
        let states: Vec<_> = self
            .inner
            .outbound_streams
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for state in states {
            let channel = self.inner.clone();
            dispatches.push(Box::pin(async move {
                let nonce = channel
                    .next_nonce
                    .fetch_add(1, Ordering::Relaxed)
                    .to_string();
                let _ = channel
                    .send_stream_control(&state, "toCallee", "ping", None, Some(nonce))
                    .await;
            }));
        }
    }

    async fn dispatch_request(&self, req: JsonRpcRequest, state: Arc<StreamState>) {
        let params = req.params.unwrap_or(JsonValue::Null);
        let ctx = CallCtx::with_stream(
            Some(req.id.clone()),
            state.clone(),
            Arc::downgrade(&self.inner),
        );
        let result = self
            .inner
            .handler
            .handle_request_with_context(req.method, params, ctx)
            .await;
        let _gate = state.send_gate.lock().await;
        if !state.claim_response() {
            return;
        }
        let result = state.terminal_error().map_or(result, Err);
        let payload = match result {
            Ok(v) => ResponsePayload::Result(v),
            Err(e) => ResponsePayload::Error(e),
        };
        let response = JsonRpcMessage::Response(JsonRpcResponse {
            id: Some(req.id.clone()),
            payload,
        });
        state.settle(None);
        self.inner.inbound_streams.lock().unwrap().remove(&req.id);
        let _ = self.inner.transport.send(response).await;
    }

    async fn send_inbound_terminal_error(
        &self,
        id: RequestId,
        state: Arc<StreamState>,
        error: JsonRpcError,
    ) {
        let _gate = state.send_gate.lock().await;
        if !state.claim_response() {
            return;
        }
        state.settle(None);
        self.inner.inbound_streams.lock().unwrap().remove(&id);
        let _ = self
            .inner
            .transport
            .send(JsonRpcMessage::Response(JsonRpcResponse {
                id: Some(id),
                payload: ResponsePayload::Error(error),
            }))
            .await;
    }

    fn fail_all_pending(&self) {
        let mut pending = self.inner.pending.lock().unwrap();
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(JsonRpcError::new(
                error_codes::PEER_DISCONNECTED,
                "channel closed",
            )));
        }
        drop(pending);
        let outbound: Vec<_> = self
            .inner
            .outbound_streams
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for state in outbound {
            state.disconnect();
        }
        self.inner.outbound_streams.lock().unwrap().clear();
        let inbound: Vec<_> = self
            .inner
            .inbound_streams
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for state in inbound {
            state.cancel(Some("clientDisconnected".into()));
            state.disconnect();
        }
        self.inner.inbound_streams.lock().unwrap().clear();
    }
}

impl ChannelInner {
    pub(super) async fn send_stream_payload(
        &self,
        state: &Arc<StreamState>,
        dir: &'static str,
        payload: JsonValue,
    ) -> Result<(), JsonRpcError> {
        let _gate = state.send_gate.lock().await;
        if !state.is_active() {
            return Err(JsonRpcError::new(
                error_codes::CANCELLED,
                "streaming call is no longer active",
            ));
        }
        if !state.outgoing_declared() {
            return Err(JsonRpcError::new(
                error_codes::INVALID_PARAMS,
                "this call does not declare an outbound application stream",
            ));
        }
        self.send_stream_message(state, dir, Some(payload), None, None, None)
            .await
    }

    pub(super) async fn send_stream_control(
        &self,
        state: &Arc<StreamState>,
        dir: &'static str,
        kind: &'static str,
        reason: Option<String>,
        nonce: Option<String>,
    ) -> Result<(), JsonRpcError> {
        let _gate = state.send_gate.lock().await;
        if !state.is_active() {
            return Err(JsonRpcError::new(
                error_codes::CANCELLED,
                "streaming call is no longer active",
            ));
        }
        self.send_stream_message(state, dir, None, Some(kind), reason, nonce)
            .await
    }

    async fn send_stream_message(
        &self,
        state: &Arc<StreamState>,
        dir: &'static str,
        payload: Option<JsonValue>,
        control: Option<&'static str>,
        reason: Option<String>,
        nonce: Option<String>,
    ) -> Result<(), JsonRpcError> {
        let mut params = serde_json::Map::new();
        params.insert("requestId".into(), request_id_to_value(&state.id));
        params.insert("dir".into(), JsonValue::String(dir.into()));
        if let Some(payload) = payload {
            params.insert("payload".into(), payload);
        }
        if let Some(kind) = control {
            let mut value = serde_json::Map::new();
            value.insert("type".into(), JsonValue::String(kind.into()));
            if let Some(reason) = reason {
                value.insert("reason".into(), JsonValue::String(reason));
            }
            if let Some(nonce) = nonce {
                value.insert("nonce".into(), JsonValue::String(nonce));
            }
            params.insert("control".into(), JsonValue::Object(value));
        }
        let result = self
            .transport
            .send(JsonRpcMessage::Notification(JsonRpcNotification {
                method: "$stream::send".into(),
                params: Some(JsonValue::Object(params)),
            }))
            .await;
        if result.is_err() {
            state.disconnect();
            let role = if dir == "toCallee" {
                StreamRole::Outbound
            } else {
                StreamRole::Inbound
            };
            self.remove_stream_state(role, &state.id);
            return Err(disconnected_error());
        }
        Ok(())
    }

    pub(super) async fn ping_state(
        &self,
        state: &Arc<StreamState>,
        dir: &'static str,
    ) -> Result<(), JsonRpcError> {
        let nonce = self.next_nonce.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = oneshot::channel();
        state.add_ping(nonce.clone(), tx)?;
        if let Err(error) = self
            .send_stream_control(state, dir, "ping", None, Some(nonce.clone()))
            .await
        {
            state.remove_ping(&nonce);
            return Err(error);
        }
        rx.await.unwrap_or_else(|_| Err(disconnected_error()))
    }

    pub(super) fn remove_stream_state(&self, role: StreamRole, id: &RequestId) {
        match role {
            StreamRole::Outbound => {
                self.outbound_streams.lock().unwrap().remove(id);
            }
            StreamRole::Inbound => {
                self.inbound_streams.lock().unwrap().remove(id);
            }
        }
    }
}

fn request_id_from_value(value: &JsonValue) -> Option<RequestId> {
    match value {
        JsonValue::Number(value) => value.as_i64().map(RequestId::Number),
        JsonValue::String(value) => Some(RequestId::String(value.clone())),
        _ => None,
    }
}

fn request_id_to_value(id: &RequestId) -> JsonValue {
    match id {
        RequestId::Number(value) => JsonValue::from(*value),
        RequestId::String(value) => JsonValue::String(value.clone()),
    }
}

fn disconnected_error() -> JsonRpcError {
    JsonRpcError::new(error_codes::PEER_DISCONNECTED, "channel closed")
}

struct StreamRegistration {
    channel: Weak<ChannelInner>,
    id: RequestId,
    armed: bool,
}

impl Drop for StreamRegistration {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(channel) = self.channel.upgrade() {
            let state = {
                channel
                    .outbound_streams
                    .lock()
                    .unwrap()
                    .get(&self.id)
                    .cloned()
            };
            if let Some(state) = state {
                state.dispose(Some("streaming startup cancelled".into()));
                channel.outbound_streams.lock().unwrap().remove(&self.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::streaming::NoStream;
    use crate::transport::memory::transport_pair;
    use serde_json::json;
    use std::time::Duration;

    struct Adder;

    #[async_trait]
    impl RequestHandler for Adder {
        async fn handle_request(
            &self,
            method: String,
            params: JsonValue,
        ) -> Result<JsonValue, JsonRpcError> {
            if method != "add" {
                return Err(JsonRpcError::new(error_codes::METHOD_NOT_FOUND, method));
            }
            let a = params["a"].as_i64().unwrap_or(0);
            let b = params["b"].as_i64().unwrap_or(0);
            Ok(json!(a + b))
        }
    }

    #[tokio::test]
    async fn call_round_trips_over_pair() {
        let (a, b) = transport_pair();
        let client = Channel::new(Box::new(a), Box::new(RejectingHandler));
        let server = Channel::new(Box::new(b), Box::new(Adder));

        let client_loop = client.clone();
        let server_loop = server.clone();
        tokio::spawn(async move { client_loop.run().await });
        tokio::spawn(async move { server_loop.run().await });

        let result = client.call("add", json!({ "a": 2, "b": 3 })).await.unwrap();
        assert_eq!(result, json!(5));
    }

    #[tokio::test]
    async fn unknown_method_errors() {
        let (a, b) = transport_pair();
        let client = Channel::new(Box::new(a), Box::new(RejectingHandler));
        let server = Channel::new(Box::new(b), Box::new(Adder));

        let server_loop = server.clone();
        let client_loop = client.clone();
        tokio::spawn(async move { server_loop.run().await });
        tokio::spawn(async move { client_loop.run().await });

        let err = client.call("nope", JsonValue::Null).await.unwrap_err();
        assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);
    }

    struct OutOfOrderHandler {
        slow_started: Mutex<Option<oneshot::Sender<()>>>,
        release_slow: Mutex<Option<oneshot::Receiver<()>>>,
    }

    #[async_trait]
    impl RequestHandler for OutOfOrderHandler {
        async fn handle_request(
            &self,
            method: String,
            _params: JsonValue,
        ) -> Result<JsonValue, JsonRpcError> {
            match method.as_str() {
                "slow" => {
                    if let Some(sender) = self.slow_started.lock().unwrap().take() {
                        let _ = sender.send(());
                    }
                    let receiver = self.release_slow.lock().unwrap().take().unwrap();
                    let _ = receiver.await;
                    Ok(json!("slow"))
                }
                "fast" => Ok(json!("fast")),
                _ => Err(JsonRpcError::new(error_codes::METHOD_NOT_FOUND, method)),
            }
        }
    }

    #[tokio::test]
    async fn later_request_can_respond_before_long_running_request() {
        let (client_transport, server_transport) = transport_pair();
        let client = Channel::new(Box::new(client_transport), Box::new(RejectingHandler));
        let (slow_started_tx, slow_started_rx) = oneshot::channel();
        let (release_slow_tx, release_slow_rx) = oneshot::channel();
        let server = Channel::new(
            Box::new(server_transport),
            Box::new(OutOfOrderHandler {
                slow_started: Mutex::new(Some(slow_started_tx)),
                release_slow: Mutex::new(Some(release_slow_rx)),
            }),
        );

        let client_loop = client.clone();
        let server_loop = server.clone();
        tokio::spawn(async move { client_loop.run().await });
        tokio::spawn(async move { server_loop.run().await });

        let slow_client = client.clone();
        let slow = tokio::spawn(async move { slow_client.call("slow", JsonValue::Null).await });
        slow_started_rx.await.unwrap();

        let fast =
            tokio::time::timeout(Duration::from_secs(1), client.call("fast", JsonValue::Null))
                .await
                .expect("fast request must not wait for the slow request")
                .unwrap();
        assert_eq!(fast, json!("fast"));

        let _ = release_slow_tx.send(());
        assert_eq!(slow.await.unwrap().unwrap(), json!("slow"));
    }

    struct StreamingHandler;

    #[async_trait]
    impl RequestHandler for StreamingHandler {
        async fn handle_request(
            &self,
            method: String,
            _params: JsonValue,
        ) -> Result<JsonValue, JsonRpcError> {
            Err(JsonRpcError::new(error_codes::METHOD_NOT_FOUND, method))
        }

        async fn handle_request_with_context(
            &self,
            method: String,
            _params: JsonValue,
            ctx: CallCtx,
        ) -> Result<JsonValue, JsonRpcError> {
            match method.as_str() {
                "stream" => {
                    let mut input = ctx.stream_receiver::<JsonValue>(json!({"type": "integer"}))?;
                    let output = ctx.stream_sender::<String>()?;
                    let value = input.recv().await.expect("input before settlement");
                    output.send(format!("event:{value}")).await?;
                    Ok(value)
                }
                "cancel" => {
                    let reason = ctx.cancelled().await;
                    Err(JsonRpcError {
                        code: error_codes::CANCELLED,
                        message: "cancelled".into(),
                        data: Some(json!({"reason": reason})),
                    })
                }
                _ => Err(JsonRpcError::new(error_codes::METHOD_NOT_FOUND, method)),
            }
        }
    }

    #[tokio::test]
    async fn typed_streams_drop_invalid_payloads_and_preserve_order() {
        let (client_transport, server_transport) = transport_pair();
        let client = Channel::new(Box::new(client_transport), Box::new(RejectingHandler));
        let server = Channel::new(Box::new(server_transport), Box::new(StreamingHandler));
        let client_loop = client.clone();
        let server_loop = server.clone();
        tokio::spawn(async move { client_loop.run().await });
        tokio::spawn(async move { server_loop.run().await });

        let raw = client.call_stream("stream", JsonValue::Null).await.unwrap();
        let call = raw.typed::<JsonValue, JsonValue, String>(
            Some(json!({"type": "integer"})),
            Some(json!({"type": "string"})),
        );
        let (result, sender, mut receiver, control) = call.into_parts();
        control.ping().await.unwrap();
        sender.send(json!("invalid")).await.unwrap();
        sender.send(json!(7)).await.unwrap();

        assert_eq!(receiver.recv().await.as_deref(), Some("event:7"));
        // Settlement is driven by Channel::run, not by polling CallResult: callers may
        // drain the server stream through EOF before awaiting the ordinary response.
        assert!(receiver.recv().await.is_none());
        assert_eq!(result.await.unwrap(), json!(7));
        assert!(sender.send(json!(8)).await.is_err());
    }

    #[tokio::test]
    async fn cancellation_reason_reaches_provider_and_final_error_reaches_caller() {
        let (client_transport, server_transport) = transport_pair();
        let client = Channel::new(Box::new(client_transport), Box::new(RejectingHandler));
        let server = Channel::new(Box::new(server_transport), Box::new(StreamingHandler));
        let client_loop = client.clone();
        let server_loop = server.clone();
        tokio::spawn(async move { client_loop.run().await });
        tokio::spawn(async move { server_loop.run().await });

        let call = client
            .call_stream("cancel", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, NoStream, NoStream>(None, None);
        let (result, _sender, _receiver, control) = call.into_parts();
        control.cancel(Some("test reason".into())).await.unwrap();
        let error = result.await.unwrap_err();
        assert_eq!(error.code, error_codes::CANCELLED);
        assert_eq!(error.data.unwrap()["reason"], json!("test reason"));
    }

    #[tokio::test]
    async fn equal_request_ids_in_opposite_directions_do_not_collide() {
        let (a_transport, b_transport) = transport_pair();
        let a = Channel::new(Box::new(a_transport), Box::new(StreamingHandler));
        let b = Channel::new(Box::new(b_transport), Box::new(StreamingHandler));
        let a_loop = a.clone();
        let b_loop = b.clone();
        tokio::spawn(async move { a_loop.run().await });
        tokio::spawn(async move { b_loop.run().await });

        // Both channels allocate request id 1. The explicit direction must select the
        // inbound table rather than the unrelated outbound call with the same id.
        let a_call = a
            .call_stream("stream", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, JsonValue, String>(
                Some(json!({"type": "integer"})),
                Some(json!({"type": "string"})),
            );
        let b_call = b
            .call_stream("stream", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, JsonValue, String>(
                Some(json!({"type": "integer"})),
                Some(json!({"type": "string"})),
            );
        let (a_result, a_sender, mut a_events, _) = a_call.into_parts();
        let (b_result, b_sender, mut b_events, _) = b_call.into_parts();
        a_sender.send(json!(11)).await.unwrap();
        b_sender.send(json!(22)).await.unwrap();

        assert_eq!(a_events.recv().await.as_deref(), Some("event:11"));
        assert_eq!(b_events.recv().await.as_deref(), Some("event:22"));
        assert_eq!(a_result.await.unwrap(), json!(11));
        assert_eq!(b_result.await.unwrap(), json!(22));
    }

    #[tokio::test]
    async fn outbound_registration_lives_exactly_as_long_as_user_handles() {
        let (transport, _peer) = transport_pair();
        let channel = Channel::new(Box::new(transport), Box::new(RejectingHandler));

        let raw = channel
            .call_stream("raw-drop", JsonValue::Null)
            .await
            .unwrap();
        assert_eq!(channel.outbound_stream_count(), 1);
        drop(raw);
        assert_eq!(channel.outbound_stream_count(), 0);

        let call = channel
            .call_stream("unsplit-drop", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, JsonValue, JsonValue>(Some(json!(true)), Some(json!(true)));
        assert_eq!(channel.outbound_stream_count(), 1);
        drop(call);
        assert_eq!(channel.outbound_stream_count(), 0);

        let call = channel
            .call_stream("result-only", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, JsonValue, JsonValue>(Some(json!(true)), Some(json!(true)));
        let (result, sender, receiver, control) = call.into_parts();
        drop(sender);
        drop(receiver);
        drop(control);
        assert_eq!(channel.outbound_stream_count(), 1);
        drop(result);
        assert_eq!(channel.outbound_stream_count(), 0);

        let call = channel
            .call_stream("receiver-only", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, JsonValue, JsonValue>(Some(json!(true)), Some(json!(true)));
        let (result, sender, receiver, control) = call.into_parts();
        drop((result, sender, control));
        assert_eq!(channel.outbound_stream_count(), 1);
        drop(receiver);
        assert_eq!(channel.outbound_stream_count(), 0);

        let call = channel
            .call_stream("sender-only", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, JsonValue, JsonValue>(Some(json!(true)), Some(json!(true)));
        let (result, sender, receiver, control) = call.into_parts();
        drop((result, receiver, control));
        assert_eq!(channel.outbound_stream_count(), 1);
        drop(sender);
        assert_eq!(channel.outbound_stream_count(), 0);

        let call = channel
            .call_stream("control-only", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, JsonValue, JsonValue>(Some(json!(true)), Some(json!(true)));
        let (result, sender, receiver, control) = call.into_parts();
        drop((result, sender, receiver));
        assert_eq!(channel.outbound_stream_count(), 1);
        drop(control);
        assert_eq!(channel.outbound_stream_count(), 0);

        let call = channel
            .call_stream("clones", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, JsonValue, JsonValue>(Some(json!(true)), Some(json!(true)));
        let (result, sender, receiver, control) = call.into_parts();
        let last_sender = sender.clone();
        let last_control = control.clone();
        drop((result, sender, receiver, control));
        assert_eq!(channel.outbound_stream_count(), 1);
        drop(last_sender);
        assert_eq!(channel.outbound_stream_count(), 1);
        drop(last_control);
        assert_eq!(channel.outbound_stream_count(), 0);

        let call = channel
            .call_stream("all-parts", JsonValue::Null)
            .await
            .unwrap()
            .typed::<JsonValue, JsonValue, JsonValue>(Some(json!(true)), Some(json!(true)));
        let parts = call.into_parts();
        assert_eq!(channel.outbound_stream_count(), 1);
        drop(parts);
        assert_eq!(channel.outbound_stream_count(), 0);
    }
}
