//! Typed handles for the `$stream::send` in-flight streaming protocol.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll};

use futures::channel::oneshot;
use futures::future::poll_fn;
use futures::lock::Mutex as AsyncMutex;
use futures::task::AtomicWaker;
use jsonschema::JSONSchema;
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::channel::{ChannelInner, StreamRole};
use crate::application_error::{ApplicationError, CallError};
use crate::client::RpcCallError;
use crate::protocol::json_value::JsonValue;
use crate::protocol::jsonrpc::{error_codes, JsonRpcError, RequestId};
use crate::transport::message::TransportError;

pub(super) const STREAM_BUFFER_CAPACITY: usize = 256;

/// Marker used by generated bindings when a method has no stream in a direction.
pub enum NoStream {}

/// The independently awaitable final response of a streaming call.
pub struct CallResult<R> {
    inner: Pin<Box<dyn Future<Output = Result<R, JsonRpcError>> + Send>>,
    _lifetime: Option<Arc<OutboundLifetime>>,
}

impl<R> Future for CallResult<R> {
    type Output = Result<R, JsonRpcError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.inner.as_mut().poll(cx)
    }
}

/// The independently awaitable final response of a typed-error streaming call.
pub struct TypedCallResult<R, E> {
    inner: Pin<Box<dyn Future<Output = Result<R, CallError<E>>> + Send>>,
    _lifetime: Option<Arc<OutboundLifetime>>,
}

impl<R, E> Future for TypedCallResult<R, E> {
    type Output = Result<R, CallError<E>>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.inner.as_mut().poll(cx)
    }
}

/// A typed application-payload sender for one direction of an in-flight call.
pub struct StreamSender<T> {
    state: Arc<StreamState>,
    channel: Weak<ChannelInner>,
    dir: &'static str,
    lifetime: Option<Arc<OutboundLifetime>>,
    _marker: PhantomData<fn(T)>,
}

impl<T> Clone for StreamSender<T> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            channel: self.channel.clone(),
            dir: self.dir,
            lifetime: self.lifetime.clone(),
            _marker: PhantomData,
        }
    }
}

impl<T: Serialize> StreamSender<T> {
    pub async fn send(&self, value: T) -> Result<(), JsonRpcError> {
        let payload = serde_json::to_value(value).map_err(|e| {
            JsonRpcError::new(error_codes::INVALID_PARAMS, format!("stream payload: {e}"))
        })?;
        let channel = self.channel.upgrade().ok_or_else(disconnected)?;
        let result = channel
            .send_stream_payload(&self.state, self.dir, payload)
            .await;
        result
    }
}

/// A typed, single-consumer application-payload receiver.
pub struct StreamReceiver<T> {
    state: Arc<StreamState>,
    _lifetime: Option<Arc<OutboundLifetime>>,
    _marker: PhantomData<T>,
}

impl<T: DeserializeOwned> StreamReceiver<T> {
    pub async fn recv(&mut self) -> Option<T> {
        poll_fn(|cx| self.poll_recv(cx)).await
    }

    fn poll_recv(&self, cx: &mut Context<'_>) -> Poll<Option<T>> {
        loop {
            let next = {
                let mut inner = self.state.inner.lock().unwrap();
                if let Some(value) = inner.incoming.pop_front() {
                    Some(value)
                } else if inner.settled || inner.disposed {
                    return Poll::Ready(None);
                } else {
                    self.state.incoming_waker.register(cx.waker());
                    return Poll::Pending;
                }
            };
            let value = next.expect("checked above");
            if !self.state.payload_is_valid(&value) {
                continue;
            }
            if let Ok(value) = serde_json::from_value(value) {
                return Poll::Ready(Some(value));
            }
            // Like the TS typed boundary, malformed payloads are dropped.
        }
    }
}

/// Controls that are available for every in-flight request.
#[derive(Clone)]
pub struct CallControl {
    state: Arc<StreamState>,
    channel: Weak<ChannelInner>,
    role: StreamRole,
    _lifetime: Option<Arc<OutboundLifetime>>,
}

