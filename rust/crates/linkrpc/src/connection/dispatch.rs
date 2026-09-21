//! Server-side dispatch primitives: the per-call [`CallCtx`] handed to handlers, and the
//! [`InterfaceHandler`] trait an implementation registers for an interface.
//!
//! The macro's `serve()` adapter will generate an [`InterfaceHandler`] that decodes params into
//! typed Rust values and encodes results back to JSON; hand-written handlers implement it directly.

use async_trait::async_trait;
use std::sync::{Arc, Weak};

use crate::connection::channel::ChannelInner;
use crate::connection::interface_def::InterfaceDefinition;
use crate::connection::streaming::{StreamReceiver, StreamSender, StreamState};
use crate::protocol::json_value::JsonValue;
use crate::protocol::jsonrpc::{JsonRpcError, RequestId};

/// Per-call context passed to every handler invocation.
///
/// Carries the wire request id (for requests) and is the seam where attested caller identity and
/// a cancellation token will be attached in later milestones (see `docs/examples.md` §4).
#[derive(Clone, Default)]
pub struct CallCtx {
    request_id: Option<RequestId>,
    stream: Option<CallStreamContext>,
}

#[derive(Clone)]
struct CallStreamContext {
    state: Arc<StreamState>,
    channel: Weak<ChannelInner>,
}

impl CallCtx {
    pub fn new(request_id: Option<RequestId>) -> Self {
        CallCtx {
            request_id,
            stream: None,
        }
    }

    pub(super) fn with_stream(
        request_id: Option<RequestId>,
        state: Arc<StreamState>,
        channel: Weak<ChannelInner>,
    ) -> Self {
        Self {
            request_id,
            stream: Some(CallStreamContext { state, channel }),
        }
    }

    pub(crate) fn configure_streams(
        &self,
        client_schema: Option<JsonValue>,
        server_schema: Option<JsonValue>,
    ) {
        if let Some(stream) = &self.stream {
            stream.state.set_incoming_schema(client_schema);
            stream.state.set_outgoing_schema(server_schema);
        }
    }

    /// The wire request id, if this call is a request (notifications have none).
    pub fn request_id(&self) -> Option<&RequestId> {
        self.request_id.as_ref()
    }

    pub fn stream_receiver<T>(&self, schema: JsonValue) -> Result<StreamReceiver<T>, JsonRpcError> {
        let stream = self.stream.as_ref().ok_or_else(|| {
            JsonRpcError::new(
                crate::protocol::jsonrpc::error_codes::INTERNAL_ERROR,
                "streaming is unavailable for this call",
            )
        })?;
        stream.state.register_receiver(schema)?;
        Ok(StreamReceiver::new(stream.state.clone()))
    }

    pub fn stream_sender<T>(&self) -> Result<StreamSender<T>, JsonRpcError> {
        let stream = self.stream.as_ref().ok_or_else(|| {
            JsonRpcError::new(
                crate::protocol::jsonrpc::error_codes::INTERNAL_ERROR,
                "streaming is unavailable for this call",
            )
        })?;
        // Obtaining the typed sender is the declaration seam for hand-written handlers.
        stream
            .state
            .set_outgoing_schema(Some(JsonValue::Bool(true)));
        Ok(StreamSender::new(
            stream.state.clone(),
            stream.channel.clone(),
            "toCaller",
        ))
    }

    pub async fn cancelled(&self) -> Option<String> {
        match &self.stream {
            Some(stream) => stream.state.cancelled().await,
            None => None,
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.stream
            .as_ref()
            .is_some_and(|stream| stream.state.is_cancelled())
    }

    pub async fn ping(&self) -> Result<(), JsonRpcError> {
        let stream = self.stream.as_ref().ok_or_else(|| {
            JsonRpcError::new(
                crate::protocol::jsonrpc::error_codes::INTERNAL_ERROR,
                "streaming is unavailable for this call",
            )
        })?;
        let channel = stream.channel.upgrade().ok_or_else(|| {
            JsonRpcError::new(
                crate::protocol::jsonrpc::error_codes::PEER_DISCONNECTED,
                "channel closed",
            )
        })?;
        channel.ping_state(&stream.state, "toCaller").await
    }
}

/// The server-side implementation of one interface. Dispatches by local member name.
///
/// Implementors own param decoding / result encoding (and any application-level validation).
/// A request to an unknown member should return [`JsonRpcError`] with
/// [`crate::protocol::jsonrpc::error_codes::METHOD_NOT_FOUND`]; an unknown notification is dropped.
#[async_trait]
pub trait InterfaceHandler: Send + Sync {
    /// Handle a request member, returning the JSON result or a JSON-RPC error.
    async fn handle_request(
        &self,
        member: &str,
        params: JsonValue,
        ctx: CallCtx,
    ) -> Result<JsonValue, JsonRpcError>;

    /// Handle a notification member. Errors are swallowed (notifications have no response).
    async fn handle_notification(&self, _member: &str, _params: JsonValue, _ctx: CallCtx) {}

    /// Fallible notification dispatch for typed consumers outside a channel.
    ///
    /// Routers check membership before calling this. Generated adapters override
    /// it to return `false` for unknown members and retain typed decoding errors.
    /// Existing hand-written handlers keep their notification behavior.
    async fn dispatch_notification(
        &self,
        member: &str,
        params: JsonValue,
        ctx: CallCtx,
    ) -> Result<bool, JsonRpcError> {
        self.handle_notification(member, params, ctx).await;
        Ok(true)
    }
}

/// A handler that also knows its own [`InterfaceDefinition`].
///
/// The `#[link_rpc_interface]` macro implements this for the generated `…Server` adapter, letting
/// [`LinkRpcConnection::register_service`](crate::connection::hub_connection::LinkRpcConnection::register_service)
/// register an interface from its handler alone — no separate `interface()` argument.
pub trait ServiceExport: InterfaceHandler {
    /// The interface definition this handler serves (its content hash is the interface identity).
    fn interface() -> InterfaceDefinition
    where
        Self: Sized;
}
