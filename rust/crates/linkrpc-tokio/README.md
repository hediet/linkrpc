# linkrpc-tokio

Tokio transports and endpoints for [LinkRPC](https://github.com/hediet/linkrpc): NDJSON over
Unix sockets, Windows named pipes, and stdio, WebSockets, the `hubrpc::initialize` handshake, and
`LINKRPC_ENDPOINT`-driven entry points. The protocol core lives in the
[`linkrpc`](https://crates.io/crates/linkrpc) crate.

## Endpoint startup

`start_endpoint` is the Rust counterpart of the TypeScript `startEndpoint`: one endpoint URI
decides whether a process serves over stdio, dials, or listens. The application parses its own
`--endpoint` option and passes it as `EndpointOptions::endpoint`; when omitted,
`LINKRPC_ENDPOINT` is used, falling back to the legacy `HUBRPC_ENDPOINT` when the former is unset.
The token comes from the same environment family (`LINKRPC_TOKEN` or `HUBRPC_TOKEN`).

```rust
use std::sync::Arc;
use linkrpc::prelude::*;
use linkrpc_tokio::{start_endpoint, BoxError, EndpointOptions};

let endpoint = start_endpoint(EndpointOptions::default(), |peer| async move {
    peer.connection().register_service(
        Arc::new(MyServiceServer::new(Arc::new(MyService))),
        RegisterOptions::default(),
    )?;
    // Kept alive until this peer disconnects; return a guard for per-peer resources.
    Ok::<_, BoxError>(())
})
.await?;
eprintln!("serving on {}", endpoint.endpoint());
endpoint.closed().await;
```

| Endpoint | Behavior |
| --- | --- |
| `stdio` or `stdio:` | Serve one trusted connection over stdin/stdout, without an initialize handshake |
| `ws://host:port/path` or `wss://host:port/path` | Dial an existing LinkRPC WebSocket endpoint |
| `unix:/absolute/path.sock` | Dial an existing Unix socket |
| `npipe://./pipe/name` | Dial an existing Windows named pipe |
| Bare socket/pipe path | Dial using the legacy socket-path syntax |
| `listen:ws://127.0.0.1:0/path` | Listen for WebSockets; port `0` allocates a free port |
| `listen:unix:/absolute/path.sock` | Listen on a Unix socket |
| `listen:npipe://./pipe/name` | Listen on a Windows named pipe |

In stdio mode, never write logs to stdout; use stderr.

Tokens resolve in order: `EndpointOptions::token`, the URI's `?token=`, the selected environment
family's token, then the empty string. Every listener requires a **nonempty** token, which peers
must present in the initialize handshake before `on_connection` runs; dialing sends the resolved
token. Plain `ws:` does not encrypt tokens or traffic: use loopback or private sockets, or
terminate TLS at a trusted reverse proxy. Listening with `wss:` is rejected. `cmd:`, `cmd-stdio:`,
and `ws-no-init:` endpoints are not supported by `start_endpoint`. Socket listeners never unlink an
occupied path; binding fails instead, and a listener removes only the socket file it created.

```rust
pub struct EndpointOptions {
    pub endpoint: Option<String>,
    pub token: Option<String>,
    pub on_error: Option<ErrorReporter>, // Arc<dyn Fn(BoxError) + Send + Sync>
}

pub async fn start_endpoint<F, Fut, G>(options: EndpointOptions, on_connection: F)
    -> Result<StartedEndpoint, ConnectError>
where
    F: Fn(EndpointConnection) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<G, BoxError>> + Send + 'static,
    G: Send + 'static;

impl EndpointConnection { // Clone
    pub fn connection(&self) -> &LinkRpcConnection;
    pub fn resume_requests<I: IntoIterator<Item = S>, S: Into<String>>(&self, methods: I);
    pub fn resume_all_requests(&self);
    pub fn close(&self);
    pub async fn closed(&self);
    pub fn is_closed(&self) -> bool;
}

impl StartedEndpoint { // closes on drop
    pub fn endpoint(&self) -> &str;
    pub fn close(&self);
    pub async fn closed(&self);
}
```

`StartedEndpoint::endpoint` is a dialable address with the actual bound port and no token (or
`stdio:`). `on_connection` runs once for stdio and dial mode and once per authenticated listener
peer; the endpoint drives each connection itself. Its `Ok` value is kept until that peer
disconnects. Inbound requests and notifications are queued until `on_connection` completes, while
responses to setup-time outbound calls flow, so peers can call immediately without racing handler
registration. Call `peer.resume_requests(["someInterface::discover"])` to release only selected
bootstrap requests early. If the peer disconnects or the endpoint closes during setup, the setup
future is dropped. Failed setup closes the peer.

Startup errors (including a failed initial `on_connection`) are returned. Listener peer handshake
or setup failures close that peer and are reported to `on_error` (stderr by default) while the
listener keeps accepting; listener accept errors are reported and close the endpoint. A peer
disconnect rejects its pending calls; in dial and stdio mode it also closes the endpoint.
`close()` (or dropping the handle) closes all peers; `closed()` resolves after every peer finished.
The helper installs no signal handlers, does not reconnect, and never exits the process.

## Hosting a participant

`host_participant` adds the hub participant policy of the TypeScript `hostParticipant` on top of
`start_endpoint`. For each peer it queries `hubGrantedServiceId::get` (method-not-found or an empty
namespace means no grant), claims the granted namespace (or `service_id`, which must be a
descendant) with `hubGrantedServiceId::register`, and then runs `setup`.

```rust
use linkrpc_tokio::{host_participant, BoxError, ParticipantOptions, RegistrationMode};

let host = host_participant(ParticipantOptions::new(RegistrationMode::All), |context| async move {
    let registration = context.services.register_service(
        Arc::new(MyServiceServer::new(Arc::new(MyService))),
        RegisterOptions::default(),
    )?;
    Ok::<_, BoxError>(registration)
})
.await?;
host.closed().await;
```

| `RegistrationMode` | `services.register` mounts at | Without a grant |
| --- | --- | --- |
| `All` | the claimed service ID and the connection root | root only |
| `Root` | the connection root; nothing is queried or claimed | root only |
| `GrantedServiceId` | the claimed service ID only | the peer fails |

Errors from the namespace query or claim other than method-not-found fail the peer instead of
falling back to root registration. A `service_id` with `RegistrationMode::Root` is rejected.

## Connecting to endpoints

`connect_to_hub` opens a client connection to the endpoint in `ConnectOptions` or the
environment and returns an unstarted `LinkRpcConnection` (drive it with `run()`):

| Endpoint | Behavior |
| --- | --- |
| `unix:`, `npipe://`, bare path, `ws://`, `wss://` | Dial and send the token in the initialize handshake |
| `cmd-stdio:?argv=…` / `?command=…` | Spawn the child and speak NDJSON over its stdio |
| `cmd:?argv=…` / `?command=…` | Bind a private socket or pipe with a random token, spawn the child with `LINKRPC_ENDPOINT` / `LINKRPC_TOKEN`, and accept its authenticated dial-back |

Both command forms accept repeated `env=KEY=VALUE` and a `cwd=` parameter, and the child is
killed when the connection is dropped. A `cmd:` child's stdout is forwarded to stderr, so a
parent serving over stdio keeps its stdout clean; the child must connect within 10 seconds.
`cmd:` children see a plain peer: unlike the TypeScript tunnel's root overlay, no granted
namespace (`hubGrantedServiceId`) or managed identity (`identity::*`, `provisionSlot`) is served,
so they should register at the root (`RegistrationMode::All` or `Root`). `provisionSlot` is
rejected because the Rust runtime does not sign; route calls that need signing through a hub.