impl CallControl {
    pub fn request_id(&self) -> &RequestId {
        &self.state.id
    }

    pub async fn cancel(&self, reason: Option<String>) -> Result<(), JsonRpcError> {
        let channel = self.channel.upgrade().ok_or_else(disconnected)?;
        channel
            .send_stream_control(&self.state, "toCallee", "cancel", reason, None)
            .await
    }

    pub async fn ping(&self) -> Result<(), JsonRpcError> {
        let channel = self.channel.upgrade().ok_or_else(disconnected)?;
        channel
            .ping_state(&self.state, self.role.outbound_dir())
            .await
    }

    /// Stop tracking this call locally without notifying the peer.
    pub fn dispose(&self, reason: Option<String>) {
        self.state.dispose(reason);
        if let Some(channel) = self.channel.upgrade() {
            channel.remove_stream_state(self.role, &self.state.id);
        }
    }
}

/// Typed startup result for a streaming request.
pub struct StreamingCall<R, C, S> {
    result: CallResult<R>,
    sender: StreamSender<C>,
    receiver: StreamReceiver<S>,
    control: CallControl,
}

impl<R, C, S> StreamingCall<R, C, S> {
    pub fn into_parts(
        self,
    ) -> (
        CallResult<R>,
        StreamSender<C>,
        StreamReceiver<S>,
        CallControl,
    ) {
        (self.result, self.sender, self.receiver, self.control)
    }
}

/// Typed streaming handles whose final response preserves declared and origin-aware errors.
pub struct TypedStreamingCall<R, C, S, E> {
    result: TypedCallResult<R, E>,
    sender: StreamSender<C>,
    receiver: StreamReceiver<S>,
    control: CallControl,
}

impl<R, C, S, E> TypedStreamingCall<R, C, S, E> {
    pub fn into_parts(
        self,
    ) -> (
        TypedCallResult<R, E>,
        StreamSender<C>,
        StreamReceiver<S>,
        CallControl,
    ) {
        (self.result, self.sender, self.receiver, self.control)
    }
}

/// Untyped runtime startup handle. Generated clients immediately convert it with [`typed`](Self::typed).
pub struct RawStreamingCall {
    pub(super) state: Arc<StreamState>,
    pub(super) result: oneshot::Receiver<Result<JsonValue, RpcCallError>>,
    pub(super) channel: Weak<ChannelInner>,
    pub(super) lifetime: Arc<OutboundLifetime>,
}

impl RawStreamingCall {
    pub fn typed<R, C, S>(
        self,
        client_schema: Option<JsonValue>,
        server_schema: Option<JsonValue>,
    ) -> StreamingCall<R, C, S>
    where
        R: DeserializeOwned + Send + 'static,
    {
        self.state.set_incoming_schema(server_schema);
        let result = self.result;
        let lifetime = self.lifetime;
        let call_result = CallResult {
            inner: Box::pin(async move {
                let value = result
                    .await
                    .map_err(|_| disconnected())?
                    .map_err(rpc_call_error_into_json)?;
                serde_json::from_value(value).map_err(|e| {
                    JsonRpcError::new(
                        error_codes::INVALID_PARAMS,
                        format!("invalid response payload: {e}"),
                    )
                })
            }),
            _lifetime: Some(lifetime.clone()),
        };
        // The schema is authoritative at the receiving boundary. Retaining the client schema
        // here also makes declaration presence available to diagnostics and future send checks.
        self.state.set_outgoing_schema(client_schema);
        StreamingCall {
            result: call_result,
            sender: StreamSender::new_outbound(
                self.state.clone(),
                self.channel.clone(),
                "toCallee",
                lifetime.clone(),
            ),
            receiver: StreamReceiver::new_outbound(self.state.clone(), lifetime.clone()),
            control: CallControl::new_outbound(
                self.state,
                self.channel,
                StreamRole::Outbound,
                lifetime,
            ),
        }
    }

