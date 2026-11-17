//! `start_endpoint`: one `LINKRPC_ENDPOINT` URI decides whether a process serves over stdio, dials
//! out, or listens — the Rust counterpart of the TS `startEndpoint`
//! (`linkrpc/src/node/endpoint.ts`).
//!
//! | Endpoint | Behavior |
//! | --- | --- |
//! | `stdio` / `stdio:` | Serve one connection over stdin/stdout (no handshake). |
//! | `unix:/path`, `npipe://./pipe/name`, bare path, `ws://…`, `wss://…` | Dial; present the token in `hubrpc::initialize`. |
//! | `listen:unix:/path`, `listen:npipe://./pipe/name`, `listen:ws://host:port/path` | Accept many peers; require the token in `hubrpc::initialize`. |
//!
//! `listen:` is a mode prefix over a dialable address, handled here rather than in the shared
//! endpoint parser (as in TS). Listeners require a nonempty token, reject `listen:wss:` (terminate
//! TLS outside), never unlink an occupied socket path, and report the bound endpoint without
//! credentials (with the assigned port for `:0`).

use std::collections::{HashSet, VecDeque};
use std::env;
use std::future::Future;
use std::io;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::future::BoxFuture;
use linkrpc::prelude::{
    format_endpoint_uri, parse_endpoint_uri, FormatEndpointOptions, JsonRpcMessage,
    LinkRpcConnection, MessageTransport, ResolvedEndpoint, TransportError,
};
use tokio::sync::{watch, Notify};

use crate::connect::{ConnectError, LINKRPC_ENDPOINT_VAR, LINKRPC_TOKEN_VAR};
use crate::initialize::{accept_initialize, token_matches};
use crate::ndjson::NdjsonTransport;
use crate::ws::{connect_ws, WebSocketTransport};

/// A boxed error from application setup code or a failed peer.
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

/// Receives listener peer failures (handshake, setup, transport). Must not panic.
pub type ErrorReporter = Arc<dyn Fn(BoxError) + Send + Sync>;

/// Where and how [`start_endpoint`] serves. Unset fields fall back to the environment.
#[derive(Clone, Default)]
pub struct EndpointOptions {
    /// Overrides `LINKRPC_ENDPOINT` (or the legacy `HUBRPC_ENDPOINT`). Prefix with `listen:` to
    /// accept rather than dial.
    pub endpoint: Option<String>,
    /// Overrides the URI's `?token=`, then the environment token. Required for listeners.
    pub token: Option<String>,
    /// Listener peer failures. Defaults to printing to stderr.
    pub on_error: Option<ErrorReporter>,
}

impl std::fmt::Debug for EndpointOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EndpointOptions")
            .field("endpoint", &self.endpoint)
            .field("token", &self.token.as_ref().map(|_| "***"))
            .field("on_error", &self.on_error.is_some())
            .finish()
    }
}

/// One peer connection handed to the `on_connection` callback of [`start_endpoint`].
///
/// The connection is already running: outbound calls work immediately, while inbound requests and
/// notifications stay queued until the callback returns (or [`resume_requests`](Self::resume_requests)
/// releases selected methods), so services registered during setup see every request.
#[derive(Clone)]
pub struct EndpointConnection {
    connection: LinkRpcConnection,
    control: Arc<ConnectionControl>,
}

impl EndpointConnection {
    /// The RPC connection to register services on and call the peer through.
    pub fn connection(&self) -> &LinkRpcConnection {
        &self.connection
    }

