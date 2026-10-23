//! The three linkrpc reflection interfaces — `hubrpc.defaults`, `hubrpc.directory`,
//! `hubrpc.schemas` — defined with the `#[link_rpc_interface]` macro. Registering any interface on
//! a connection also exposes these so peers can discover and introspect it.
//!
//! Param/result schemas are derived from Rust types via `schemars` + the schemars→subset bridge,
//! mirroring the TS zod definitions in `hub/common/reflection.interfaces.ts`. The macro is used
//! here from *within* the `linkrpc` crate itself (see `extern crate self as linkrpc` in `lib.rs`);
//! the registry-backed implementation of the generated traits lives in `hub_connection.rs`.
//!
//! Inline method parameters are wrapped by the macro into a camelCase params object, so only the
//! result types need to be declared here.

use crate::connection::interface_def::InterfaceDefinition;

pub const DEFAULTS_ID: &str = "hubrpc.defaults";
pub const DIRECTORY_ID: &str = "hubrpc.directory";
pub const SCHEMAS_ID: &str = "hubrpc.schemas";

// Generated trait/client/server items for the three reflection interfaces. The typed `*Client`
// proxies are re-exported (see `prelude`) so consumers can introspect an endpoint without hand-
// rolling `call_member` calls; some items are unused inside this crate.
#[allow(dead_code, non_snake_case)]
pub mod iface {
    use schemars::JsonSchema;
    use serde::{Deserialize, Serialize};

    use crate::protocol::json_value::JsonValue;
    use crate::protocol::jsonrpc::JsonRpcError;
    use linkrpc_macros::link_rpc_interface;