    /// Convert this raw call into typed streaming handles with a typed final error.
    pub fn typed_error<R, C, S, E>(
        self,
        client_schema: Option<JsonValue>,
        server_schema: Option<JsonValue>,
    ) -> TypedStreamingCall<R, C, S, E>
    where
        R: DeserializeOwned + Send + 'static,
        E: ApplicationError + 'static,
    {
        self.state.set_incoming_schema(server_schema);
        let result = self.result;
        let lifetime = self.lifetime;
        let call_result = TypedCallResult {
            inner: Box::pin(async move {
                let value = result
                    .await
                    .map_err(|_| {
                        CallError::Generic(RpcCallError::Transport(TransportError::Closed))
                    })?
                    .map_err(CallError::from_call_error)?;
                serde_json::from_value(value).map_err(|e| {
                    CallError::Generic(RpcCallError::Local(JsonRpcError::new(
                        error_codes::INVALID_PARAMS,
                        format!("invalid response payload: {e}"),
                    )))
                })
            }),
            _lifetime: Some(lifetime.clone()),
        };
        self.state.set_outgoing_schema(client_schema);
        TypedStreamingCall {
            result: call_result,
            sender: StreamSender::new_outbound(
                self.state.clone(),
                self.channel.clone(),
                "toCallee",
                lifetime.clone(),
            ),
            receiver: StreamReceiver::new_outbound(self.state.clone(), lifetime.clone()),
            control: CallControl::new_outbound(
                self.state,
                self.channel,
                StreamRole::Outbound,
                lifetime,
            ),
        }
    }
}

fn rpc_call_error_into_json(error: RpcCallError) -> JsonRpcError {
    match error {
        RpcCallError::Remote(error) | RpcCallError::Local(error) => error,
        RpcCallError::Transport(error) => {
            JsonRpcError::new(error_codes::PEER_DISCONNECTED, error.to_string())
        }
    }
}

pub(super) struct OutboundLifetime {
    state: Weak<StreamState>,
    channel: Weak<ChannelInner>,
    id: RequestId,
}

impl OutboundLifetime {
    pub(super) fn new(
        state: &Arc<StreamState>,
        channel: Weak<ChannelInner>,
        id: RequestId,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Arc::downgrade(state),
            channel,
            id,
        })
    }
}

impl Drop for OutboundLifetime {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            state.dispose(Some("all streaming handles dropped".into()));
        }
        if let Some(channel) = self.channel.upgrade() {
            channel.remove_stream_state(StreamRole::Outbound, &self.id);
        }
    }
}

#[derive(Default)]
struct StreamInner {
    incoming: VecDeque<JsonValue>,
    incoming_schema: Option<Option<Arc<JSONSchema>>>,
    outgoing_declared: bool,
    receiver_taken: bool,
    settled: bool,
    disposed: bool,
    cancelled: Option<Option<String>>,
    cancel_waiters: Vec<Option<oneshot::Sender<Option<String>>>>,
    dispose_reason: Option<String>,
    terminal_error: Option<JsonRpcError>,
    response_claimed: bool,
    result_sender: Option<oneshot::Sender<Result<JsonValue, RpcCallError>>>,
    ping_waiters: HashMap<String, oneshot::Sender<Result<(), JsonRpcError>>>,
}

pub(super) struct StreamState {
    pub(super) id: RequestId,
    inner: Mutex<StreamInner>,
    pub(super) send_gate: AsyncMutex<()>,
    incoming_waker: AtomicWaker,
}

// Stable slots let dropped select branches unregister without disturbing other waiters.
struct CancellationRegistration<'a> {
    state: &'a StreamState,
    slot: usize,
}

impl Drop for CancellationRegistration<'_> {
    fn drop(&mut self) {
        let mut inner = self.state.inner.lock().unwrap();
        if let Some(slot) = inner.cancel_waiters.get_mut(self.slot) {
            *slot = None;
        }
        while inner.cancel_waiters.last().is_some_and(Option::is_none) {
            inner.cancel_waiters.pop();
        }
    }
}

