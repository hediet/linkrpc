//! Env-var connector: resolve `LINKRPC_ENDPOINT` / `LINKRPC_TOKEN`, open the right transport, and
//! wrap it in a [`LinkRpcConnection`] — the participant side of M6 (`node/hubClient.ts`).
//!
//! [`connect_to_hub`] is the entrypoint. Token precedence follows the TS CLI:
//! `endpoint_token ?? token-from-URI ?? LINKRPC_TOKEN ?? ""` (the legacy `HUBRPC_ENDPOINT` /
//! `HUBRPC_TOKEN` pair is used only when `LINKRPC_ENDPOINT` is unset; the families are not mixed).
//! Socket and WebSocket endpoints send the `hubrpc::initialize` handshake carrying the token before
//! any RPC. `cmd-stdio:` endpoints spawn the child and speak NDJSON over its stdio (see
//! [`crate::stdio`]); `cmd:` endpoints spawn the child against a private socket and accept its
//! dial-back (see [`crate::cmd_env`]).

use std::future::Future;
use std::time::Duration;

use linkrpc::prelude::{parse_endpoint_uri, EndpointError, LinkRpcConnection, ResolvedEndpoint};

use crate::endpoint::{BoxError, HubEnvironment};
use crate::ws::connect_ws;

/// The env var naming the hub endpoint URI.
pub const LINKRPC_ENDPOINT_VAR: &str = "LINKRPC_ENDPOINT";
/// The env var carrying the auth token (optional; defaults to `""`).
pub const LINKRPC_TOKEN_VAR: &str = "LINKRPC_TOKEN";

/// Options for [`connect_to_hub`]. Empty fields fall back to the environment.
#[derive(Debug, Clone, Default)]
pub struct ConnectOptions {
    /// Overrides `LINKRPC_ENDPOINT` when set.
    pub endpoint: Option<String>,
    /// Explicit token (the CLI `--endpoint-token`); highest precedence when set.
    pub endpoint_token: Option<String>,
    /// Overrides `LINKRPC_TOKEN` when set (mostly for testing).
    pub linkrpc_token: Option<String>,
}