    /// Release queued and future requests for these methods before setup completes, for example a
    /// bootstrap method the peer calls while this side is still setting up. Notifications stay
    /// queued until all requests are released.
    pub fn resume_requests<I, S>(&self, methods: I)
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.control
            .resume(Some(methods.into_iter().map(Into::into)));
    }

    /// Release all queued inbound messages. [`start_endpoint`] does this once setup succeeds.
    pub fn resume_all_requests(&self) {
        self.control.resume(None::<std::iter::Empty<String>>);
    }

    /// Close the connection; pending calls are rejected.
    pub fn close(&self) {
        self.control.close();
    }

    /// Resolves once the connection has closed (peer disconnect or [`close`](Self::close)) and its
    /// pending calls were rejected.
    pub async fn closed(&self) {
        wait_true(&self.control.finished).await;
    }

    /// Whether the connection has closed.
    pub fn is_closed(&self) -> bool {
        *self.control.finished.borrow()
    }

    fn open(transport: Box<dyn MessageTransport>) -> Self {
        let control = Arc::new(ConnectionControl::new(Arc::from(transport)));
        let connection = LinkRpcConnection::new(Box::new(GatedTransport {
            control: control.clone(),
            pending: tokio::sync::Mutex::new(None),
        }));
        let run = connection.clone();
        let finished = control.clone();
        tokio::spawn(async move {
            run.run().await;
            finished.close();
            finished.finished.send_replace(true);
        });
        EndpointConnection {
            connection,
            control,
        }
    }
}

/// A running endpoint. Dropping it (or calling [`close`](Self::close)) shuts it down.
pub struct StartedEndpoint {
    endpoint: String,
    lifecycle: Arc<Lifecycle>,
}

impl StartedEndpoint {
    /// The dialable bound address without credentials (including an assigned port), or `stdio:`.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Stop accepting and close every connection.
    pub fn close(&self) {
        self.lifecycle.shutdown.send_replace(true);
    }

    /// Resolves after shutdown: a listener once [`close`](Self::close) was called (or the listener
    /// failed) and every peer finished; a single connection once it closed.
    pub async fn closed(&self) {
        let mut active = self.lifecycle.active.subscribe();
        let _ = active.wait_for(|count| *count == 0).await;
    }
}

impl Drop for StartedEndpoint {
    fn drop(&mut self) {
        self.close();
    }
}

impl std::fmt::Debug for StartedEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartedEndpoint")
            .field("endpoint", &self.endpoint)
            .finish()
    }
}

/// Start this process's RPC endpoint as selected by `options` (or `LINKRPC_ENDPOINT`).
///
/// `on_connection` runs once per peer and installs services; its `Ok` value is kept alive until
/// that peer disconnects, so return a guard to tie per-connection resources to it. Startup and,
/// for stdio and dialed endpoints, `on_connection` failures are returned. A listener isolates
/// failed peers, reports them through [`EndpointOptions::on_error`], and keeps accepting.
pub async fn start_endpoint<F, Fut, G>(
    options: EndpointOptions,
    on_connection: F,
) -> Result<StartedEndpoint, ConnectError>
where
    F: Fn(EndpointConnection) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<G, BoxError>> + Send + 'static,
    G: Send + 'static,
{
    let on_connection = Arc::new(on_connection);
    let lifecycle = Arc::new(Lifecycle::new(options.on_error.clone()));
    match resolve_start_mode(&options)? {
        StartMode::Stdio => {
            let transport = NdjsonTransport::new(tokio::io::stdin(), tokio::io::stdout());
            start_single(
                "stdio:".to_owned(),
                Box::new(transport),
                lifecycle,
                on_connection,
            )
            .await
        }
        StartMode::Dial { target, token } => {
            let endpoint = format_without_token(&target);
            let transport = dial(&target, &token).await?;
            start_single(endpoint, transport, lifecycle, on_connection).await
        }
        StartMode::Listen { target, token } => {
            listen(target, token, lifecycle, on_connection).await
        }
    }
}

enum StartMode {
    Stdio,
    Dial {
        target: ResolvedEndpoint,
        token: String,
    },
    Listen {
        target: ResolvedEndpoint,
        token: String,
    },
}

const LISTEN_PREFIX: &str = "listen:";

