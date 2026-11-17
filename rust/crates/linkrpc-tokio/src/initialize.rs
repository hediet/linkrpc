//! The transport-level `hubrpc::initialize` handshake (spec 02-transport §1.1), shared by every
//! transport that authenticates in band: NDJSON sockets and WebSockets alike. Mirrors the TS
//! `runInitializeHandshake` (`linkrpc/src/transport/initialize.ts`).

use std::io;
use std::time::Duration;

use serde_json::json;

use linkrpc::prelude::{
    error_codes, JsonRpcError, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, MessageTransport,
    RequestId,
};
use linkrpc::protocol::jsonrpc::ResponsePayload;

/// The transport-level handshake method; never forwarded to a routed service.
pub const INITIALIZE_METHOD: &str = "hubrpc::initialize";
/// Accepted alias of [`INITIALIZE_METHOD`]; dialers send the canonical spelling.
pub const LINKRPC_INITIALIZE_METHOD_ALIAS: &str = "linkrpc::initialize";
/// The transport protocol version negotiated by `hubrpc::initialize`.
pub const INITIALIZE_PROTOCOL_VERSION: u32 = 1;
const INITIALIZE_REQUEST_ID: i64 = 0;
pub(crate) const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);

/// Dialing side: send `hubrpc::initialize` carrying `token` and await the reply. Call once,
/// before any RPC.
pub async fn initialize_client(
    transport: &dyn MessageTransport,
    token: Option<String>,
) -> io::Result<()> {
    let mut params = json!({ "protocolVersion": INITIALIZE_PROTOCOL_VERSION });
    if let Some(token) = token {
        params["token"] = token.into();
    }
    transport
        .send(JsonRpcMessage::Request(JsonRpcRequest {
            id: RequestId::Number(INITIALIZE_REQUEST_ID),
            method: INITIALIZE_METHOD.to_owned(),
            params: Some(params),
        }))
        .await
        .map_err(|e| io::Error::other(e.to_string()))?;
    let reply = tokio::time::timeout(INITIALIZE_TIMEOUT, transport.recv())
        .await
        .map_err(|_| timed_out())?;
    match reply {
        Some(JsonRpcMessage::Response(JsonRpcResponse {
            id: Some(RequestId::Number(INITIALIZE_REQUEST_ID)),
            payload,
        })) => match payload {
            ResponsePayload::Result(_) => Ok(()),
            ResponsePayload::Error(error) => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("hubrpc::initialize rejected: {}", error.message),
            )),
        },
        Some(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "hubrpc::initialize: unexpected reply to handshake",
        )),
        None => Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "hubrpc::initialize: transport closed during handshake",
        )),
    }
}

/// Accepting side: require `hubrpc::initialize` as the first message (within the handshake
/// timeout), reply, and return the dialer's token. A token `is_token_accepted` rejects gets an
/// `unauthenticated` error reply and fails with `PermissionDenied`.
pub async fn accept_initialize(
    transport: &dyn MessageTransport,
    is_token_accepted: impl FnOnce(Option<&str>) -> bool,
) -> io::Result<Option<String>> {
    let first = tokio::time::timeout(INITIALIZE_TIMEOUT, transport.recv())
        .await
        .map_err(|_| timed_out())?;
    let request = match first {
        Some(JsonRpcMessage::Request(request))
            if request.method == INITIALIZE_METHOD
                || request.method == LINKRPC_INITIALIZE_METHOD_ALIAS =>
        {
            request
        }
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "hubrpc::initialize: expected initialize as the first message",
            ))
        }
        None => {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "hubrpc::initialize: transport closed before the handshake",
            ))
        }
    };
    let token = request
        .params
        .as_ref()
        .and_then(|params| params.get("token"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let accepted = is_token_accepted(token.as_deref());
    let payload = if accepted {
        ResponsePayload::Result(json!({ "protocolVersion": INITIALIZE_PROTOCOL_VERSION }))
    } else {
        ResponsePayload::Error(JsonRpcError::new(
            error_codes::INVALID_REQUEST,
            "unauthenticated",
        ))
    };
    transport
        .send(JsonRpcMessage::Response(JsonRpcResponse {
            id: Some(request.id),
            payload,
        }))
        .await
        .map_err(|e| io::Error::other(e.to_string()))?;
    if !accepted {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "hubrpc::initialize: unauthenticated",
        ));
    }
    Ok(token)
}

/// Compare a presented token against the expected one without an early exit on the first
/// differing byte.
pub(crate) fn token_matches(expected: &str, candidate: Option<&str>) -> bool {
    let Some(candidate) = candidate else {
        return false;
    };
    let (expected, candidate) = (expected.as_bytes(), candidate.as_bytes());
    expected.len() == candidate.len()
        && expected
            .iter()
            .zip(candidate)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn timed_out() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "hubrpc::initialize: handshake timed out",
    )
}
