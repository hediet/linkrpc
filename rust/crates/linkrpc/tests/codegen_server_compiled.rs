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
    async fn get_tree(&self, _ctx: &CallCtx, id: String) -> Result<TreeNode, RpcCallError> {
        Ok(TreeNode::new(id))
    }

    async fn notify_changed(&self, _ctx: &CallCtx, node: TreeNode) -> Result<(), RpcCallError> {
        self.notifications.lock().unwrap().push(node.value);
        Ok(())
    }

    async fn configure(
        &self,
        _ctx: &CallCtx,
        _id: String,
        _label: Option<String>,
        payload: Option<serde_json::Value>,
    ) -> Result<bool, RpcCallError> {
        self.configured.lock().unwrap().push(payload);
        Ok(true)
    }
}

#[derive(Default)]
struct EventProvider {
    events: Mutex<Vec<String>>,
}

#[async_trait]
impl ComExampleGraphService for EventProvider {
    async fn tree_changed(
        &self,
        _ctx: &CallCtx,
        value: String,
        _point: Option<Point>,
        _parent: Option<Box<TreeNode>>,
        _children: Option<Vec<TreeNode>>,
    ) -> Result<(), RpcCallError> {
        self.events.lock().unwrap().push(value);
        Ok(())
    }
}

struct FailingProvider;

#[async_trait]
impl ComExampleGraphService for FailingProvider {
    async fn notify_changed(&self, _ctx: &CallCtx, _node: TreeNode) -> Result<(), RpcCallError> {
        Err(RpcCallError::Local(JsonRpcError::new(
            -32_001,
            "notification failed",
        )))
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
    let tree = client.get_tree("root".into()).await.unwrap();
    assert_eq!(tree.value, "root");

    client
        .notify_changed(TreeNode::new("changed".into()))
        .await
        .unwrap();
    wait_for(|| !provider.notifications.lock().unwrap().is_empty()).await;
    assert_eq!(
        provider.notifications.lock().unwrap().as_slice(),
        ["changed"]
    );

    let event_client = ComExampleGraphClient::root(server_connection);
    event_client
        .tree_changed("event".into(), None, None, None)
        .await
        .unwrap();
    wait_for(|| !event_provider.events.lock().unwrap().is_empty()).await;
    assert_eq!(event_provider.events.lock().unwrap().as_slice(), ["event"]);

    assert!(client
        .configure("optional-field-omitted".into(), None, None)
        .await
        .unwrap());
    assert!(client
        .configure(
            "optional-field-present".into(),
            None,
            Some(serde_json::json!({ "unknown": [1, true, null] })),
        )
        .await
        .unwrap());
    assert_eq!(
        *provider.configured.lock().unwrap(),
        vec![
            None,
            Some(serde_json::json!({ "unknown": [1, true, null] }))
        ]
    );

    let error = client.paint(Shape::Point, Color::Red).await.unwrap_err();
    assert!(matches!(
        error,
        RpcCallError::Remote(JsonRpcError {
            code: error_codes::METHOD_NOT_FOUND,
            ..
        })
    ));
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
