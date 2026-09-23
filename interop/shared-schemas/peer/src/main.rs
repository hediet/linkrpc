use std::{collections::BTreeMap, env, sync::Arc, time::Duration};

use async_trait::async_trait;
use linkrpc::prelude::*;
use linkrpc::schema::{compute_interface_hash, LinkRpcInterfaceSchema};
use linkrpc_tokio::NdjsonTransport;
use serde_json::{json, Map, Value};
use shared_schemas_contract::{
    legacy_inline_schema, sample_snapshot, shared_schemas_daemon, DisplayMetadata,
    SharedSchemasDaemon, SharedSchemasDaemonClient, SharedSchemasDaemonServer, Snapshot,
};
use tokio::time::timeout;

include!(concat!(env!("OUT_DIR"), "/generated_module.rs"));

const DEADLINE: Duration = Duration::from_secs(10);
const FROZEN_INLINE_BYTES: usize = 58_829;

struct OriginalService;

#[async_trait]
impl SharedSchemasDaemon for OriginalService {
    async fn echo(&self, _ctx: &CallCtx, snapshot: Snapshot) -> Result<Snapshot, JsonRpcError> {
        Ok(snapshot)
    }

    async fn restore(&self, _ctx: &CallCtx, snapshot: Snapshot) -> Result<Snapshot, JsonRpcError> {
        Ok(snapshot)
    }

    async fn archive(&self, _ctx: &CallCtx, snapshot: Snapshot) -> Result<Snapshot, JsonRpcError> {
        Ok(snapshot)
    }

    async fn inspect(
        &self,
        _ctx: &CallCtx,
        snapshot: Snapshot,
    ) -> Result<DisplayMetadata, JsonRpcError> {
        Ok(snapshot.metadata)
    }

    async fn history(
        &self,
        _ctx: &CallCtx,
        snapshot: Snapshot,
    ) -> Result<Vec<Snapshot>, JsonRpcError> {
        Ok(vec![snapshot.clone(), snapshot])
    }

    async fn optional(
        &self,
        _ctx: &CallCtx,
        snapshot: Snapshot,
    ) -> Result<Option<Snapshot>, JsonRpcError> {
        Ok(Some(snapshot))
    }

    async fn dictionary(
        &self,
        _ctx: &CallCtx,
        snapshot: Snapshot,
    ) -> Result<BTreeMap<String, Snapshot>, JsonRpcError> {
        Ok(BTreeMap::from([("current".into(), snapshot)]))
    }

    async fn changed(&self, _ctx: &CallCtx, _snapshot: Snapshot) {}
}

struct GeneratedService;

#[async_trait]
impl generated::GeneratedSharedService for GeneratedService {
    async fn echo(
        &self,
        _ctx: &CallCtx,
        params: generated::Snapshot,
    ) -> Result<generated::Snapshot, RpcCallError> {
        Ok(params)
    }

    async fn restore(
        &self,
        _ctx: &CallCtx,
        params: generated::Snapshot,
    ) -> Result<generated::Snapshot, RpcCallError> {
        Ok(params)
    }

    async fn archive(
        &self,
        _ctx: &CallCtx,
        params: generated::Snapshot,
    ) -> Result<generated::Snapshot, RpcCallError> {
        Ok(params)
    }

    async fn inspect(
        &self,
        _ctx: &CallCtx,
        params: generated::Snapshot,
    ) -> Result<generated::DisplayMetadata, RpcCallError> {
        Ok(params.metadata)
    }

    async fn history(
        &self,
        _ctx: &CallCtx,
        params: generated::Snapshot,
    ) -> Result<Vec<generated::Snapshot>, RpcCallError> {
        Ok(vec![params.clone(), params])
    }

    async fn optional(
        &self,
        _ctx: &CallCtx,
        params: generated::Snapshot,
    ) -> Result<generated::OptionalResult, RpcCallError> {
        Ok(generated::OptionalResult::Snapshot(params))
    }

    async fn dictionary(
        &self,
        _ctx: &CallCtx,
        params: generated::Snapshot,
    ) -> Result<std::collections::HashMap<String, generated::Snapshot>, RpcCallError> {
        Ok(std::collections::HashMap::from([(
            "current".into(),
            params,
        )]))
    }
}

fn connection() -> LinkRpcConnection {
    LinkRpcConnection::new(Box::new(NdjsonTransport::new(
        tokio::io::stdin(),
        tokio::io::stdout(),
    )))
}