impl StreamState {
    pub(super) fn outbound(
        id: RequestId,
    ) -> (
        Arc<Self>,
        oneshot::Receiver<Result<JsonValue, RpcCallError>>,
    ) {
        let (tx, rx) = oneshot::channel();
        let state = Arc::new(Self {
            id,
            inner: Mutex::new(StreamInner {
                result_sender: Some(tx),
                ..StreamInner::default()
            }),
            send_gate: AsyncMutex::new(()),
            incoming_waker: AtomicWaker::new(),
        });
        (state, rx)
    }

    pub(super) fn inbound(id: RequestId) -> Arc<Self> {
        Arc::new(Self {
            id,
            inner: Mutex::new(StreamInner::default()),
            send_gate: AsyncMutex::new(()),
            incoming_waker: AtomicWaker::new(),
        })
    }

    pub(super) fn is_active(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        !inner.settled && !inner.disposed
    }

    pub(super) fn outgoing_declared(&self) -> bool {
        self.inner.lock().unwrap().outgoing_declared
    }

    pub(super) fn push_payload(&self, value: JsonValue) -> Result<(), JsonRpcError> {
        let mut inner = self.inner.lock().unwrap();
        if inner.settled || inner.disposed {
            return Ok(());
        }
        let valid = match &inner.incoming_schema {
            Some(Some(schema)) => schema.is_valid(&value),
            Some(None) => false,
            None => true,
        };
        if !valid {
            return Ok(());
        }
        if inner.incoming.len() >= STREAM_BUFFER_CAPACITY {
            let error = JsonRpcError::new(
                error_codes::INTERNAL_ERROR,
                "stream receive buffer overflow",
            );
            inner.terminal_error = Some(error.clone());
            let cleanup = Self::terminal_cleanup_locked(&mut inner, false);
            drop(inner);
            self.complete_cleanup(cleanup, Some(Err(RpcCallError::Local(error.clone()))));
            return Err(error);
        }
        inner.incoming.push_back(value);
        drop(inner);
        self.incoming_waker.wake();
        Ok(())
    }

    pub(super) fn cancel(&self, reason: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.cancelled.is_none() {
            inner.cancelled = Some(reason.clone());
        }
        let waiters = std::mem::take(&mut inner.cancel_waiters);
        drop(inner);
        for waiter in waiters.into_iter().flatten() {
            let _ = waiter.send(reason.clone());
        }
    }

    pub(super) async fn cancelled(&self) -> Option<String> {
        let (receiver, _registration) = {
            let mut inner = self.inner.lock().unwrap();
            if let Some(reason) = &inner.cancelled {
                return reason.clone();
            } else if inner.settled || inner.disposed {
                return None;
            } else {
                let (sender, receiver) = oneshot::channel();
                let slot = match inner.cancel_waiters.iter().position(Option::is_none) {
                    Some(slot) => {
                        inner.cancel_waiters[slot] = Some(sender);
                        slot
                    }
                    None => {
                        let slot = inner.cancel_waiters.len();
                        inner.cancel_waiters.push(Some(sender));
                        slot
                    }
                };
                (receiver, CancellationRegistration { state: self, slot })
            }
        };
        receiver.await.unwrap_or(None)
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.inner.lock().unwrap().cancelled.is_some()
    }

    pub(super) fn terminal_error(&self) -> Option<JsonRpcError> {
        self.inner.lock().unwrap().terminal_error.clone()
    }

    pub(super) fn claim_response(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.response_claimed {
            false
        } else {
            inner.response_claimed = true;
            true
        }
    }

    pub(super) fn settle(&self, result: Option<Result<JsonValue, JsonRpcError>>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.settled {
            return;
        }
        let cleanup = Self::terminal_cleanup_locked(&mut inner, false);
        drop(inner);
        self.complete_cleanup(
            cleanup,
            result.map(|result| result.map_err(RpcCallError::Local)),
        );
    }

    pub(super) fn settle_detailed(&self, result: Result<JsonValue, RpcCallError>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.settled {
            return;
        }
        let cleanup = Self::terminal_cleanup_locked(&mut inner, false);
        drop(inner);
        self.complete_cleanup(cleanup, Some(result));
    }