/// Errors raised while resolving or opening a hub connection.
#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    /// `LINKRPC_ENDPOINT` was neither passed nor set in the environment.
    #[error("{LINKRPC_ENDPOINT_VAR} is not set; cannot connect to linkrpc hub.")]
    EndpointNotSet,
    /// The endpoint URI failed to parse.
    #[error("{0}")]
    Endpoint(#[from] EndpointError),
    /// The endpoint kind or option is not supported by the Rust runtime.
    #[error("endpoint kind '{0}' is not supported by the Rust connector")]
    Unsupported(&'static str),
    /// The endpoint configuration is invalid for the requested mode (for example a listener
    /// without a token, or `listen:wss:`).
    #[error("{0}")]
    Invalid(String),
    /// Underlying I/O failure while dialing, listening, handshaking, or spawning a child.
    #[error("connect failed: {0}")]
    Io(#[from] std::io::Error),
    /// Underlying WebSocket failure while dialing.
    #[error("websocket connect failed: {0}")]
    Ws(String),
    /// The application's connection setup failed.
    #[error("{0}")]
    Setup(BoxError),
}

/// A resolved endpoint plus the final auth token (after applying precedence).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConnection {
    /// The parsed endpoint.
    pub endpoint: ResolvedEndpoint,
    /// The token to authenticate with (possibly empty).
    pub token: String,
}

/// Resolve the endpoint + token from options and the environment, without opening a connection.
///
/// Token precedence: `endpoint_token ?? token-from-URI ?? LINKRPC_TOKEN ?? ""`.
pub fn resolve_connection(options: &ConnectOptions) -> Result<ResolvedConnection, ConnectError> {
    let environment = HubEnvironment::read();
    let endpoint_str = options
        .endpoint
        .clone()
        .or(environment.endpoint)
        .filter(|s| !s.is_empty())
        .ok_or(ConnectError::EndpointNotSet)?;

    let endpoint = parse_endpoint_uri(&endpoint_str)?;

    let uri_token = match &endpoint {
        ResolvedEndpoint::Socket { token, .. } | ResolvedEndpoint::Ws { token, .. } => {
            token.clone()
        }
        _ => None,
    };
    let environment_token = options.linkrpc_token.clone().or(environment.token);

    let token = options
        .endpoint_token
        .clone()
        .or(uri_token)
        .or(environment_token)
        .unwrap_or_default();

    Ok(ResolvedConnection { endpoint, token })
}

/// Resolve the endpoint, open the transport, and return a ready [`LinkRpcConnection`].
///
/// The caller is responsible for driving the connection's run loop (e.g.
/// `tokio::spawn(async move { conn.run().await })`) and registering interfaces. For `cmd:` and
/// `cmd-stdio:` endpoints the spawned child lives as long as the connection.
pub async fn connect_to_hub(options: ConnectOptions) -> Result<LinkRpcConnection, ConnectError> {
    let ResolvedConnection { endpoint, token } = resolve_connection(&options)?;

    match endpoint {
        ResolvedEndpoint::Socket { path, .. } => {
            let transport = connect_socket(&path, &token).await?;
            Ok(LinkRpcConnection::new(Box::new(transport)))
        }
        ResolvedEndpoint::Ws { url, .. } => {
            let transport = connect_ws(&url, &token)
                .await
                .map_err(|e| ConnectError::Ws(e.to_string()))?;
            Ok(LinkRpcConnection::new(Box::new(transport)))
        }
        ResolvedEndpoint::CmdStdio { command, env, cwd } => {
            let transport = crate::stdio::ChildStdioTransport::spawn_in(
                &command,
                env.as_ref(),
                cwd.as_deref(),
            )?;
            Ok(LinkRpcConnection::new(Box::new(transport)))
        }
        ResolvedEndpoint::CmdEnv {
            provision_slot: Some(_),
            ..
        } => Err(ConnectError::Unsupported("cmd: with provisionSlot")),
        ResolvedEndpoint::CmdEnv {
            command, env, cwd, ..
        } => {
            let transport =
                crate::cmd_env::CmdEnvTransport::spawn(&command, env.as_ref(), cwd.as_deref())
                    .await?;
            Ok(LinkRpcConnection::new(Box::new(transport)))
        }
    }
}

/// How [`connect_to_env_endpoint`] retries while the hub's listener comes up.
#[derive(Debug, Clone, Copy)]
pub struct RetryOptions {
    /// Total number of dial attempts (must be at least 1).
    pub attempts: u32,
    /// Delay between attempts.
    pub delay: Duration,
}

impl Default for RetryOptions {
    /// 50 attempts, 20 ms apart (~1 s total) — enough to cover a hub that is still binding.
    fn default() -> Self {
        RetryOptions {
            attempts: 50,
            delay: Duration::from_millis(20),
        }
    }
}

/// Connect to the hub named by `LINKRPC_ENDPOINT` / `LINKRPC_TOKEN`, then hand the ready connection
/// to `serve`.
///
/// This wraps the common participant boilerplate — read the env, dial (retrying while the listener
/// comes up), and pass a live [`LinkRpcConnection`] to your setup — so a server is just:
///
/// ```no_run
/// # use std::sync::Arc;
/// # use linkrpc_tokio::connect_to_env_endpoint;
/// # async fn run() {
/// connect_to_env_endpoint(|conn| async move {
///     // conn.register_service(...).expect("register");
///     conn.enable_reflection();
///     conn.run().await;
/// })
/// .await
/// .expect("connect to hub");
/// # }
/// ```
///
/// `serve` owns the connection and is responsible for driving it (typically `conn.run().await`).
/// Uses [`ConnectOptions::default`] and [`RetryOptions::default`]; for explicit control use
/// [`connect_to_env_endpoint_with`].
pub async fn connect_to_env_endpoint<F, Fut>(serve: F) -> Result<(), ConnectError>
where
    F: FnOnce(LinkRpcConnection) -> Fut,
    Fut: Future<Output = ()>,
{
    connect_to_env_endpoint_with(ConnectOptions::default(), RetryOptions::default(), serve).await
}

/// Like [`connect_to_env_endpoint`], but with explicit [`ConnectOptions`] and [`RetryOptions`].
pub async fn connect_to_env_endpoint_with<F, Fut>(
    options: ConnectOptions,
    retry: RetryOptions,
    serve: F,
) -> Result<(), ConnectError>
where
    F: FnOnce(LinkRpcConnection) -> Fut,
    Fut: Future<Output = ()>,
{
    let attempts = retry.attempts.max(1);
    let mut last_err = None;
    let mut conn = None;
    for attempt in 0..attempts {
        match connect_to_hub(options.clone()).await {
            Ok(c) => {
                conn = Some(c);
                break;
            }
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < attempts {
                    tokio::time::sleep(retry.delay).await;
                }
            }
        }
    }
    let conn = conn.ok_or_else(|| last_err.expect("at least one attempt was made"))?;
    serve(conn).await;
    Ok(())
}