fn resolve_start_mode(options: &EndpointOptions) -> Result<StartMode, ConnectError> {
    let environment = HubEnvironment::read();
    let configured = options
        .endpoint
        .clone()
        .or(environment.endpoint)
        .filter(|endpoint| !endpoint.trim().is_empty())
        .ok_or(ConnectError::EndpointNotSet)?;
    let configured = configured.trim();
    if configured == "stdio" || configured == "stdio:" {
        return Ok(StartMode::Stdio);
    }
    let (listening, address) = match configured.strip_prefix(LISTEN_PREFIX) {
        Some(address) => (true, address),
        None => (false, configured),
    };
    let target = parse_endpoint_uri(address)?;
    let uri_token = match &target {
        ResolvedEndpoint::Socket { token, .. } | ResolvedEndpoint::Ws { token, .. } => {
            token.clone()
        }
        _ => {
            return Err(ConnectError::Invalid(
                "start_endpoint supports stdio, socket, and LinkRPC WebSocket endpoints only."
                    .to_owned(),
            ))
        }
    };
    let token = options
        .token
        .clone()
        .or(uri_token)
        .or(environment.token)
        .unwrap_or_default();
    if !listening {
        return Ok(StartMode::Dial { target, token });
    }
    if token.is_empty() {
        return Err(ConnectError::Invalid(
            "Listening endpoints require a nonempty token.".to_owned(),
        ));
    }
    Ok(StartMode::Listen { target, token })
}

/// `LINKRPC_ENDPOINT`/`LINKRPC_TOKEN`, or the legacy `HUBRPC_*` pair when only
/// `HUBRPC_ENDPOINT` is set. The two families are never mixed.
pub(crate) struct HubEnvironment {
    pub(crate) endpoint: Option<String>,
    pub(crate) token: Option<String>,
}

impl HubEnvironment {
    pub(crate) fn read() -> Self {
        let var = |name: &str| env::var(name).ok();
        if let Some(endpoint) = var(LINKRPC_ENDPOINT_VAR) {
            return HubEnvironment {
                endpoint: Some(endpoint),
                token: var(LINKRPC_TOKEN_VAR),
            };
        }
        if let Some(endpoint) = var(LEGACY_ENDPOINT_VAR) {
            return HubEnvironment {
                endpoint: Some(endpoint),
                token: var(LEGACY_TOKEN_VAR),
            };
        }
        HubEnvironment {
            endpoint: None,
            token: var(LINKRPC_TOKEN_VAR).or_else(|| var(LEGACY_TOKEN_VAR)),
        }
    }
}

const LEGACY_ENDPOINT_VAR: &str = "HUBRPC_ENDPOINT";
const LEGACY_TOKEN_VAR: &str = "HUBRPC_TOKEN";

fn format_without_token(target: &ResolvedEndpoint) -> String {
    let target = match target.clone() {
        ResolvedEndpoint::Socket { path, .. } => ResolvedEndpoint::Socket { path, token: None },
        ResolvedEndpoint::Ws { url, .. } => ResolvedEndpoint::Ws { url, token: None },
        other => other,
    };
    format_endpoint_uri(&target, FormatEndpointOptions::default())
}

pub(crate) async fn dial(
    target: &ResolvedEndpoint,
    token: &str,
) -> Result<Box<dyn MessageTransport>, ConnectError> {
    match target {
        ResolvedEndpoint::Socket { path, .. } => {
            Ok(Box::new(crate::connect::connect_socket(path, token).await?))
        }
        ResolvedEndpoint::Ws { url, .. } => Ok(Box::new(
            connect_ws(url, token)
                .await
                .map_err(|e| ConnectError::Ws(e.to_string()))?,
        )),
        _ => unreachable!("only socket and ws endpoints are dialed"),
    }
}