    pub(super) fn dispose(&self, reason: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        if inner.disposed {
            return;
        }
        inner.dispose_reason = reason;
        let cleanup = Self::terminal_cleanup_locked(&mut inner, true);
        drop(inner);
        self.complete_cleanup(
            cleanup,
            Some(Err(RpcCallError::Local(JsonRpcError::new(
                error_codes::CANCELLED,
                "streaming call disposed",
            )))),
        );
    }

    pub(super) fn disconnect(&self) {
        self.settle_detailed(Err(RpcCallError::Transport(TransportError::Closed)));
    }

    pub(super) fn add_ping(
        &self,
        nonce: String,
        sender: oneshot::Sender<Result<(), JsonRpcError>>,
    ) -> Result<(), JsonRpcError> {
        let mut inner = self.inner.lock().unwrap();
        if inner.settled || inner.disposed {
            return Err(JsonRpcError::new(
                error_codes::CANCELLED,
                "call is not active",
            ));
        }
        inner.ping_waiters.insert(nonce, sender);
        Ok(())
    }

    pub(super) fn remove_ping(&self, nonce: &str) {
        self.inner.lock().unwrap().ping_waiters.remove(nonce);
    }

    pub(super) fn pong(&self, nonce: &str) {
        if let Some(sender) = self.inner.lock().unwrap().ping_waiters.remove(nonce) {
            let _ = sender.send(Ok(()));
        }
    }

    pub(super) fn set_incoming_schema(&self, schema: Option<JsonValue>) {
        let compiled = schema.map(|schema| JSONSchema::compile(&schema).ok().map(Arc::new));
        let mut inner = self.inner.lock().unwrap();
        inner.incoming_schema = Some(compiled.flatten());
        let schema = inner.incoming_schema.clone();
        inner.incoming.retain(|value| match &schema {
            Some(Some(schema)) => schema.is_valid(value),
            Some(None) | None => false,
        });
    }

    pub(super) fn set_outgoing_schema(&self, schema: Option<JsonValue>) {
        self.inner.lock().unwrap().outgoing_declared = schema.is_some();
    }

    pub(super) fn register_receiver(&self, schema: JsonValue) -> Result<(), JsonRpcError> {
        let validator = JSONSchema::compile(&schema).map_err(|e| {
            JsonRpcError::new(
                error_codes::INVALID_PARAMS,
                format!("invalid stream schema: {e}"),
            )
        })?;
        let mut inner = self.inner.lock().unwrap();
        if inner.receiver_taken {
            return Err(JsonRpcError::new(
                error_codes::INTERNAL_ERROR,
                "stream receiver already taken",
            ));
        }
        inner.receiver_taken = true;
        let validator = Arc::new(validator);
        inner.incoming.retain(|value| validator.is_valid(value));
        inner.incoming_schema = Some(Some(validator));
        Ok(())
    }

    fn payload_is_valid(&self, value: &JsonValue) -> bool {
        let inner = self.inner.lock().unwrap();
        match &inner.incoming_schema {
            Some(Some(schema)) => schema.is_valid(value),
            Some(None) | None => false,
        }
    }

    fn wake_all(&self) {
        self.incoming_waker.wake();
    }

    fn terminal_cleanup_locked(inner: &mut StreamInner, disposed: bool) -> TerminalCleanup {
        inner.settled = true;
        inner.disposed |= disposed;
        TerminalCleanup {
            result_sender: inner.result_sender.take(),
            ping_waiters: std::mem::take(&mut inner.ping_waiters),
            cancel_waiters: std::mem::take(&mut inner.cancel_waiters),
        }
    }

    fn complete_cleanup(
        &self,
        cleanup: TerminalCleanup,
        result: Option<Result<JsonValue, RpcCallError>>,
    ) {
        if let (Some(sender), Some(result)) = (cleanup.result_sender, result) {
            let _ = sender.send(result);
        }
        for (_, waiter) in cleanup.ping_waiters {
            let _ = waiter.send(Err(JsonRpcError::new(
                error_codes::PEER_DISCONNECTED,
                "call terminated before pong arrived",
            )));
        }
        for waiter in cleanup.cancel_waiters.into_iter().flatten() {
            let _ = waiter.send(None);
        }
        self.wake_all();
    }
}