#[cfg(unix)]
pub(crate) async fn connect_socket(
    path: &str,
    token: &str,
) -> Result<crate::ndjson::NdjsonTransport, ConnectError> {
    let transport = crate::unix::connect_unix(path).await?;
    transport.initialize(Some(token.to_string())).await?;
    Ok(transport)
}

#[cfg(windows)]
pub(crate) async fn connect_socket(
    path: &str,
    token: &str,
) -> Result<crate::ndjson::NdjsonTransport, ConnectError> {
    let transport = crate::windows::connect_pipe(path).await?;
    transport.initialize(Some(token.to_string())).await?;
    Ok(transport)
}

#[cfg(not(any(unix, windows)))]
pub(crate) async fn connect_socket(
    _path: &str,
    _token: &str,
) -> Result<crate::ndjson::NdjsonTransport, ConnectError> {
    Err(ConnectError::Unsupported("socket"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use linkrpc::prelude::EndpointCommand;

    fn opts(
        endpoint: &str,
        endpoint_token: Option<&str>,
        linkrpc_token: Option<&str>,
    ) -> ConnectOptions {
        ConnectOptions {
            endpoint: Some(endpoint.to_string()),
            endpoint_token: endpoint_token.map(str::to_string),
            linkrpc_token: linkrpc_token.map(str::to_string),
        }
    }

    #[test]
    fn token_precedence_prefers_explicit_endpoint_token() {
        let r = resolve_connection(&opts(
            "unix:/tmp/x.sock?token=uri",
            Some("explicit"),
            Some("env"),
        ))
        .unwrap();
        assert_eq!(r.token, "explicit");
    }

    #[test]
    fn token_precedence_falls_back_to_uri_then_env() {
        let r = resolve_connection(&opts("unix:/tmp/x.sock?token=uri", None, Some("env"))).unwrap();
        assert_eq!(r.token, "uri");
        let r = resolve_connection(&opts("unix:/tmp/x.sock", None, Some("env"))).unwrap();
        assert_eq!(r.token, "env");
        let r = resolve_connection(&opts("unix:/tmp/x.sock", None, None)).unwrap();
        assert_eq!(r.token, "");
    }

    #[test]
    fn missing_endpoint_errors_with_ts_message() {
        let r = resolve_connection(&ConnectOptions {
            endpoint: Some(String::new()),
            ..Default::default()
        });
        assert_eq!(
            r.unwrap_err().to_string(),
            "LINKRPC_ENDPOINT is not set; cannot connect to linkrpc hub."
        );
    }

    #[tokio::test]
    async fn cmd_env_with_a_provision_slot_is_unsupported() {
        let result = connect_to_hub(opts("cmd:?command=run-hub&provisionSlot=s", None, None)).await;
        assert!(matches!(
            result,
            Err(ConnectError::Unsupported("cmd: with provisionSlot"))
        ));
    }

    #[tokio::test]
    async fn cmd_stdio_reports_spawn_failures() {
        let result = connect_to_hub(opts(
            "cmd-stdio:?argv=linkrpc-tokio-test-missing-binary.exe",
            None,
            None,
        ))
        .await;
        assert!(matches!(result, Err(ConnectError::Io(_))));

        let resolved = resolve_connection(&opts("cmd-stdio:?argv=a&argv=b", None, None)).unwrap();
        assert!(matches!(
            resolved.endpoint,
            ResolvedEndpoint::CmdStdio {
                command: EndpointCommand::Argv(_),
                ..
            }
        ));
    }
}
