//! Unix-domain-socket constructors for the NDJSON transport (the north-star link).
//!
//! Dialing produces an [`NdjsonTransport`] ready for the caller to send its [`initialize`](NdjsonTransport::initialize) handshake;
//! accepting produces one ready for the server to [`accept_initialize`](NdjsonTransport::accept_initialize).
//! Both are thin wrappers over [`NdjsonTransport::from_stream`] — all framing lives there, so this
//! module is just socket plumbing.

use std::path::Path;

use tokio::net::{UnixListener, UnixStream};

use crate::ndjson::NdjsonTransport;

/// Dial a Unix socket and wrap it in an NDJSON transport. Send the `hubrpc::initialize` handshake before RPC.
pub async fn connect_unix(path: impl AsRef<Path>) -> std::io::Result<NdjsonTransport> {
    let stream = UnixStream::connect(path).await?;
    Ok(NdjsonTransport::from_stream(stream))
}

/// A Unix-socket listener that yields NDJSON transports per accepted connection.
pub struct UnixHubListener {
    listener: UnixListener,
}

impl UnixHubListener {
    /// Bind a listener at `path` (the path must not already exist).
    pub fn bind(path: impl AsRef<Path>) -> std::io::Result<Self> {
        Ok(UnixHubListener {
            listener: UnixListener::bind(path)?,
        })
    }

    /// Accept the next connection. Run [`accept_initialize`](NdjsonTransport::accept_initialize) before serving RPC.
    pub async fn accept(&self) -> std::io::Result<NdjsonTransport> {
        let (stream, _addr) = self.listener.accept().await?;
        Ok(NdjsonTransport::from_stream(stream))
    }
}
