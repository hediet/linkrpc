use std::collections::BTreeMap;

use linkrpc::prelude::*;
use linkrpc::schema::{compute_interface_hash, schemars_to_subset, LinkRpcInterfaceSchema};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocation {
    pub script_id: String,
    pub line_number: u32,
    pub column_number: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StackFrame {
    pub function_name: String,
    pub location: SourceLocation,
    pub inlined_locations: Vec<SourceLocation>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DisplayMetadata {
    #[serde(rename = "title")]
    pub schema_title: String,
    #[serde(rename = "format")]
    pub schema_format: String,
    #[serde(rename = "definitions")]
    pub schema_definitions: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SnapshotState {
    Ready {
        generation: u32,
    },
    Failed {
        message: String,
        location: SourceLocation,
    },
}

/// A daemon snapshot deliberately reused throughout this interface.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub snapshot_id: String,
    pub metadata: DisplayMetadata,
    pub previous_metadata: Option<DisplayMetadata>,
    pub metadata_history: Vec<DisplayMetadata>,
    pub metadata_by_name: BTreeMap<String, DisplayMetadata>,
    pub frames: Vec<StackFrame>,
    pub selected_frame: Option<StackFrame>,
    pub frames_by_script: BTreeMap<String, StackFrame>,
    pub state: SnapshotState,
    pub tags: Vec<String>,
}

#[link_rpc_interface(id = "interop.shared-schemas")]
pub trait SharedSchemasDaemon {
    async fn echo(#[params] snapshot: Snapshot) -> Result<Snapshot, JsonRpcError>;

    async fn restore(#[params] snapshot: Snapshot) -> Result<Snapshot, JsonRpcError>;

    async fn archive(#[params] snapshot: Snapshot) -> Result<Snapshot, JsonRpcError>;

    async fn inspect(#[params] snapshot: Snapshot) -> Result<DisplayMetadata, JsonRpcError>;

    async fn history(#[params] snapshot: Snapshot) -> Result<Vec<Snapshot>, JsonRpcError>;

    async fn optional(#[params] snapshot: Snapshot) -> Result<Option<Snapshot>, JsonRpcError>;

    async fn dictionary(
        #[params] snapshot: Snapshot,
    ) -> Result<BTreeMap<String, Snapshot>, JsonRpcError>;

    #[notification]
    async fn changed(#[params] snapshot: Snapshot);
}

pub fn sample_snapshot() -> Snapshot {
    let location = SourceLocation {
        script_id: "daemon.ts".into(),
        line_number: 41,
        column_number: 7,
    };
    let metadata = DisplayMetadata {
        schema_title: "Paused daemon".into(),
        schema_format: "linkrpc.snapshot".into(),
        schema_definitions: BTreeMap::from([
            ("scope".into(), "worker".into()),
            ("runtime".into(), "node".into()),
        ]),
    };
    let frame = StackFrame {
        function_name: "handleRequest".into(),
        location: location.clone(),
        inlined_locations: vec![location.clone()],
    };
    Snapshot {
        snapshot_id: "snapshot-42".into(),
        metadata: metadata.clone(),
        previous_metadata: Some(metadata.clone()),
        metadata_history: vec![metadata.clone(), metadata.clone()],
        metadata_by_name: BTreeMap::from([("primary".into(), metadata)]),
        frames: vec![frame.clone(), frame.clone()],
        selected_frame: Some(frame.clone()),
        frames_by_script: BTreeMap::from([("daemon.ts".into(), frame)]),
        state: SnapshotState::Failed {
            message: "paused on exception".into(),
            location,
        },
        tags: vec!["daemon".into(), "paused".into()],
    }
}

/// Reproduce the trait export before interface-wide shared components.
///
/// Metadata comes from the actual macro export; only the method schema bodies
/// are replaced with the retained per-root inline converter.
pub fn legacy_inline_schema() -> LinkRpcInterfaceSchema {
    fn inline<T: JsonSchema>() -> Value {
        schemars_to_subset(&serde_json::to_value(schemars::schema_for!(T)).unwrap())
            .expect("fixture type is in the legacy inline subset")
    }

    let mut schema = shared_schemas_daemon::interface().to_schema();
    schema.components = None;

    for name in ["echo", "restore", "archive"] {
        let method = schema.methods.get_mut(name).expect("fixture method exists");
        method.params = inline::<Snapshot>();
        method.result = Some(inline::<Snapshot>());
    }

    let inspect = schema
        .methods
        .get_mut("inspect")
        .expect("fixture method exists");
    inspect.params = inline::<Snapshot>();
    inspect.result = Some(inline::<DisplayMetadata>());

    let history = schema
        .methods
        .get_mut("history")
        .expect("fixture method exists");
    history.params = inline::<Snapshot>();
    history.result = Some(inline::<Vec<Snapshot>>());

    let optional = schema
        .methods
        .get_mut("optional")
        .expect("fixture method exists");
    optional.params = inline::<Snapshot>();
    optional.result = Some(inline::<Option<Snapshot>>());

    let dictionary = schema
        .methods
        .get_mut("dictionary")
        .expect("fixture method exists");
    dictionary.params = inline::<Snapshot>();
    dictionary.result = Some(inline::<BTreeMap<String, Snapshot>>());

    let changed = schema
        .methods
        .get_mut("changed")
        .expect("fixture method exists");
    changed.params = inline::<Snapshot>();

    schema.hash.clear();
    schema.hash = compute_interface_hash(&schema);
    schema
}