async fn start_single<F, Fut, G>(
    endpoint: String,
    transport: Box<dyn MessageTransport>,
    lifecycle: Arc<Lifecycle>,
    on_connection: Arc<F>,
) -> Result<StartedEndpoint, ConnectError>
where
    F: Fn(EndpointConnection) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<G, BoxError>> + Send + 'static,
    G: Send + 'static,
{
    let task = lifecycle.track();
    let connection = EndpointConnection::open(transport);
    let guard = set_up(&connection, &lifecycle, on_connection.as_ref())
        .await
        .map_err(ConnectError::Setup)?;
    let serving = lifecycle.clone();
    tokio::spawn(async move {
        serve(connection, guard, &serving).await;
        drop(task);
    });
    Ok(StartedEndpoint {
        endpoint,
        lifecycle,
    })
}

/// Run `on_connection` while inbound requests are queued; cancel it if the peer or the endpoint
/// closes first. On failure the connection is closed.
async fn set_up<F, Fut, G>(
    connection: &EndpointConnection,
    lifecycle: &Lifecycle,
    on_connection: &F,
) -> Result<G, BoxError>
where
    F: Fn(EndpointConnection) -> Fut,
    Fut: Future<Output = Result<G, BoxError>>,
{
    let result = tokio::select! {
        result = on_connection(connection.clone()) => result,
        _ = connection.closed() => Err("Endpoint connection closed during setup".into()),
        _ = lifecycle.shutting_down() => Err("Endpoint closed during setup".into()),
    };
    match result {
        Ok(guard) => {
            connection.resume_all_requests();
            Ok(guard)
        }
        Err(error) => {
            connection.close();
            connection.closed().await;
            Err(error)
        }
    }
}

/// Keep `guard` alive until the peer disconnects or the endpoint shuts down.
async fn serve<G>(connection: EndpointConnection, guard: G, lifecycle: &Lifecycle) {
    tokio::select! {
        _ = connection.closed() => {}
        _ = lifecycle.shutting_down() => connection.close(),
    }
    connection.closed().await;
    drop(guard);
}

async fn listen<F, Fut, G>(
    target: ResolvedEndpoint,
    token: String,
    lifecycle: Arc<Lifecycle>,
    on_connection: Arc<F>,
) -> Result<StartedEndpoint, ConnectError>
where
    F: Fn(EndpointConnection) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<G, BoxError>> + Send + 'static,
    G: Send + 'static,
{
    let (listener, endpoint) = Listener::bind(&target).await?;
    let token: Arc<str> = token.into();
    let task = lifecycle.track();
    let accepting = lifecycle.clone();
    tokio::spawn(async move {
        accept_loop(listener, token, accepting, on_connection).await;
        drop(task);
    });
    Ok(StartedEndpoint {
        endpoint,
        lifecycle,
    })
}

async fn accept_loop<F, Fut, G>(
    mut listener: Listener,
    token: Arc<str>,
    lifecycle: Arc<Lifecycle>,
    on_connection: Arc<F>,
) where
    F: Fn(EndpointConnection) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<G, BoxError>> + Send + 'static,
    G: Send + 'static,
{
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = lifecycle.shutting_down() => break,
        };
        let pending = match accepted {
            Ok(pending) => pending,
            Err(error) => {
                lifecycle.report(error.into());
                lifecycle.shutdown.send_replace(true);
                break;
            }
        };
        let task = lifecycle.track();
        let (token, peer_lifecycle, on_connection) =
            (token.clone(), lifecycle.clone(), on_connection.clone());
        tokio::spawn(async move {
            let result = tokio::select! {
                result = pending.open(&token) => result,
                _ = peer_lifecycle.shutting_down() => Err(io::Error::other("Endpoint closed").into()),
            };
            match result {
                Ok(transport) => {
                    let connection = EndpointConnection::open(transport);
                    match set_up(&connection, &peer_lifecycle, on_connection.as_ref()).await {
                        Ok(guard) => serve(connection, guard, &peer_lifecycle).await,
                        Err(error) => peer_lifecycle.report(error),
                    }
                }
                Err(error) => peer_lifecycle.report(error),
            }
            drop(task);
        });
    }
    listener.close();
}