    // ── hubrpc.defaults ───────────────────────────────────────────────────────
    #[derive(Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub struct DefaultsGetResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub service_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub interface_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub interface_hash: Option<String>,
    }

    #[derive(Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub struct BareBindingListing {
        pub prefix: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub service_id: Option<String>,
        pub interface_id: String,
        pub interface_hash: String,
    }

    #[derive(Serialize, Deserialize, JsonSchema)]
    pub struct DefaultsListBindingsResult {
        pub bindings: Vec<BareBindingListing>,
    }

    /// Reflection: preset default service / interface on this connection.
    #[link_rpc_interface(id = "hubrpc.defaults", schema = "inline")]
    #[allow(non_snake_case)]
    pub trait DefaultsService {
        async fn get() -> Result<DefaultsGetResult, JsonRpcError>;
        async fn listBindings() -> Result<DefaultsListBindingsResult, JsonRpcError>;
    }

    // ── hubrpc.directory ──────────────────────────────────────────────────────
    // Plain (non-doc) comments on schema types below: doc comments become schema descriptions,
    // which are hashed and would break parity with the TS `hubrpc.directory` schema.
    //
    // A single root-principal requirement. `transitive: true` means the requirement also applies
    // to every service reachable *through* this one.
    #[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct RootPrincipalReq {
        pub principal: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "bool")]
        pub transitive: Option<bool>,
    }

    // One OR-set: satisfied by holding *any one* of its principals.
    pub type RootPrincipalSet = Vec<RootPrincipalReq>;

    // A service-id region: an exact id, or a segment-aware prefix (`foo` includes `foo/bar`,
    // not `foobar`; the empty prefix matches everything).
    #[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, Eq)]
    #[serde(untagged)]
    pub enum ServiceIdPattern {
        Exact { exact: String },
        Prefix { prefix: String },
    }

    impl ServiceIdPattern {
        /// Mirrors TS `serviceIdMatchesPattern`.
        pub fn matches(&self, service_id: &str) -> bool {
            match self {
                ServiceIdPattern::Exact { exact } => service_id == exact,
                ServiceIdPattern::Prefix { prefix } => {
                    prefix.is_empty()
                        || service_id == prefix
                        || service_id
                            .strip_prefix(prefix.as_str())
                            .is_some_and(|rest| rest.starts_with('/'))
                }
            }
        }
    }

    /// Whether `service_id` is included by a union of patterns; `None` means unfiltered.
    /// Mirrors TS `serviceIdMatchesScopes`.
    pub fn service_id_matches_scopes(
        service_id: &str,
        scopes: Option<&[ServiceIdPattern]>,
    ) -> bool {
        scopes.is_none_or(|scopes| scopes.iter().any(|p| p.matches(service_id)))
    }

    #[derive(Serialize, Deserialize, JsonSchema, Clone)]
    #[serde(rename_all = "camelCase")]
    pub struct ServiceListing {
        pub service_id: String,
        pub interface_id: String,
        pub interface_hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "Vec<String>")]
        pub tags: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub service_description: Option<String>,
        // Root principals required to access this service, in CNF (AND of OR-sets).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "Vec<RootPrincipalSet>")]
        pub root_principal_sets: Option<Vec<RootPrincipalSet>>,
        // Service-id regions reachable through this referral (`hubrpc.directory` entries only).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "Vec<ServiceIdPattern>")]
        pub reachable_service_ids: Option<Vec<ServiceIdPattern>>,
    }

    // Empty result / stream tick of `hubrpc.directory::watch`.
    #[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
    pub struct EmptyObject {}

    #[derive(Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    pub struct DirectoryListResult {
        pub items: Vec<ServiceListing>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub next_cursor: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "bool")]
        pub truncated: Option<bool>,
    }

    // A bare `{"type": "integer"}` schema, matching zod's `number().check(int(), ...)` export
    // (schemars would add a `format` and nullability for `Option<u32>`).
    fn integer_schema(_: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
        schemars::schema::SchemaObject {
            instance_type: Some(schemars::schema::InstanceType::Integer.into()),
            ..Default::default()
        }
        .into()
    }

    // `hubrpc.directory::list` params. All fields optional; `limit` > 0, `timeout_ms` >= 0.
    #[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct DirectoryListParams {
        // Only services implementing this interface id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub interface_id: Option<String>,
        // Only services whose interface id starts with this prefix.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub interface_id_prefix: Option<String>,
        // Only entries for this service id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub service_id: Option<String>,
        // Union filter used to constrain a transitive directory walk.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "Vec<ServiceIdPattern>")]
        pub service_id_scopes: Option<Vec<ServiceIdPattern>>,
        // Paging: opaque continuation token from a previous response.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub cursor: Option<String>,
        // Paging: max items in this page. Server MAY return fewer.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(schema_with = "integer_schema")]
        pub limit: Option<u32>,
        // Soft cap on time the server spends gathering this page, in ms.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(schema_with = "integer_schema")]
        pub timeout_ms: Option<u32>,
    }

    // `hubrpc.directory::watch` params: relevance hints mirroring the `list` filters.
    #[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct DirectoryWatchParams {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub interface_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub interface_id_prefix: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        pub service_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "Vec<ServiceIdPattern>")]
        pub service_id_scopes: Option<Vec<ServiceIdPattern>>,
    }

    /// Reflection: list services exposed by this endpoint. Can also list other directory services that can be explored.
    #[link_rpc_interface(id = "hubrpc.directory", schema = "inline")]
    pub trait DirectoryService {
        async fn list(
            #[params] params: DirectoryListParams,
        ) -> Result<DirectoryListResult, JsonRpcError>;

        // Coarse change tap: emits an empty tick whenever the (optionally filtered) directory
        // *might* have changed. Ticks are coalesced; resolves when the caller cancels.
        #[output_stream(EmptyObject)]
        async fn watch(#[params] params: DirectoryWatchParams)
            -> Result<EmptyObject, JsonRpcError>;
    }

    // ── hubrpc.schemas ────────────────────────────────────────────────────────
    #[derive(Serialize, Deserialize, JsonSchema)]
    pub struct SchemasGetResult {
        /// A full `LinkRpcInterfaceSchema`.
        pub schema: JsonValue,
    }

    /// Reflection: fetch interface schemas by id (+ optional hash). Must serve the interfaces advertised in this endpoint's directory.
    #[link_rpc_interface(id = "hubrpc.schemas", schema = "inline")]
    pub trait SchemasService {
        async fn get(
            interface_id: String,
            hash: Option<String>,
        ) -> Result<SchemasGetResult, JsonRpcError>;
    }
}

/// `hubrpc.defaults` — the preset default service/interface on this connection.
pub fn defaults_interface() -> InterfaceDefinition {
    iface::defaults_service::interface()
}

/// `hubrpc.directory` — list the services/interfaces exposed by this endpoint.
pub fn directory_interface() -> InterfaceDefinition {
    iface::directory_service::interface()
}

/// `hubrpc.schemas` — fetch interface schemas by id (+ optional hash).
pub fn schemas_interface() -> InterfaceDefinition {
    iface::schemas_service::interface()
}
