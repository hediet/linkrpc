//! NDJSON message framing over any async byte stream — the north-star transport.
//!
//! One JSON-RPC message per `\n`-delimited line (JSON itself never contains a raw newline, so a
//! line break is an unambiguous frame boundary). On hub socket connections, the dialing side
//! first sends the `hubrpc::initialize` request carrying the auth token
//! ([`NdjsonTransport::initialize`]) and the accepting side validates it
//! ([`NdjsonTransport::accept_initialize`]), matching the TS Unix-domain-socket / named-pipe
//! transport (`linkrpc/src/node/*`). The legacy `hello` [`Preamble`] remains available for
//! private links whose both ends use it.
//!
//! Framing is generic over the read/write halves, so the same [`NdjsonTransport`] drives a Unix
//! socket, a named pipe, a TCP connection, or an in-memory duplex pipe. Concrete socket
//! constructors live alongside; the Unix-socket ones are `#[cfg(unix)]`.

use std::io;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadHalf, WriteHalf,
};
use tokio::sync::Mutex;

use linkrpc::prelude::{
    error_codes, JsonRpcError, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, MessageTransport,
    RequestId, TransportError,
};
use linkrpc::protocol::jsonrpc::ResponsePayload;

/// The transport-level handshake method; never forwarded to a routed service.
pub const INITIALIZE_METHOD: &str = "hubrpc::initialize";
/// Accepted alias of [`INITIALIZE_METHOD`]; dialers send the canonical spelling.
pub const LINKRPC_INITIALIZE_METHOD_ALIAS: &str = "linkrpc::initialize";
/// The transport protocol version negotiated by `hubrpc::initialize`.
pub const INITIALIZE_PROTOCOL_VERSION: u32 = 1;
const INITIALIZE_REQUEST_ID: i64 = 0;
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);

type BoxRead = Box<dyn AsyncRead + Send + Unpin>;
type BoxWrite = Box<dyn AsyncWrite + Send + Unpin>;

/// The legacy `hello` preamble line, for private links whose both ends use it. Hub socket
/// connections use [`NdjsonTransport::initialize`] instead.
///
/// Serializes to `{"hello":1,"token":"…"}` (the `token` field is omitted when absent). The TS
/// hub treats an immediate socket close after this line as an auth failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preamble {
    /// Protocol marker; currently always `1`.
    pub hello: u32,
    /// Auth token, if the endpoint requires one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub token: Option<String>,
}

impl Preamble {
    /// A `hello: 1` preamble carrying `token` (or none).
    pub fn new(token: Option<String>) -> Self {
        Preamble { hello: 1, token }
    }
}

/// A newline-delimited JSON-RPC transport over a split async byte stream.
pub struct NdjsonTransport {
    reader: Mutex<BufReader<BoxRead>>,
    writer: Mutex<BoxWrite>,
}