/// Shared shutdown and task accounting for one endpoint.
struct Lifecycle {
    shutdown: watch::Sender<bool>,
    active: watch::Sender<usize>,
    on_error: Option<ErrorReporter>,
}

impl Lifecycle {
    fn new(on_error: Option<ErrorReporter>) -> Self {
        Lifecycle {
            shutdown: watch::Sender::new(false),
            active: watch::Sender::new(0),
            on_error,
        }
    }

    async fn shutting_down(&self) {
        wait_true(&self.shutdown).await;
    }

    /// Count a task until the returned guard drops; [`StartedEndpoint::closed`] waits for zero.
    fn track(&self) -> TaskGuard {
        self.active.send_modify(|count| *count += 1);
        TaskGuard(self.active.clone())
    }

    /// Report a peer failure, unless the endpoint is shutting down (expected cancellation).
    fn report(&self, error: BoxError) {
        if *self.shutdown.borrow() {
            return;
        }
        match &self.on_error {
            Some(report) => report(error),
            None => eprintln!("linkrpc endpoint: {error}"),
        }
    }
}

struct TaskGuard(watch::Sender<usize>);

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.send_modify(|count| *count -= 1);
    }
}

async fn wait_true(signal: &watch::Sender<bool>) {
    let mut receiver = signal.subscribe();
    let _ = receiver.wait_for(|value| *value).await;
}

// -- listeners ------------------------------------------------------------------------------------

pub(crate) enum Listener {
    #[cfg(unix)]
    Unix {
        listener: tokio::net::UnixListener,
        path: String,
    },
    #[cfg(windows)]
    Pipe(crate::windows::NamedPipeHubListener),
    WebSocket {
        listener: tokio::net::TcpListener,
        path: String,
    },
}

/// An accepted peer that has not completed its handshake yet.
pub(crate) enum PendingPeer {
    Ndjson(NdjsonTransport),
    WebSocket {
        stream: tokio::net::TcpStream,
        path: String,
    },
}

const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

impl Listener {
    async fn bind(target: &ResolvedEndpoint) -> Result<(Listener, String), ConnectError> {
        match target {
            ResolvedEndpoint::Socket { path, .. } => {
                let endpoint = format_without_token(target);
                Ok((Self::bind_socket(path)?, endpoint))
            }
            ResolvedEndpoint::Ws { url, .. } => Self::bind_websocket(url).await,
            _ => unreachable!("only socket and ws endpoints listen"),
        }
    }

    #[cfg(unix)]
    pub(crate) fn bind_socket(path: &str) -> io::Result<Listener> {
        // Binding fails on an existing path; an occupied socket is never unlinked.
        Ok(Listener::Unix {
            listener: tokio::net::UnixListener::bind(path)?,
            path: path.to_owned(),
        })
    }

    #[cfg(windows)]
    pub(crate) fn bind_socket(path: &str) -> io::Result<Listener> {
        Ok(Listener::Pipe(crate::windows::NamedPipeHubListener::bind(
            path,
        )?))
    }