struct TerminalCleanup {
    result_sender: Option<oneshot::Sender<Result<JsonValue, RpcCallError>>>,
    ping_waiters: HashMap<String, oneshot::Sender<Result<(), JsonRpcError>>>,
    cancel_waiters: Vec<Option<oneshot::Sender<Option<String>>>>,
}

impl<T> StreamSender<T> {
    pub(super) fn new(
        state: Arc<StreamState>,
        channel: Weak<ChannelInner>,
        dir: &'static str,
    ) -> Self {
        Self {
            state,
            channel,
            dir,
            lifetime: None,
            _marker: PhantomData,
        }
    }

    fn new_outbound(
        state: Arc<StreamState>,
        channel: Weak<ChannelInner>,
        dir: &'static str,
        lifetime: Arc<OutboundLifetime>,
    ) -> Self {
        Self {
            state,
            channel,
            dir,
            lifetime: Some(lifetime),
            _marker: PhantomData,
        }
    }
}

impl<T> StreamReceiver<T> {
    pub(super) fn new(state: Arc<StreamState>) -> Self {
        Self {
            state,
            _lifetime: None,
            _marker: PhantomData,
        }
    }

    fn new_outbound(state: Arc<StreamState>, lifetime: Arc<OutboundLifetime>) -> Self {
        Self {
            state,
            _lifetime: Some(lifetime),
            _marker: PhantomData,
        }
    }
}

impl CallControl {
    fn new_outbound(
        state: Arc<StreamState>,
        channel: Weak<ChannelInner>,
        role: StreamRole,
        lifetime: Arc<OutboundLifetime>,
    ) -> Self {
        Self {
            state,
            channel,
            role,
            _lifetime: Some(lifetime),
        }
    }
}