async fn server(generated_server: bool) {
    let connection = connection();
    if generated_server {
        connection
            .register_service(
                Arc::new(generated::GeneratedSharedServer::new(Arc::new(
                    GeneratedService,
                ))),
                RegisterOptions::default(),
            )
            .expect("register generated JSON-to-Rust server");
    } else {
        connection
            .register_service(
                Arc::new(SharedSchemasDaemonServer::new(Arc::new(OriginalService))),
                RegisterOptions::default(),
            )
            .expect("register original trait server");
    }
    eprintln!("READY {}", shared_schemas_daemon::interface().schema_hash());
    connection.run().await;
}

async fn original_client() {
    let connection = connection();
    let client = SharedSchemasDaemonClient::new(connection.clone());
    tokio::spawn(async move { connection.run().await });
    let sample = sample_snapshot();
    let echoed = timeout(DEADLINE, client.echo(sample.clone()))
        .await
        .expect("original client deadline")
        .expect("original client echo");
    assert_eq!(echoed, sample);
    assert_eq!(
        timeout(DEADLINE, client.restore(sample.clone()))
            .await
            .expect("restore deadline")
            .expect("restore"),
        sample
    );
    assert_eq!(
        timeout(DEADLINE, client.archive(sample.clone()))
            .await
            .expect("archive deadline")
            .expect("archive"),
        sample
    );
    let history = timeout(DEADLINE, client.history(sample.clone()))
        .await
        .expect("history deadline")
        .expect("history");
    assert_eq!(history, vec![sample.clone(), sample.clone()]);
    assert_eq!(
        timeout(DEADLINE, client.optional(sample.clone()))
            .await
            .expect("optional deadline")
            .expect("optional"),
        Some(sample.clone())
    );
    assert_eq!(
        timeout(DEADLINE, client.dictionary(sample.clone()))
            .await
            .expect("dictionary deadline")
            .expect("dictionary")
            .get("current"),
        Some(&sample)
    );
    assert_eq!(
        timeout(DEADLINE, client.inspect(sample.clone()))
            .await
            .expect("inspect deadline")
            .expect("inspect"),
        sample.metadata
    );
    eprintln!("PASS original-client");
    std::process::exit(0);
}

async fn generated_client() {
    let connection = connection();
    let client = generated::GeneratedSharedClient::new(connection.clone());
    tokio::spawn(async move { connection.run().await });
    let sample: generated::Snapshot =
        serde_json::from_value(serde_json::to_value(sample_snapshot()).unwrap()).unwrap();
    let expected = serde_json::to_value(&sample).unwrap();
    let echoed = timeout(DEADLINE, client.echo(sample.clone()))
        .await
        .expect("generated client deadline")
        .expect("generated client echo");
    assert_eq!(serde_json::to_value(echoed).unwrap(), expected);
    let restored = timeout(DEADLINE, client.restore(sample.clone()))
        .await
        .expect("generated restore deadline")
        .expect("generated restore");
    assert_eq!(serde_json::to_value(restored).unwrap(), expected);
    let archived = timeout(DEADLINE, client.archive(sample.clone()))
        .await
        .expect("generated archive deadline")
        .expect("generated archive");
    assert_eq!(serde_json::to_value(archived).unwrap(), expected);
    let history = timeout(DEADLINE, client.history(sample.clone()))
        .await
        .expect("generated history deadline")
        .expect("generated history");
    assert_eq!(
        serde_json::to_value(history).unwrap(),
        json!([expected.clone(), expected.clone()])
    );
    let optional = timeout(DEADLINE, client.optional(sample.clone()))
        .await
        .expect("generated optional deadline")
        .expect("generated optional");
    assert_eq!(serde_json::to_value(optional).unwrap(), expected);
    let dictionary = timeout(DEADLINE, client.dictionary(sample.clone()))
        .await
        .expect("generated dictionary deadline")
        .expect("generated dictionary");
    assert_eq!(
        serde_json::to_value(dictionary).unwrap(),
        json!({ "current": expected.clone() })
    );
    let inspected = timeout(DEADLINE, client.inspect(sample))
        .await
        .expect("generated inspect deadline")
        .expect("generated inspect");
    assert_eq!(
        serde_json::to_value(inspected).unwrap(),
        serde_json::to_value(sample_snapshot().metadata).unwrap()
    );
    eprintln!("PASS generated-client");
    std::process::exit(0);
}

