//! `linkrpc-tokio` — tokio-based transports and endpoints for linkrpc.
//!
//! Ships the north-star [`NdjsonTransport`] (newline-delimited JSON-RPC framing plus the
//! `hubrpc::initialize` handshake) over any async byte stream, Unix-domain-socket / named-pipe and
//! WebSocket transports, and the `LINKRPC_ENDPOINT`-driven entrypoints:
//!
//! - [`start_endpoint`] serves this process over `stdio:`, by dialing, or by listening
//!   (`listen:unix:…`, `listen:npipe://…`, `listen:ws://…`), and
//! - [`host_participant`] adds the hub participant policy (granted service ID claim and
//!   [`RegistrationMode`]) on top,
//! - [`connect_to_hub`] opens a client connection, including `cmd:` and `cmd-stdio:` children.
//!
//! Higher layers (`LinkRpcConnection`, the hub client) are runtime-agnostic and sit on top of this.

pub mod cmd_env;
pub mod connect;
pub mod endpoint;
pub mod initialize;
pub mod listener;
pub mod ndjson;
pub mod participant;
pub mod stdio;
pub mod ws;

pub use cmd_env::CmdEnvTransport;
pub use connect::{
    connect_to_env_endpoint, connect_to_env_endpoint_with, connect_to_hub, resolve_connection,
    ConnectError, ConnectOptions, ResolvedConnection, RetryOptions, LINKRPC_ENDPOINT_VAR,
    LINKRPC_TOKEN_VAR,
};
pub use endpoint::{
    start_endpoint, BoxError, EndpointConnection, EndpointOptions, ErrorReporter, StartedEndpoint,
};
pub use listener::HubListener;
pub use ndjson::{NdjsonTransport, Preamble};
pub use participant::{
    host_participant, ParticipantContext, ParticipantOptions, ParticipantRegistration,
    ParticipantServices, RegisterError, RegistrationMode,
};
pub use stdio::ChildStdioTransport;
pub use ws::{connect_ws, WebSocketTransport, WsConnectError};

#[cfg(unix)]
pub mod unix;

#[cfg(windows)]
pub mod windows;
