//! `start_endpoint`: dial, `listen:` over WebSockets and the platform socket, token
//! authentication, request queueing during setup, per-peer isolation, and shutdown.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use linkrpc::prelude::*;
use linkrpc_tokio::{
    start_endpoint, BoxError, ConnectError, EndpointConnection, EndpointOptions, StartedEndpoint,
};
use tokio::sync::{mpsc, Notify};

/// Echoes in upper case; `"hang"` never answers.
#[link_rpc_interface(id = "endpoint.echo")]
pub trait Echo {
    async fn ping(value: String) -> Result<String, JsonRpcError>;
}

struct Upper;

#[async_trait]
impl Echo for Upper {
    async fn ping(&self, _ctx: &CallCtx, value: String) -> Result<String, JsonRpcError> {
        if value == "hang" {
            std::future::pending::<()>().await;
        }
        Ok(value.to_uppercase())
    }
}

#[link_rpc_interface(id = "endpoint.ticks")]
pub trait Ticks {
    #[output_stream(u32)]
    async fn ticks(count: u32) -> Result<u32, JsonRpcError>;
}

struct Ticker;

#[async_trait]
impl Ticks for Ticker {
    async fn ticks(
        &self,
        _ctx: &CallCtx,
        count: u32,
        ticks: StreamSender<u32>,
    ) -> Result<u32, JsonRpcError> {
        for tick in 0..count {
            ticks.send(tick).await?;
        }
        Ok(count)
    }
}

fn serve_echo(peer: &EndpointConnection) {
    peer.connection()
        .register_service(
            Arc::new(EchoServer::new(Arc::new(Upper))),
            RegisterOptions::default(),
        )
        .expect("register echo");
}

const TOKEN: &str = "secret";

fn socket_endpoint() -> String {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let unique = format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    if cfg!(windows) {
        format!("npipe://./pipe/linkrpc-test-{unique}")
    } else {
        format!(
            "unix:{}",
            std::env::temp_dir()
                .join(format!("linkrpc-test-{unique}.sock"))
                .display()
        )
    }
}

fn listen_uri(kind: Kind) -> String {
    match kind {
        Kind::WebSocket => "listen:ws://127.0.0.1:0/rpc".to_owned(),
        Kind::Socket => format!("listen:{}", socket_endpoint()),
    }
}

#[derive(Clone, Copy, Debug)]
enum Kind {
    WebSocket,
    Socket,
}

const KINDS: [Kind; 2] = [Kind::WebSocket, Kind::Socket];

fn options(endpoint: &str, token: &str) -> EndpointOptions {
    EndpointOptions {
        endpoint: Some(endpoint.to_owned()),
        token: Some(token.to_owned()),
        on_error: Some(Arc::new(|_| {})),
    }
}

/// Listen with `serve_echo`, collecting reported peer errors.
async fn listen_echo(kind: Kind) -> (StartedEndpoint, Arc<Mutex<Vec<String>>>) {
    let errors = Arc::new(Mutex::new(Vec::new()));
    let reported = errors.clone();
    let endpoint = start_endpoint(
        EndpointOptions {
            on_error: Some(Arc::new(move |error| {
                reported.lock().unwrap().push(error.to_string())
            })),
            ..options(&listen_uri(kind), TOKEN)
        },
        |peer| async move {
            serve_echo(&peer);
            Ok::<_, BoxError>(())
        },
    )
    .await
    .expect("listen");
    (endpoint, errors)
}

/// Dial `endpoint` and return the dialer's connection.
async fn dial(
    endpoint: &str,
    token: &str,
) -> Result<(StartedEndpoint, EndpointConnection), ConnectError> {
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let started = start_endpoint(options(endpoint, token), move |peer| {
        let sender = sender.clone();
        async move {
            sender.send(peer).unwrap();
            Ok::<_, BoxError>(())
        }
    })
    .await?;
    Ok((started, receiver.recv().await.unwrap()))
}

async fn ping(peer: &EndpointConnection, value: &str) -> Result<String, RpcCallError> {
    EchoClient::new(peer.connection().clone())
        .ping(value.to_owned())
        .await
}

#[tokio::test]
async fn round_trips_and_reports_bound_endpoints_without_credentials() {
    for kind in KINDS {
        let (server, _) = listen_echo(kind).await;
        assert!(!server.endpoint().contains(TOKEN), "{kind:?}");
        if let Kind::WebSocket = kind {
            assert!(server.endpoint().starts_with("ws://127.0.0.1:"));
            assert!(!server.endpoint().starts_with("ws://127.0.0.1:0/"));
            assert!(server.endpoint().ends_with("/rpc"));
        }
        let (client, peer) = dial(server.endpoint(), TOKEN).await.expect("dial");
        assert_eq!(client.endpoint(), server.endpoint());
        assert_eq!(ping(&peer, "hello").await.unwrap(), "HELLO", "{kind:?}");

        server.close();
        tokio::time::timeout(Duration::from_secs(5), peer.closed())
            .await
            .expect("peer closes with the server");
        tokio::time::timeout(Duration::from_secs(5), server.closed())
            .await
            .expect("server closes");
        client.closed().await;
    }
}

