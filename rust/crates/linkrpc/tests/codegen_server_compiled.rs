//! Compile and round-trip validation for opt-in generated server defaults.

#[path = "codegen/generated_graph_server.rs"]
mod generated;

use generated::*;
use linkrpc::prelude::*;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct GraphProvider {
    notifications: Mutex<Vec<String>>,
    configured: Mutex<Vec<Option<serde_json::Value>>>,
}

#[async_trait]
impl ComExampleGraphService for GraphProvider {
    async fn get_tree(
        &self,
        _ctx: &CallCtx,
        params: GetTreeParams,
    ) -> Result<TreeNode, JsonRpcError> {
        Ok(TreeNode::new(params.id))
    }

    async fn notify_changed(
        &self,
        _ctx: &CallCtx,
        params: NotifyChangedParams,
    ) -> Result<(), JsonRpcError> {
        self.notifications.lock().unwrap().push(params.node.value);
        Ok(())
    }

    async fn configure(
        &self,
        _ctx: &CallCtx,
        params: ConfigureParams,
    ) -> Result<bool, JsonRpcError> {
        self.configured.lock().unwrap().push(params.payload);
        Ok(true)
    }
}

#[derive(Default)]
struct EventProvider {
    events: Mutex<Vec<String>>,
}

#[async_trait]
impl ComExampleGraphService for EventProvider {
    async fn tree_changed(&self, _ctx: &CallCtx, params: TreeNode) -> Result<(), JsonRpcError> {
        self.events.lock().unwrap().push(params.value);
        Ok(())
    }
}

struct FailingProvider;

#[async_trait]
impl ComExampleGraphService for FailingProvider {
    async fn notify_changed(
        &self,
        _ctx: &CallCtx,
        _params: NotifyChangedParams,
    ) -> Result<(), JsonRpcError> {
        Err(JsonRpcError::new(-32_001, "notification failed"))
    }
}

#[tokio::test]
async fn generated_client_provider_and_event_round_trip() {
    let (a, b) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(a));
    let server_connection = LinkRpcConnection::new(Box::new(b));

    let provider = Arc::new(GraphProvider::default());
    server_connection
        .register_service(
            Arc::new(ComExampleGraphServer::new(provider.clone())),
            RegisterOptions {
                bare_prefix: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();

    let event_provider = Arc::new(EventProvider::default());
    client_connection
        .register_service(
            Arc::new(ComExampleGraphServer::new(event_provider.clone())),
            RegisterOptions {
                bare_prefix: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();

    let client_run = client_connection.clone();
    let server_run = server_connection.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move { server_run.run().await });

    let client = ComExampleGraphClient::root(client_connection);
    let tree = client
        .get_tree(GetTreeParams::new("root".into()))
        .await
        .unwrap();
    assert_eq!(tree.value, "root");

    client
        .notify_changed(NotifyChangedParams::new(TreeNode::new("changed".into())))
        .await
        .unwrap();
    wait_for(|| !provider.notifications.lock().unwrap().is_empty()).await;
    assert_eq!(
        provider.notifications.lock().unwrap().as_slice(),
        ["changed"]
    );

    let event_client = ComExampleGraphClient::root(server_connection);
    event_client
        .tree_changed(TreeNode::new("event".into()))
        .await
        .unwrap();
    wait_for(|| !event_provider.events.lock().unwrap().is_empty()).await;
    assert_eq!(event_provider.events.lock().unwrap().as_slice(), ["event"]);

    assert!(client
        .configure(ConfigureParams::new("optional-field-omitted".into()))
        .await
        .unwrap());
    let mut with_payload = ConfigureParams::new("optional-field-present".into());
    with_payload.payload = Some(serde_json::json!({ "unknown": [1, true, null] }));
    assert!(client.configure(with_payload).await.unwrap());
    assert_eq!(
        *provider.configured.lock().unwrap(),
        vec![
            None,
            Some(serde_json::json!({ "unknown": [1, true, null] }))
        ]
    );

    let error = client
        .paint(PaintParams::new(Shape::Point, Color::Red))
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::METHOD_NOT_FOUND);
}

#[tokio::test]
async fn fallible_notification_dispatch_distinguishes_all_outcomes() {
    let provider = Arc::new(GraphProvider::default());
    let server = ComExampleGraphServer::new(provider.clone());

    assert!(!server
        .dispatch_notification("unknown", serde_json::json!({}))
        .await
        .unwrap());

    assert!(server
        .dispatch_notification(
            "tree_changed",
            serde_json::json!({ "value": "known-but-unhandled" }),
        )
        .await
        .unwrap());

    let error = server
        .dispatch_notification("notify_changed", serde_json::json!({ "node": 42 }))
        .await
        .unwrap_err();
    assert_eq!(error.code, error_codes::INVALID_PARAMS);
    assert!(provider.notifications.lock().unwrap().is_empty());

    assert!(server
        .dispatch_notification("reset", serde_json::json!({}))
        .await
        .unwrap());

    let failing = ComExampleGraphServer::new(Arc::new(FailingProvider));
    let error = failing
        .dispatch_notification(
            "notify_changed",
            serde_json::json!({ "node": { "value": "x" } }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, -32_001);
}

async fn wait_for(predicate: impl Fn() -> bool) {
    for _ in 0..100 {
        if predicate() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    panic!("timed out waiting for notification");
}