impl NdjsonTransport {
    /// Build a transport from independent read and write halves.
    pub fn new<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        NdjsonTransport {
            reader: Mutex::new(BufReader::new(Box::new(reader) as BoxRead)),
            writer: Mutex::new(Box::new(writer) as BoxWrite),
        }
    }

    /// Build a transport from a single bidirectional stream (Unix socket, TCP, duplex pipe, …).
    pub fn from_stream<S>(stream: S) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (r, w): (ReadHalf<S>, WriteHalf<S>) = tokio::io::split(stream);
        NdjsonTransport::new(r, w)
    }

    /// Write the dialer's `hello` preamble. Call once, before any RPC.
    pub async fn write_preamble(&self, preamble: &Preamble) -> io::Result<()> {
        let line = serde_json::to_string(preamble).expect("preamble serializes");
        let mut w = self.writer.lock().await;
        w.write_all(line.as_bytes()).await?;
        w.write_all(b"\n").await?;
        w.flush().await
    }

    /// Read and parse the dialer's `hello` preamble (accepting side). Returns `Ok(None)` if the
    /// peer closed the connection before sending it.
    pub async fn read_preamble(&self) -> io::Result<Option<Preamble>> {
        let mut reader = self.reader.lock().await;
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(None);
        }
        let preamble = serde_json::from_str(line.trim_end_matches(['\n', '\r']))
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        Ok(Some(preamble))
    }

    /// Dialing side of the `hubrpc::initialize` handshake (spec 02-transport §1.1), as hubs
    /// require on socket connections. Call once, before any RPC.
    pub async fn initialize(&self, token: Option<String>) -> io::Result<()> {
        let mut params = json!({ "protocolVersion": INITIALIZE_PROTOCOL_VERSION });
        if let Some(token) = token {
            params["token"] = token.into();
        }
        self.send(JsonRpcMessage::Request(JsonRpcRequest {
            id: RequestId::Number(INITIALIZE_REQUEST_ID),
            method: INITIALIZE_METHOD.to_owned(),
            params: Some(params),
        }))
        .await
        .map_err(|e| io::Error::other(e.to_string()))?;
        let reply = tokio::time::timeout(INITIALIZE_TIMEOUT, self.recv())
            .await
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "hubrpc::initialize: handshake timed out",
                )
            })?;
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

    /// Accepting side of the `hubrpc::initialize` handshake: require it as the first message,
    /// reply, and return the dialer's token. A token `is_token_accepted` rejects gets an
    /// `unauthenticated` error reply and fails with `PermissionDenied`.
    pub async fn accept_initialize(
        &self,
        is_token_accepted: impl FnOnce(Option<&str>) -> bool,
    ) -> io::Result<Option<String>> {
        let request = match self.recv().await {
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
        self.send(JsonRpcMessage::Response(JsonRpcResponse {
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
}

#[async_trait]
impl MessageTransport for NdjsonTransport {
    async fn send(&self, msg: JsonRpcMessage) -> Result<(), TransportError> {
        let line = serde_json::to_string(&msg).map_err(|e| TransportError::Other(e.to_string()))?;
        let mut w = self.writer.lock().await;
        w.write_all(line.as_bytes()).await.map_err(map_io_err)?;
        w.write_all(b"\n").await.map_err(map_io_err)?;
        w.flush().await.map_err(map_io_err)
    }

    async fn recv(&self) -> Option<JsonRpcMessage> {
        let mut reader = self.reader.lock().await;
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).await.ok()?;
            if n == 0 {
                return None; // EOF
            }
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue; // tolerate blank keep-alive lines
            }
            match serde_json::from_str::<JsonRpcMessage>(trimmed) {
                Ok(msg) => return Some(msg),
                // A malformed line is unrecoverable mid-stream; close the transport.
                Err(_) => return None,
            }
        }
    }
}

fn map_io_err(e: io::Error) -> TransportError {
    if e.kind() == io::ErrorKind::BrokenPipe || e.kind() == io::ErrorKind::UnexpectedEof {
        TransportError::Closed
    } else {
        TransportError::Other(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use linkrpc::prelude::{JsonRpcNotification, RequestId};

    #[test]
    fn preamble_omits_absent_token() {
        let line = serde_json::to_string(&Preamble::new(None)).unwrap();
        assert_eq!(line, r#"{"hello":1}"#);
        let with = serde_json::to_string(&Preamble::new(Some("t".into()))).unwrap();
        assert_eq!(with, r#"{"hello":1,"token":"t"}"#);
    }

    #[tokio::test]
    async fn frames_multiple_messages_over_duplex() {
        let (a, b) = tokio::io::duplex(4096);
        let writer = NdjsonTransport::from_stream(a);
        let reader = NdjsonTransport::from_stream(b);

        for i in 0..3 {
            let note = JsonRpcMessage::Notification(JsonRpcNotification {
                method: "ping".to_string(),
                params: Some(serde_json::json!({ "n": i })),
            });
            writer.send(note).await.unwrap();
        }

        for i in 0..3 {
            match reader.recv().await.unwrap() {
                JsonRpcMessage::Notification(n) => {
                    assert_eq!(n.method, "ping");
                    assert_eq!(n.params.unwrap()["n"], i);
                }
                other => panic!("unexpected message: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn preamble_then_messages_share_one_reader() {
        let (a, b) = tokio::io::duplex(4096);
        let client = NdjsonTransport::from_stream(a);
        let server = NdjsonTransport::from_stream(b);

        client
            .write_preamble(&Preamble::new(Some("tok".into())))
            .await
            .unwrap();
        client
            .send(JsonRpcMessage::Request(linkrpc::prelude::JsonRpcRequest {
                id: RequestId::Number(1),
                method: "m".to_string(),
                params: None,
            }))
            .await
            .unwrap();

        let preamble = server.read_preamble().await.unwrap().unwrap();
        assert_eq!(preamble.token.as_deref(), Some("tok"));
        // The buffered RPC line after the preamble is still readable.
        match server.recv().await.unwrap() {
            JsonRpcMessage::Request(r) => assert_eq!(r.method, "m"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn initialize_handshake_passes_the_token() {
        let (a, b) = tokio::io::duplex(4096);
        let client = NdjsonTransport::from_stream(a);
        let server = NdjsonTransport::from_stream(b);

        let (dialed, accepted) = tokio::join!(
            client.initialize(Some("tok".into())),
            server.accept_initialize(|token| token == Some("tok")),
        );
        dialed.unwrap();
        assert_eq!(accepted.unwrap().as_deref(), Some("tok"));
    }

    #[tokio::test]
    async fn initialize_handshake_rejects_unaccepted_tokens() {
        let (a, b) = tokio::io::duplex(4096);
        let client = NdjsonTransport::from_stream(a);
        let server = NdjsonTransport::from_stream(b);

        let (dialed, accepted) = tokio::join!(
            client.initialize(Some("wrong".into())),
            server.accept_initialize(|token| token == Some("tok")),
        );
        let dialed = dialed.unwrap_err();
        assert_eq!(
            (dialed.kind(), dialed.to_string()),
            (
                io::ErrorKind::PermissionDenied,
                "hubrpc::initialize rejected: unauthenticated".to_owned()
            )
        );
        assert_eq!(
            accepted.unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }
}