#[tokio::test]
async fn closed_listeners_release_their_address() {
    for kind in KINDS {
        let (server, _) = listen_echo(kind).await;
        let endpoint = format!("listen:{}", server.endpoint());
        let busy = start_endpoint(options(&endpoint, TOKEN), |_| async {
            Ok::<_, BoxError>(())
        })
        .await
        .expect_err("address is taken");
        assert!(matches!(busy, ConnectError::Io(_)), "{kind:?}: {busy}");
        server.close();
        server.closed().await;
        let rebound = start_endpoint(options(&endpoint, TOKEN), |_| async {
            Ok::<_, BoxError>(())
        })
        .await
        .unwrap_or_else(|e| panic!("{kind:?}: rebind after close: {e}"));
        rebound.close();
        rebound.closed().await;
    }
}

#[tokio::test]
async fn authenticates_before_exposing_connections() {
    for kind in KINDS {
        let calls = Arc::new(AtomicUsize::new(0));
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let (counted, reported) = (calls.clone(), errors.clone());
        let server = start_endpoint(
            EndpointOptions {
                on_error: Some(Arc::new(move |error| {
                    reported.lock().unwrap().push(error.to_string())
                })),
                ..options(&listen_uri(kind), TOKEN)
            },
            move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                async { Ok::<_, BoxError>(()) }
            },
        )
        .await
        .unwrap();
        let error = dial(server.endpoint(), "wrong")
            .await
            .err()
            .expect("rejected");
        assert!(
            error.to_string().contains("unauthenticated"),
            "{kind:?}: {error}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            errors.lock().unwrap().as_slice(),
            ["hubrpc::initialize: unauthenticated"]
        );
    }
}

#[tokio::test]
async fn queues_requests_while_setup_makes_outbound_calls() {
    for kind in KINDS {
        let server = start_endpoint(options(&listen_uri(kind), TOKEN), |peer| async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert_eq!(ping(&peer, "bootstrap").await?, "BOOTSTRAP");
            serve_echo(&peer);
            Ok::<_, BoxError>(())
        })
        .await
        .unwrap();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let _client = start_endpoint(options(server.endpoint(), TOKEN), move |peer| {
            serve_echo(&peer);
            sender.send(peer).unwrap();
            async { Ok::<_, BoxError>(()) }
        })
        .await
        .unwrap();
        let peer = receiver.recv().await.unwrap();
        // Sent before the server registered echo: queued, not method-not-found.
        assert_eq!(ping(&peer, "ready").await.unwrap(), "READY", "{kind:?}");
    }
}

#[tokio::test]
async fn releases_selected_requests_during_setup() {
    let release = Arc::new(Notify::new());
    let waiting = release.clone();
    let server = start_endpoint(options(&listen_uri(Kind::WebSocket), TOKEN), move |peer| {
        let waiting = waiting.clone();
        async move {
            serve_echo(&peer);
            peer.resume_requests([format!("{}::ping", echo::ID)]);
            waiting.notified().await;
            Ok::<_, BoxError>(())
        }
    })
    .await
    .unwrap();
    let (_client, peer) = dial(server.endpoint(), TOKEN).await.unwrap();
    assert_eq!(ping(&peer, "early").await.unwrap(), "EARLY");
    release.notify_one();
}

#[tokio::test]
async fn output_streams_of_setup_time_calls_stay_live() {
    let server = start_endpoint(
        options(&listen_uri(Kind::WebSocket), TOKEN),
        |peer| async move {
            peer.connection()
                .register_service(
                    Arc::new(TicksServer::new(Arc::new(Ticker))),
                    RegisterOptions::default(),
                )
                .expect("register ticks");
            Ok::<_, BoxError>(())
        },
    )
    .await
    .unwrap();
    let setup = start_endpoint(options(server.endpoint(), TOKEN), |peer| async move {
        let call = TicksClient::new(peer.connection().clone()).ticks(3).await?;
        let (result, _input, mut ticks, _control) = call.into_parts();
        let mut received = Vec::new();
        while let Some(tick) = ticks.recv().await {
            received.push(tick);
        }
        assert_eq!((received, result.await?), (vec![0, 1, 2], 3));
        Ok::<_, BoxError>(())
    });
    tokio::time::timeout(Duration::from_secs(5), setup)
        .await
        .expect("setup consumes its stream")
        .expect("setup succeeds");
}