    #[cfg(not(any(unix, windows)))]
    pub(crate) fn bind_socket(_path: &str) -> io::Result<Listener> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "local IPC endpoints require Unix or Windows",
        ))
    }

    async fn bind_websocket(url: &str) -> Result<(Listener, String), ConnectError> {
        let mut url = url::Url::parse(url).map_err(|e| ConnectError::Invalid(e.to_string()))?;
        if url.scheme() != "ws" {
            return Err(ConnectError::Invalid(
                "Listening WebSockets require ws:; terminate TLS at a reverse proxy.".to_owned(),
            ));
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ConnectError::Invalid(
                "Listening WebSocket URLs cannot contain credentials, query parameters, or fragments."
                    .to_owned(),
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| ConnectError::Invalid("Listening WebSocket URL has no host.".into()))?;
        let port = url.port_or_known_default().unwrap_or(80);
        let listener = tokio::net::TcpListener::bind(format!("{host}:{port}")).await?;
        let bound = listener.local_addr()?.port();
        url.set_port(Some(bound))
            .map_err(|()| ConnectError::Invalid("cannot set the bound port".to_owned()))?;
        let path = url.path().to_owned();
        Ok((Listener::WebSocket { listener, path }, url.to_string()))
    }

    pub(crate) async fn accept(&mut self) -> io::Result<PendingPeer> {
        match self {
            #[cfg(unix)]
            Listener::Unix { listener, .. } => {
                let (stream, _) = listener.accept().await?;
                Ok(PendingPeer::Ndjson(NdjsonTransport::from_stream(stream)))
            }
            #[cfg(windows)]
            Listener::Pipe(listener) => Ok(PendingPeer::Ndjson(listener.accept().await?)),
            Listener::WebSocket { listener, path } => {
                let (stream, _) = listener.accept().await?;
                Ok(PendingPeer::WebSocket {
                    stream,
                    path: path.clone(),
                })
            }
        }
    }

    pub(crate) fn close(self) {
        #[cfg(unix)]
        if let Listener::Unix { listener, path } = self {
            drop(listener);
            let _ = std::fs::remove_file(path);
        }
    }
}

impl PendingPeer {
    /// Complete the transport and `hubrpc::initialize` handshakes, requiring `token`.
    pub(crate) async fn open(self, token: &str) -> Result<Box<dyn MessageTransport>, BoxError> {
        let transport: Box<dyn MessageTransport> = match self {
            PendingPeer::Ndjson(transport) => Box::new(transport),
            PendingPeer::WebSocket { stream, path } => {
                Box::new(accept_websocket(stream, path).await?)
            }
        };
        accept_initialize(transport.as_ref(), |candidate| {
            token_matches(token, candidate)
        })
        .await?;
        Ok(transport)
    }
}

// tungstenite's upgrade callback signature returns a large `ErrorResponse`.
#[allow(clippy::result_large_err)]
async fn accept_websocket(
    stream: tokio::net::TcpStream,
    path: String,
) -> Result<WebSocketTransport, BoxError> {
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::http::StatusCode;
    use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

    let check_path = move |request: &Request, response: Response| {
        if request.uri().path() == path {
            return Ok(response);
        }
        let mut rejection = ErrorResponse::new(None);
        *rejection.status_mut() = StatusCode::NOT_FOUND;
        Err(rejection)
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_WEBSOCKET_MESSAGE_BYTES));
    let handshake =
        tokio_tungstenite::accept_hdr_async_with_config(stream, check_path, Some(config));
    let ws = tokio::time::timeout(crate::initialize::INITIALIZE_TIMEOUT, handshake)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "WebSocket upgrade timed out"))??;
    Ok(WebSocketTransport::new(ws))
}

// -- request gating -------------------------------------------------------------------------------

/// Shared state between an [`EndpointConnection`] and its [`GatedTransport`].
struct ConnectionControl {
    transport: Mutex<Option<Arc<dyn MessageTransport>>>,
    gate: Mutex<Gate>,
    wake: Notify,
    finished: watch::Sender<bool>,
}

struct Gate {
    deferring: bool,
    released_methods: HashSet<String>,
    queue: VecDeque<JsonRpcMessage>,
}

impl ConnectionControl {
    fn new(transport: Arc<dyn MessageTransport>) -> Self {
        ConnectionControl {
            transport: Mutex::new(Some(transport)),
            gate: Mutex::new(Gate {
                deferring: true,
                released_methods: HashSet::new(),
                queue: VecDeque::new(),
            }),
            wake: Notify::new(),
            finished: watch::Sender::new(false),
        }
    }

