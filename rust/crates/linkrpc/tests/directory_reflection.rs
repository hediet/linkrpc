//! `hubrpc.directory` parity with the TS reference: `list` filters (`interfaceIdPrefix`,
//! `serviceIdScopes`) and the change-emitting `watch` stream.

use std::sync::Arc;
use std::time::Duration;

use linkrpc::prelude::*;

#[link_rpc_interface(id = "com.example.alpha")]
trait Alpha {
    async fn ping() -> Result<u32, JsonRpcError>;
}

#[link_rpc_interface(id = "com.example.beta")]
trait Beta {
    async fn ping() -> Result<u32, JsonRpcError>;
}

#[link_rpc_interface(id = "org.other.gamma")]
trait Gamma {
    async fn ping() -> Result<u32, JsonRpcError>;
}

struct Impl;

#[async_trait]
impl Alpha for Impl {
    async fn ping(&self, _ctx: &CallCtx) -> Result<u32, JsonRpcError> {
        Ok(1)
    }
}

#[async_trait]
impl Beta for Impl {
    async fn ping(&self, _ctx: &CallCtx) -> Result<u32, JsonRpcError> {
        Ok(2)
    }
}

#[async_trait]
impl Gamma for Impl {
    async fn ping(&self, _ctx: &CallCtx) -> Result<u32, JsonRpcError> {
        Ok(3)
    }
}

fn under(service_id: &str) -> RegisterOptions {
    RegisterOptions {
        service_id: Some(service_id.into()),
        ..Default::default()
    }
}

fn connected() -> (LinkRpcConnection, LinkRpcConnection) {
    let (a, b) = transport_pair();
    let client = LinkRpcConnection::new(Box::new(a));
    let server = LinkRpcConnection::new(Box::new(b));
    let (c, s) = (client.clone(), server.clone());
    tokio::spawn(async move { c.run().await });
    tokio::spawn(async move { s.run().await });
    (client, server)
}

async fn list(client: &LinkRpcConnection, params: DirectoryListParams) -> Vec<(String, String)> {
    let mut items: Vec<_> = DirectoryServiceClient::new(client.clone())
        .list(params)
        .await
        .expect("directory list")
        .items
        .into_iter()
        .filter(|i| !i.interface_id.starts_with("hubrpc."))
        .map(|i| (i.service_id, i.interface_id))
        .collect();
    items.sort();
    items
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(s, i)| (s.to_string(), i.to_string()))
        .collect()
}

#[test]
fn service_id_patterns_are_segment_aware() {
    let prefix = |p: &str| ServiceIdPattern::Prefix { prefix: p.into() };
    let exact = |e: &str| ServiceIdPattern::Exact { exact: e.into() };
    assert!(prefix("foo").matches("foo"));
    assert!(prefix("foo").matches("foo/bar"));
    assert!(!prefix("foo").matches("foobar"));
    assert!(prefix("").matches("anything"));
    assert!(prefix("").matches(""));
    assert!(exact("foo").matches("foo"));
    assert!(!exact("foo").matches("foo/bar"));

    let decoded: Vec<ServiceIdPattern> =
        serde_json::from_value(serde_json::json!([{ "exact": "a" }, { "prefix": "b" }])).unwrap();
    assert_eq!(decoded, vec![exact("a"), prefix("b")]);
}