pub(super) fn disconnected() -> JsonRpcError {
    JsonRpcError::new(error_codes::PEER_DISCONNECTED, "channel closed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_timer::Delay;
    use serde_json::json;
    use std::time::Duration;

    #[tokio::test]
    async fn materialized_component_refs_validate_recursion_and_closed_objects() {
        let state = StreamState::inbound(RequestId::Number(1));
        state
            .register_receiver(json!({
                "allOf": [{"$ref": "#/components/schemas/Command"}],
                "components": {
                    "schemas": {
                        "Command": {
                            "type": "object",
                            "properties": {
                                "amount": {"const": 1},
                                "next": {"$ref": "#/components/schemas/Command"}
                            },
                            "required": ["amount"],
                            "additionalProperties": false
                        }
                    }
                }
            }))
            .unwrap();
        let mut receiver = StreamReceiver::<JsonValue>::new(state.clone());
        state
            .push_payload(json!({"amount": 1, "next": {"amount": 1}}))
            .unwrap();
        state.push_payload(json!({"amount": 2})).unwrap();
        state
            .push_payload(json!({"amount": 1, "extra": true}))
            .unwrap();
        state.settle(None);

        assert_eq!(
            receiver.recv().await,
            Some(json!({"amount": 1, "next": {"amount": 1}}))
        );
        assert_eq!(receiver.recv().await, None);
    }

    #[tokio::test]
    async fn false_schema_drops_even_null_payloads() {
        let state = StreamState::inbound(RequestId::Number(1));
        state.register_receiver(JsonValue::Bool(false)).unwrap();
        let mut receiver = StreamReceiver::<JsonValue>::new(state.clone());
        state.push_payload(JsonValue::Null).unwrap();
        state.settle(None);
        assert_eq!(receiver.recv().await, None);
    }

    #[tokio::test]
    async fn invalid_payloads_do_not_consume_buffer_capacity() {
        let state = StreamState::inbound(RequestId::Number(1));
        state.register_receiver(JsonValue::Bool(false)).unwrap();
        for value in 0..(STREAM_BUFFER_CAPACITY * 2) {
            state.push_payload(json!(value)).unwrap();
        }
        assert!(state.inner.lock().unwrap().incoming.is_empty());
        assert!(state.is_active());
    }

    #[tokio::test]
    async fn installing_schema_prunes_invalid_buffered_payloads() {
        let state = StreamState::inbound(RequestId::Number(1));
        state.push_payload(json!("invalid")).unwrap();
        state.push_payload(json!(7)).unwrap();
        state.register_receiver(json!({"type": "integer"})).unwrap();
        state.settle(None);
        let mut receiver = StreamReceiver::<JsonValue>::new(state);
        assert_eq!(receiver.recv().await, Some(json!(7)));
        assert_eq!(receiver.recv().await, None);
    }

    #[tokio::test]
    async fn terminal_paths_complete_pending_ping_waiters() {
        for overflow in [false, true] {
            let state = StreamState::outbound(RequestId::Number(1)).0;
            let (sender, receiver) = oneshot::channel();
            state.add_ping("pending".into(), sender).unwrap();
            if overflow {
                state.register_receiver(JsonValue::Bool(true)).unwrap();
                for value in 0..STREAM_BUFFER_CAPACITY {
                    state.push_payload(json!(value)).unwrap();
                }
                assert!(state.push_payload(json!("overflow")).is_err());
            } else {
                state.dispose(Some("test".into()));
            }
            assert!(receiver.await.unwrap().is_err());
        }
    }

    #[tokio::test]
    async fn dropped_cancellation_futures_release_their_registrations() {
        let state = StreamState::inbound(RequestId::Number(1));
        for _ in 0..1024 {
            let mut waiter = Box::pin(state.cancelled());
            assert!(futures::poll!(waiter.as_mut()).is_pending());
            drop(waiter);
            assert!(state.inner.lock().unwrap().cancel_waiters.is_empty());
        }

        let mut active = Box::pin(state.cancelled());
        assert!(futures::poll!(active.as_mut()).is_pending());
        for _ in 0..1024 {
            let mut waiter = Box::pin(state.cancelled());
            assert!(futures::poll!(waiter.as_mut()).is_pending());
            drop(waiter);
            assert_eq!(state.inner.lock().unwrap().cancel_waiters.len(), 1);
        }
        state.cancel(Some("still registered".into()));
        assert_eq!(active.await.as_deref(), Some("still registered"));
        assert!(state.inner.lock().unwrap().cancel_waiters.is_empty());
    }

    #[tokio::test]
    async fn cancellation_registration_slots_are_reused_without_losing_waiters() {
        let state = StreamState::inbound(RequestId::Number(1));
        let mut first = Box::pin(state.cancelled());
        let mut second = Box::pin(state.cancelled());
        assert!(futures::poll!(first.as_mut()).is_pending());
        assert!(futures::poll!(second.as_mut()).is_pending());
        drop(first);
        let mut replacement = Box::pin(state.cancelled());
        assert!(futures::poll!(replacement.as_mut()).is_pending());
        assert_eq!(state.inner.lock().unwrap().cancel_waiters.len(), 2);
        state.cancel(Some("both".into()));
        let (second, replacement) = futures::join!(second, replacement);
        assert_eq!(second.as_deref(), Some("both"));
        assert_eq!(replacement.as_deref(), Some("both"));
    }

    #[tokio::test]
    async fn cancellation_is_broadcast_to_all_waiters() {
        let state = StreamState::inbound(RequestId::Number(1));
        let first = state.cancelled();
        let second = state.cancelled();
        let cancel = async {
            Delay::new(Duration::from_millis(1)).await;
            state.cancel(Some("because".into()));
        };
        let (first, second, ()) = futures::join!(first, second, cancel);
        assert_eq!(first.as_deref(), Some("because"));
        assert_eq!(second.as_deref(), Some("because"));

        let terminal = StreamState::inbound(RequestId::Number(2));
        let first = terminal.cancelled();
        let second = terminal.cancelled();
        let settle = async {
            Delay::new(Duration::from_millis(1)).await;
            terminal.settle(None);
        };
        let (first, second, ()) = futures::join!(first, second, settle);
        assert_eq!(first, None);
        assert_eq!(second, None);
    }
}