    fn transport(&self) -> Option<Arc<dyn MessageTransport>> {
        self.transport.lock().unwrap().clone()
    }

    /// Drop the transport (closing the underlying socket once in-flight I/O ends).
    fn close(&self) {
        self.transport.lock().unwrap().take();
        self.wake.notify_waiters();
    }

    fn resume<I: Iterator<Item = String>>(&self, methods: Option<I>) {
        {
            let mut gate = self.gate.lock().unwrap();
            match methods {
                Some(methods) => gate.released_methods.extend(methods),
                None => gate.deferring = false,
            }
        }
        self.wake.notify_waiters();
    }

    /// The next queued message that may be delivered now.
    fn take_released(&self) -> Option<JsonRpcMessage> {
        let mut gate = self.gate.lock().unwrap();
        if !gate.deferring {
            return gate.queue.pop_front();
        }
        let index = gate
            .queue
            .iter()
            .position(|message| gate.releases(message))?;
        gate.queue.remove(index)
    }

    /// Deliver `message` now, or queue it while requests are deferred. Never lets a new message
    /// overtake older queued ones once deferral ended.
    fn admit(&self, message: JsonRpcMessage) -> Option<JsonRpcMessage> {
        let mut gate = self.gate.lock().unwrap();
        if is_for_own_call(&message) {
            return Some(message);
        }
        if !gate.deferring {
            if gate.queue.is_empty() {
                return Some(message);
            }
            gate.queue.push_back(message);
            return gate.queue.pop_front();
        }
        if gate.releases(&message) {
            return Some(message);
        }
        gate.queue.push_back(message);
        None
    }
}

/// Responses and `toCaller` stream messages belong to this side's own outbound calls, which stay
/// live during setup.
fn is_for_own_call(message: &JsonRpcMessage) -> bool {
    match message {
        JsonRpcMessage::Response(_) => true,
        JsonRpcMessage::Notification(notification) => {
            notification.method == "$stream::send"
                && notification
                    .params
                    .as_ref()
                    .and_then(|params| params.get("dir"))
                    .and_then(|dir| dir.as_str())
                    == Some("toCaller")
        }
        JsonRpcMessage::Request(_) => false,
    }
}

impl Gate {
    fn releases(&self, message: &JsonRpcMessage) -> bool {
        matches!(message, JsonRpcMessage::Request(request) if self.released_methods.contains(&request.method))
    }
}

type PendingReceive = BoxFuture<'static, Option<JsonRpcMessage>>;

/// The transport a [`LinkRpcConnection`] reads through: responses pass immediately, other inbound
/// messages wait for [`EndpointConnection::resume_all_requests`].
struct GatedTransport {
    control: Arc<ConnectionControl>,
    /// An in-flight receive survives across wake-ups, since transport reads are not cancel-safe.
    pending: tokio::sync::Mutex<Option<PendingReceive>>,
}

#[async_trait]
impl MessageTransport for GatedTransport {
    async fn send(&self, message: JsonRpcMessage) -> Result<(), TransportError> {
        let transport = self.control.transport().ok_or(TransportError::Closed)?;
        transport.send(message).await
    }

    async fn recv(&self) -> Option<JsonRpcMessage> {
        let mut pending = self.pending.lock().await;
        loop {
            let woken = self.control.wake.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            let Some(transport) = self.control.transport() else {
                *pending = None;
                return None;
            };
            if let Some(message) = self.control.take_released() {
                return Some(message);
            }
            let receive =
                pending.get_or_insert_with(|| Box::pin(async move { transport.recv().await }));
            tokio::select! {
                biased;
                _ = &mut woken => {}
                message = receive => {
                    *pending = None;
                    let Some(message) = message else {
                        self.control.close();
                        return None;
                    };
                    if let Some(message) = self.control.admit(message) {
                        return Some(message);
                    }
                }
            }
        }
    }
}