fn inline_baseline(schema: &LinkRpcInterfaceSchema) -> LinkRpcInterfaceSchema {
    let shared = serde_json::to_value(schema).expect("serialize shared schema");
    let mut inline = expand_refs(&shared, &shared, 0);
    inline
        .as_object_mut()
        .expect("interface is an object")
        .remove("components");
    inline["hash"] = Value::String(String::new());
    let mut result: LinkRpcInterfaceSchema =
        serde_json::from_value(inline).expect("parse expanded schema");
    result.hash = compute_interface_hash(&result);
    result
}

fn expand_refs(root: &Value, node: &Value, depth: usize) -> Value {
    assert!(depth < 64, "fixture unexpectedly became recursive");
    match node {
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| expand_refs(root, value, depth + 1))
                .collect(),
        ),
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                assert!(
                    reference.starts_with("#/components/schemas/"),
                    "unexpected reference {reference}"
                );
                let target = root
                    .pointer(&reference[1..])
                    .unwrap_or_else(|| panic!("dangling reference {reference}"));
                let mut expanded = expand_refs(root, target, depth + 1);
                let expanded_object = expanded.as_object_mut().expect("component is an object");
                for (key, value) in object {
                    if key != "$ref" {
                        expanded_object.insert(key.clone(), expand_refs(root, value, depth + 1));
                    }
                }
                expanded
            } else {
                Value::Object(
                    object
                        .iter()
                        .map(|(key, value)| (key.clone(), expand_refs(root, value, depth + 1)))
                        .collect::<Map<_, _>>(),
                )
            }
        }
        _ => node.clone(),
    }
}

fn export() {
    let schema = shared_schemas_daemon::interface().to_schema();
    println!("{}", serde_json::to_string(&schema).unwrap());
}

fn measure() {
    let shared = shared_schemas_daemon::interface().to_schema();
    let expanded = inline_baseline(&shared);
    let inline = legacy_inline_schema();
    assert_eq!(
        inline, expanded,
        "real legacy conversion and expanded shared schema differ"
    );
    let shared_bytes = serde_json::to_vec(&shared).unwrap().len();
    let inline_bytes = serde_json::to_vec(&inline).unwrap().len();
    assert_eq!(
        inline_bytes, FROZEN_INLINE_BYTES,
        "expanded old-inline baseline drifted"
    );
    let saved_bytes = FROZEN_INLINE_BYTES - shared_bytes;
    let reduction_percent = saved_bytes as f64 * 100.0 / FROZEN_INLINE_BYTES as f64;
    assert!(
        reduction_percent > 50.0,
        "shared export reduction was only {reduction_percent:.1}%"
    );
    println!(
        "{}",
        json!({
            "methodCount": shared.methods.len(),
            "componentCount": shared
                .components
                .as_ref()
                .and_then(|components| components.schemas.as_ref())
                .map_or(0, BTreeMap::len),
            "inlineObjectSchemaCount": count_object_schemas(
                &serde_json::to_value(&inline).unwrap()
            ),
            "sharedObjectSchemaCount": count_object_schemas(
                &serde_json::to_value(&shared).unwrap()
            ),
            "inlineBytes": FROZEN_INLINE_BYTES,
            "sharedBytes": shared_bytes,
            "savedBytes": saved_bytes,
            "reductionPercent": (reduction_percent * 10.0).round() / 10.0,
        })
    );
}

fn count_object_schemas(value: &Value) -> usize {
    match value {
        Value::Array(values) => values.iter().map(count_object_schemas).sum(),
        Value::Object(object) => {
            usize::from(object.get("type").and_then(Value::as_str) == Some("object"))
                + object.values().map(count_object_schemas).sum::<usize>()
        }
        _ => 0,
    }
}

fn usage() -> ! {
    eprintln!(
        "usage: shared-schemas-peer <export|measure|original-server|original-client|generated-server|generated-client>"
    );
    std::process::exit(2);
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    match env::args().nth(1).as_deref() {
        Some("export") => export(),
        Some("measure") => measure(),
        Some("original-server") => server(false).await,
        Some("original-client") => original_client().await,
        Some("generated-server") => server(true).await,
        Some("generated-client") => generated_client().await,
        _ => usage(),
    }
}