#[tokio::test]
async fn closing_rejects_pending_calls_of_every_peer() {
    let (server, _) = listen_echo(Kind::WebSocket).await;
    let (_first, first) = dial(server.endpoint(), TOKEN).await.unwrap();
    let (_second, second) = dial(server.endpoint(), TOKEN).await.unwrap();
    assert_eq!(ping(&second, "both").await.unwrap(), "BOTH");
    let pending = tokio::spawn(async move { ping(&first, "hang").await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    server.close();
    let result = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .expect("pending call settles")
        .unwrap();
    assert!(result.is_err());
    tokio::time::timeout(Duration::from_secs(5), second.closed())
        .await
        .expect("second peer closes");
}

#[tokio::test]
async fn isolates_failed_listener_setup_and_reports_it() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let (counted, reported) = (attempts.clone(), errors.clone());
    let server = start_endpoint(
        EndpointOptions {
            on_error: Some(Arc::new(move |error| {
                reported.lock().unwrap().push(error.to_string())
            })),
            ..options(&listen_uri(Kind::Socket), TOKEN)
        },
        move |peer| {
            let attempt = counted.fetch_add(1, Ordering::SeqCst);
            async move {
                if attempt == 0 {
                    return Err::<(), BoxError>("first setup fails".into());
                }
                serve_echo(&peer);
                Ok(())
            }
        },
    )
    .await
    .unwrap();
    let (_failed, failed) = dial(server.endpoint(), TOKEN).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), failed.closed())
        .await
        .expect("failed peer is closed");
    let (_healthy, healthy) = dial(server.endpoint(), TOKEN).await.unwrap();
    assert_eq!(ping(&healthy, "ok").await.unwrap(), "OK");
    assert_eq!(errors.lock().unwrap().as_slice(), ["first setup fails"]);
}

/// Sets its flag when dropped.
struct DropFlag(Arc<Notify>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

#[tokio::test]
async fn keeps_setup_guards_until_the_peer_disconnects() {
    let dropped = Arc::new(Notify::new());
    let flag = dropped.clone();
    let server = start_endpoint(options(&listen_uri(Kind::WebSocket), TOKEN), move |peer| {
        serve_echo(&peer);
        let flag = flag.clone();
        async move { Ok::<_, BoxError>(DropFlag(flag)) }
    })
    .await
    .unwrap();
    let (client, peer) = dial(server.endpoint(), TOKEN).await.unwrap();
    assert_eq!(ping(&peer, "alive").await.unwrap(), "ALIVE");
    drop(client);
    tokio::time::timeout(Duration::from_secs(5), dropped.notified())
        .await
        .expect("guard dropped after disconnect");
}

#[tokio::test]
async fn dial_setup_failures_are_returned_and_close_the_connection() {
    let dropped = Arc::new(Notify::new());
    let flag = dropped.clone();
    let server = start_endpoint(options(&listen_uri(Kind::Socket), TOKEN), move |_| {
        let flag = flag.clone();
        async move { Ok::<_, BoxError>(DropFlag(flag)) }
    })
    .await
    .unwrap();
    let error = start_endpoint(options(server.endpoint(), TOKEN), |_| async {
        Err::<(), BoxError>("setup failed".into())
    })
    .await
    .expect_err("setup failure is returned");
    assert!(matches!(&error, ConnectError::Setup(e) if e.to_string() == "setup failed"));
    tokio::time::timeout(Duration::from_secs(5), dropped.notified())
        .await
        .expect("server sees the disconnect");
}

#[tokio::test]
async fn rejects_missing_configuration_and_unsupported_modes() {
    let start = |endpoint: &str, token: &str| {
        let options = options(endpoint, token);
        async move {
            start_endpoint(options, |_| async { Ok::<_, BoxError>(()) })
                .await
                .expect_err("rejected")
                .to_string()
        }
    };
    assert!(start("", TOKEN).await.contains("LINKRPC_ENDPOINT"));
    for unsupported in [
        "cmd-stdio:?command=node",
        "cmd:?command=node",
        "listen:cmd:?command=x",
    ] {
        assert_eq!(
            start(unsupported, TOKEN).await,
            "start_endpoint supports stdio, socket, and LinkRPC WebSocket endpoints only."
        );
    }
    assert_eq!(
        start("listen:ws://127.0.0.1:0", "").await,
        "Listening endpoints require a nonempty token."
    );
    assert_eq!(
        start("listen:wss://127.0.0.1:0", TOKEN).await,
        "Listening WebSockets require ws:; terminate TLS at a reverse proxy."
    );
    assert_eq!(
        start("listen:ws://user@127.0.0.1:0/?x=1", TOKEN).await,
        "Listening WebSocket URLs cannot contain credentials, query parameters, or fragments."
    );
}
