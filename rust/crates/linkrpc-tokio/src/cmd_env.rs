//! `cmd:` endpoints: spawn a child against a private local socket (Unix) or named pipe (Windows),
//! hand it the address and a random token through `LINKRPC_ENDPOINT` / `LINKRPC_TOKEN`, and accept
//! its authenticated dial-back. Mirrors the TS CLI's accept-one `cmd-env` transport
//! (`linkrpc-cli/src/commands/connectAsTransports.ts`).
//!
//! The child's stdout is forwarded to this process's stderr, so a parent that serves over stdio
//! keeps its own stdout clean. The child is killed when the transport is dropped, and the
//! connection closes when the child exits.
//!
//! Unlike the TS tunnel's root overlay, no hub helpers (`hubGrantedServiceId`, `identity::*`) are
//! served to the child: it sees a plain peer, so it should register at the root (registration mode
//! `all` or `root`).

use std::collections::BTreeMap;
use std::io;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use linkrpc::prelude::{
    format_endpoint_uri, EndpointCommand, FormatEndpointOptions, JsonRpcMessage, MessageTransport,
    ResolvedEndpoint, TransportError,
};
use tokio::process::Child;

use crate::connect::{ConnectError, LINKRPC_ENDPOINT_VAR, LINKRPC_TOKEN_VAR};
use crate::endpoint::Listener;

/// How long a `cmd:` child may take to dial back.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The accepted connection of a `cmd:` child, owning the child process.
pub struct CmdEnvTransport {
    inner: Box<dyn MessageTransport>,
    _child: Child,
}

impl CmdEnvTransport {
    /// Spawn `command` (with `env` added and `cwd` applied) and accept its dial-back.
    pub async fn spawn(
        command: &EndpointCommand,
        env: Option<&BTreeMap<String, String>>,
        cwd: Option<&str>,
    ) -> Result<Self, ConnectError> {
        let token = random_hex(16);
        let address = private_socket_address();
        let mut listener = Listener::bind_socket(&address)?;
        let endpoint = format_endpoint_uri(
            &ResolvedEndpoint::Socket {
                path: address,
                token: None,
            },
            FormatEndpointOptions::default(),
        );
        let spawned = crate::stdio::build_command(command, env, cwd).and_then(|mut built| {
            built
                .env(LINKRPC_ENDPOINT_VAR, &endpoint)
                .env(LINKRPC_TOKEN_VAR, &token)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .kill_on_drop(true)
                .spawn()
        });
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                listener.close();
                return Err(error.into());
            }
        };
        if let Some(mut stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let _ = tokio::io::copy(&mut stdout, &mut tokio::io::stderr()).await;
            });
        }
        let accepted = accept_child(&mut listener, &mut child, &token).await;
        listener.close();
        Ok(CmdEnvTransport {
            inner: accepted?,
            _child: child,
        })
    }
}

/// Accept connections until one passes the token check, the child exits, or the deadline passes.
async fn accept_child(
    listener: &mut Listener,
    child: &mut Child,
    token: &str,
) -> Result<Box<dyn MessageTransport>, ConnectError> {
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        let attempt = async {
            let pending = listener.accept().await.map_err(ConnectError::Io)?;
            Ok::<_, ConnectError>(pending.open(token).await)
        };
        tokio::select! {
            accepted = attempt => match accepted? {
                Ok(transport) => return Ok(transport),
                // Another local process dialed with a wrong token; keep waiting for the child.
                Err(_) => continue,
            },
            status = child.wait() => {
                let status = status?;
                return Err(ConnectError::Io(io::Error::other(format!(
                    "cmd: child exited ({status}) before connecting"
                ))));
            }
            _ = tokio::time::sleep_until(deadline) => {
                return Err(ConnectError::Io(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "cmd: timed out waiting for the child to connect",
                )));
            }
        }
    }
}

#[async_trait]
impl MessageTransport for CmdEnvTransport {
    async fn send(&self, message: JsonRpcMessage) -> Result<(), TransportError> {
        self.inner.send(message).await
    }

    async fn recv(&self) -> Option<JsonRpcMessage> {
        self.inner.recv().await
    }
}

#[cfg(windows)]
fn private_socket_address() -> String {
    format!(r"\\.\pipe\linkrpc-{}", random_hex(8))
}

#[cfg(not(windows))]
fn private_socket_address() -> String {
    std::env::temp_dir()
        .join(format!("linkrpc-{}.sock", random_hex(8)))
        .to_string_lossy()
        .into_owned()
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("the OS random number generator is available");
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}