#[tokio::test]
async fn list_applies_interface_prefix_and_service_scopes() {
    let (client, server) = connected();
    server
        .register_service(Arc::new(AlphaServer::new(Arc::new(Impl))), under("foo"))
        .unwrap();
    server
        .register_service(Arc::new(BetaServer::new(Arc::new(Impl))), under("foo/bar"))
        .unwrap();
    server
        .register_service(Arc::new(GammaServer::new(Arc::new(Impl))), under("foobar"))
        .unwrap();
    server
        .register_service(
            Arc::new(AlphaServer::new(Arc::new(Impl))),
            RegisterOptions::default(),
        )
        .unwrap();
    server.enable_reflection();

    assert_eq!(
        list(
            &client,
            DirectoryListParams {
                interface_id_prefix: Some("com.example.".into()),
                ..Default::default()
            }
        )
        .await,
        pairs(&[
            ("", "com.example.alpha"),
            ("foo", "com.example.alpha"),
            ("foo/bar", "com.example.beta"),
        ])
    );

    assert_eq!(
        list(
            &client,
            DirectoryListParams {
                service_id_scopes: Some(vec![ServiceIdPattern::Prefix {
                    prefix: "foo".into()
                }]),
                ..Default::default()
            }
        )
        .await,
        pairs(&[
            ("foo", "com.example.alpha"),
            ("foo/bar", "com.example.beta")
        ])
    );

    assert_eq!(
        list(
            &client,
            DirectoryListParams {
                service_id_scopes: Some(vec![
                    ServiceIdPattern::Exact {
                        exact: "foobar".into()
                    },
                    ServiceIdPattern::Exact { exact: "".into() },
                ]),
                ..Default::default()
            }
        )
        .await,
        pairs(&[("", "com.example.alpha"), ("foobar", "org.other.gamma")])
    );

    assert_eq!(
        list(
            &client,
            DirectoryListParams {
                service_id_scopes: Some(vec![]),
                ..Default::default()
            }
        )
        .await,
        pairs(&[])
    );

    // Filters compose with paging.
    let page = DirectoryServiceClient::new(client.clone())
        .list(DirectoryListParams {
            interface_id_prefix: Some("com.example.".into()),
            limit: Some(2),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.next_cursor.as_deref(), Some("2"));

    // Optional listing fields are omitted on the wire when Rust has no data for them.
    let raw = client
        .call_member(
            None,
            "hubrpc.directory",
            "list",
            serde_json::json!({ "interfaceId": "org.other.gamma" }),
        )
        .await
        .unwrap();
    assert_eq!(
        raw["items"][0],
        serde_json::json!({
            "serviceId": "foobar",
            "interfaceId": "org.other.gamma",
            "interfaceHash": gamma::interface().schema_hash(),
        })
    );
}

#[tokio::test]
async fn scoped_reflection_still_lists_only_its_service() {
    let (client, server) = connected();
    server
        .register_service(Arc::new(AlphaServer::new(Arc::new(Impl))), under("foo"))
        .unwrap();
    server
        .register_service(Arc::new(BetaServer::new(Arc::new(Impl))), under("foo/bar"))
        .unwrap();
    server.enable_reflection_for("foo");

    let raw = client
        .call_member(
            Some("foo"),
            "hubrpc.directory",
            "list",
            serde_json::json!({ "serviceIdScopes": [{ "prefix": "foo" }] }),
        )
        .await
        .unwrap();
    let mut items: Vec<_> = raw["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["serviceId"].as_str().unwrap().to_owned(),
                i["interfaceId"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    items.sort();
    assert_eq!(
        items,
        pairs(&[
            ("foo", "com.example.alpha"),
            ("foo", "hubrpc.defaults"),
            ("foo", "hubrpc.directory"),
            ("foo", "hubrpc.schemas"),
        ])
    );
}

#[track_caller]
fn next_tick(
    ticks: &mut StreamReceiver<EmptyObject>,
) -> impl std::future::Future<Output = Option<EmptyObject>> + '_ {
    let caller = std::panic::Location::caller();
    async move {
        tokio::time::timeout(Duration::from_secs(5), ticks.recv())
            .await
            .unwrap_or_else(|_| panic!("tick within timeout at {caller}"))
    }
}

async fn no_tick(ticks: &mut StreamReceiver<EmptyObject>) {
    assert!(
        tokio::time::timeout(Duration::from_millis(100), ticks.recv())
            .await
            .is_err(),
        "unexpected tick"
    );
}

#[tokio::test]
async fn watch_ticks_on_relevant_registry_changes_and_ends_on_cancel() {
    let (client, server) = connected();
    server.enable_reflection();

    let call = DirectoryServiceClient::new(client.clone())
        .watch(DirectoryWatchParams {
            service_id_scopes: Some(vec![ServiceIdPattern::Prefix {
                prefix: "foo".into(),
            }]),
            ..Default::default()
        })
        .await
        .expect("watch starts");
    let (result, _commands, mut ticks, control) = call.into_parts();
    // The stream opens before the provider handler has subscribed; give it a moment (the
    // protocol has no initial-sync tick, consumers list after opening the watch).
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Registration after watch starts produces a tick.
    let registration = server
        .register_service(Arc::new(AlphaServer::new(Arc::new(Impl))), under("foo/a"))
        .unwrap();
    assert_eq!(next_tick(&mut ticks).await, Some(EmptyObject {}));

    // Changes outside the watched scope do not tick.
    server
        .register_service(Arc::new(BetaServer::new(Arc::new(Impl))), under("other"))
        .unwrap();
    no_tick(&mut ticks).await;

    // A burst of relevant changes is coalesced into at least one (and few) ticks.
    server
        .register_service(Arc::new(BetaServer::new(Arc::new(Impl))), under("foo"))
        .unwrap();
    server
        .register_service(Arc::new(GammaServer::new(Arc::new(Impl))), under("foo"))
        .unwrap();
    assert_eq!(next_tick(&mut ticks).await, Some(EmptyObject {}));
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = tokio::time::timeout(Duration::from_millis(50), ticks.recv()).await;

    // Disposal is a change too.
    assert!(registration.dispose());
    assert_eq!(next_tick(&mut ticks).await, Some(EmptyObject {}));

    // Cancel resolves the watch request.
    control.cancel(None).await.expect("cancel sent");
    let outcome = tokio::time::timeout(Duration::from_secs(5), result)
        .await
        .expect("watch settles after cancel");
    assert_eq!(outcome.expect("watch resolves with {}"), EmptyObject {});

    // The watcher is unsubscribed: further registrations don't break anything.
    server
        .register_service(Arc::new(AlphaServer::new(Arc::new(Impl))), under("foo/b"))
        .unwrap();
}

#[tokio::test]
async fn scoped_watch_ignores_other_services() {
    let (client, server) = connected();
    server.enable_reflection_for("foo");

    let call = DirectoryServiceClient::with_service(client.clone(), "foo")
        .watch(DirectoryWatchParams::default())
        .await
        .expect("watch starts");
    let (_result, _commands, mut ticks, _control) = call.into_parts();
    tokio::time::sleep(Duration::from_millis(100)).await;

    server
        .register_service(Arc::new(AlphaServer::new(Arc::new(Impl))), under("bar"))
        .unwrap();
    no_tick(&mut ticks).await;
    server
        .register_service(Arc::new(AlphaServer::new(Arc::new(Impl))), under("foo"))
        .unwrap();
    assert_eq!(next_tick(&mut ticks).await, Some(EmptyObject {}));
}
