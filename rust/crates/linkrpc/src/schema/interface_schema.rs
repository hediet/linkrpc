//! The linkrpc interface schema model: `{ id, hash, methods{}, components }`.
//! A strict subset of OpenRPC 1.x — identity & addressing live in linkrpc, so
//! this describes only the contract of a single interface.
//!
//! Ported from TS `schema/linkRpcInterfaceSchema.ts` (canonical shape, spec
//! chapter 04 §2): `methods` is a map **keyed by member name** (the key is the
//! member name — schemas carry no redundant synthetic name), and each method's
//! `params` / `result` / stream fields are a single `JsonSchema` value rather
//! than a list of named content descriptors.
//!
//! JSON-Schema bodies (`MethodSchema::params`, `components.schemas`) are kept
//! as opaque [`JsonValue`]; they hold the decidable `LinkRpcJsonSchema` subset
//! produced by [`crate::schema::normalize::normalize_json_schema`].
//!
//! Because `methods` is a keyed map, member **order is not part of identity**:
//! the interface hash JCS-sorts object keys (spec 04 §4), so two schemas that
//! differ only in member insertion order hash identically. This matches the
//! canonical TS `Record<string, MethodSchema>`.

use crate::protocol::json_value::JsonValue;
use crate::schema::normalize::normalize_json_schema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// A name-keyed map of methods. Keys are sorted, which is irrelevant to
/// identity (the interface hash JCS-sorts object keys, spec 04 §4) and keeps
/// serialization deterministic. This mirrors the canonical TS
/// `Record<string, MethodSchema>`.
pub type MethodMap = BTreeMap<String, MethodSchema>;

/// Resolve a local component reference and RFC 6901-decode its path segment.
pub fn component_ref_name(reference: &str) -> Option<String> {
    let encoded = reference.strip_prefix("#/components/schemas/")?;
    let mut decoded = String::with_capacity(encoded.len());
    let mut chars = encoded.chars();
    while let Some(ch) = chars.next() {
        if ch != '~' {
            decoded.push(ch);
            continue;
        }
        match chars.next()? {
            '0' => decoded.push('~'),
            '1' => decoded.push('/'),
            _ => return None,
        }
    }
    Some(decoded)
}

pub(crate) fn component_ref(name: &str) -> String {
    let encoded = name.replace('~', "~0").replace('/', "~1");
    format!("#/components/schemas/{encoded}")
}

/// A single interface contract. Serializes to the exact JSON shape the
/// interface hash is computed over.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkRpcInterfaceSchema {
    /// Stable interface id, e.g. `"de.hediet.notification-target"`.
    pub id: String,

    /// Content hash of the normalized schema. Pairs with `id` to form `id@hash`.
    /// Omitted from the hash input itself.
    pub hash: String,

    /// Normative human description (markdown). Part of the interface hash.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,

    /// Non-normative implementation notes. Stripped from the hash.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub comment: Option<String>,

    /// Non-normative discovery labels (excluded from the interface hash).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tags: Option<Vec<String>>,

    /// Methods keyed by local member name. Member names MUST be unique (they are
    /// map keys) and conform to the `member` grammar (chapter 01 §2). Order is
    /// **not** normative — the hash sorts keys.
    pub methods: MethodMap,

    /// Reusable schema definitions, referenced via `#/components/schemas/<name>`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub components: Option<Components>,

    /// Specification-extension keys captured verbatim from the source document
    /// and preserved across a parse → serialize round-trip. Any top-level key
    /// that is not a known field lands here; in practice these are `x-…`
    /// extensions (codegen directives, tooling hints).
    ///
    /// **Identity-neutral:** the interface hash strips every `x-…` key (see
    /// [`crate::schema::hash`]), so extensions never change `id@hash`. This is
    /// the "one document, two views" mechanism: the richer document survives
    /// typed parsing so tooling (e.g. the Rust code generator, which reads
    /// `x-linkrpc-codegen`) can see it, while identity hashes only the simple
    /// wire contract. Empty by default, so schemas without extensions serialize
    /// and hash exactly as before.
    #[serde(flatten)]
    pub extensions: BTreeMap<String, JsonValue>,
}

impl LinkRpcInterfaceSchema {
    /// `id@hash` addressing form.
    pub fn id_at_hash(&self) -> String {
        format!("{}@{}", self.id, self.hash)
    }

    /// Look up a preserved specification-extension value (typically an `x-…`
    /// key) by exact key. Returns `None` when absent.
    pub fn extension(&self, key: &str) -> Option<&JsonValue> {
        self.extensions.get(key)
    }

    /// Validate cross-field rules which cannot be expressed by serde's data model.
    pub fn validate(&self) -> Result<(), InterfaceSchemaError> {
        let mut raw_schemas = Vec::new();
        for (method_name, method) in &self.methods {
            let Some(errors) = &method.errors else {
                continue;
            };
            if method.result.is_none() {
                return Err(InterfaceSchemaError(format!(
                    "notification `{method_name}` must not declare errors"
                )));
            }
            let mut codes = BTreeSet::new();
            let mut raw_codes = BTreeSet::new();
            let mut legacy_errors = BTreeSet::new();
            let mut names = BTreeSet::new();
            for error in errors {
                let previously_declared = !codes.insert(error.code);
                if raw_codes.contains(&error.code)
                    || (error.schema.is_some() && previously_declared)
                {
                    return Err(InterfaceSchemaError(format!(
                        "method `{method_name}` has duplicate raw error code {}",
                        error.code
                    )));
                }
                if let Some(schema) = &error.schema {
                    raw_codes.insert(error.code);
                    if error.r#type.is_some() || !error.message.is_empty() || error.data.is_some() {
                        return Err(InterfaceSchemaError(format!(
                            "method `{method_name}` raw error must not declare type, message, or data"
                        )));
                    }
                    normalize_json_schema(schema).map_err(|reason| {
                        InterfaceSchemaError(format!(
                            "method `{method_name}` error code {}: {reason}",
                            error.code
                        ))
                    })?;
                    raw_schemas.push(schema.clone());
                    continue;
                }
                if let Some(name) = &error.r#type {
                    if (-32768..=-32000).contains(&error.code) || error.code == -32800 {
                        return Err(InterfaceSchemaError(format!(
                            "method `{method_name}` error code {} is protocol-reserved",
                            error.code
                        )));
                    }
                    if name.is_empty() {
                        return Err(InterfaceSchemaError(format!(
                            "method `{method_name}` error type must not be empty"
                        )));
                    }
                    if !names.insert(name) {
                        return Err(InterfaceSchemaError(format!(
                            "method `{method_name}` has duplicate error type `{name}`"
                        )));
                    }
                } else if !legacy_errors.insert((error.code, &error.message)) {
                    return Err(InterfaceSchemaError(format!(
                        "method `{method_name}` has duplicate legacy error code {} and message `{}`",
                        error.code, error.message
                    )));
                }
            }
        }
        if !raw_schemas.is_empty() {
            super::schemars_subset::validate_guarded_references(
                &raw_schemas,
                self.components
                    .as_ref()
                    .and_then(|c| c.schemas.as_ref())
                    .unwrap_or(&BTreeMap::new()),
            )
            .map_err(|error| InterfaceSchemaError(error.to_string()))?;
            jsonschema::JSONSchema::compile(&serde_json::json!({
                "allOf": raw_schemas, "components": self.components,
            }))
            .map_err(|error| InterfaceSchemaError(error.to_string()))?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct InterfaceSchemaError(pub String);

/// Reusable schema definitions bag, referenced via `#/components/schemas/<name>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Components {
    /// Named JSON Schemas (the decidable linkrpc subset). Keyed by name; sorted
    /// for deterministic serialization (order is irrelevant to the hash).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub schemas: Option<BTreeMap<String, JsonValue>>,
}

/// A single method declaration. The owning member name is the map key in
/// [`LinkRpcInterfaceSchema::methods`], so it does not appear here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodSchema {
    /// Schema for the user params object (the decidable `LinkRpcJsonSchema`
    /// subset). A boolean `true` schema means "any params".
    pub params: JsonValue,

    /// Result schema. Omit to declare a notification-only method.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub result: Option<JsonValue>,

    /// Schema for client-emitted stream messages on an in-flight call.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub client_stream: Option<JsonValue>,

    /// Schema for server-emitted stream messages on an in-flight call.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub server_stream: Option<JsonValue>,

    /// Error declarations. Named types and raw codes must be unique.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub errors: Option<Vec<ErrorSchema>>,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary: Option<String>,

    /// Normative description of this method's contract. Part of the hash.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,

    /// Non-normative implementation notes. Stripped from the hash.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub comment: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub deprecated: Option<bool>,

    /// Behavioral claims. Normative — part of the interface hash.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub annotations: Option<MemberAnnotations>,

    /// Specification-extension keys captured verbatim from the source document
    /// and preserved across a parse → serialize round-trip. Any method-level key
    /// that is not a known field lands here; in practice these are `x-…`
    /// extensions. **Identity-neutral** (stripped from the interface hash). The
    /// code generator reads `x-linkrpc-codegen` from here — notably
    /// `x-linkrpc-codegen.kind = "serverNotification"` to mark a result-less
    /// method as a server→client event rather than a client-sent notification.
    /// Empty by default, so methods without extensions are unchanged.
    #[serde(flatten)]
    pub extensions: BTreeMap<String, JsonValue>,
}

impl MethodSchema {
    /// A notification-only method (no result) with the given params schema.
    pub fn notification(params: JsonValue) -> Self {
        MethodSchema {
            params,
            result: None,
            client_stream: None,
            server_stream: None,
            errors: None,
            summary: None,
            description: None,
            comment: None,
            deprecated: None,
            annotations: None,
            extensions: BTreeMap::new(),
        }
    }

    /// A request method with the given params and result schemas.
    pub fn request(params: JsonValue, result: JsonValue) -> Self {
        MethodSchema {
            result: Some(result),
            ..MethodSchema::notification(params)
        }
    }

    /// Look up a preserved specification-extension value (typically an `x-…`
    /// key) by exact key. Returns `None` when absent.
    pub fn extension(&self, key: &str) -> Option<&JsonValue> {
        self.extensions.get(key)
    }
}

/// Behavioral claims about a method. Every flag is a positive assertion
/// (default `false` ≡ "no claim"). Normative — included in the interface hash.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberAnnotations {
    /// Pure query: does not modify observable state.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub read_only: Option<bool>,
    /// Safe to retry: N calls ≡ one call.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub idempotent: Option<bool>,
    /// Effects can be undone with a follow-up call.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reversible: Option<bool>,
    /// Slow, costly, or rate-limited.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expensive: Option<bool>,
    /// Irreversible or destructive effects. UIs should confirm.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub dangerous: Option<bool>,
}

/// An application-level error declaration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "ErrorSchemaRepr", into = "ErrorSchemaRepr")]
pub struct ErrorSchema {
    /// JSON-RPC error code. Named errors must not use protocol-reserved codes.
    pub code: i32,
    /// Stable named-envelope discriminator; absent for legacy raw-data errors.
    pub r#type: Option<String>,
    /// Literal message for named/legacy errors; empty for raw body schemas.
    pub message: String,
    /// Inner variant payload schema (legacy: the entire `error.data`).
    pub data: Option<JsonValue>,
    /// Raw error body schema, describing `{ message, data? }` without `code`.
    pub schema: Option<JsonValue>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum ErrorSchemaRepr {
    Raw {
        code: i32,
        schema: JsonValue,
        #[serde(flatten)]
        metadata: BTreeMap<String, JsonValue>,
    },
    Legacy {
        code: i32,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        r#type: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        data: Option<JsonValue>,
        #[serde(flatten)]
        metadata: BTreeMap<String, JsonValue>,
    },
}

impl TryFrom<ErrorSchemaRepr> for ErrorSchema {
    type Error = String;

    fn try_from(value: ErrorSchemaRepr) -> Result<Self, Self::Error> {
        let (ErrorSchemaRepr::Raw { metadata, .. } | ErrorSchemaRepr::Legacy { metadata, .. }) =
            &value;
        if let Some(key) = metadata
            .keys()
            .find(|key| key.as_str() != "comment" && !key.starts_with("x-"))
        {
            return Err(format!("unexpected error declaration field `{key}`"));
        }
        Ok(match value {
            ErrorSchemaRepr::Raw { code, schema, .. } => Self {
                code,
                r#type: None,
                message: String::new(),
                data: None,
                schema: Some(schema),
            },
            ErrorSchemaRepr::Legacy {
                code,
                r#type,
                message,
                data,
                ..
            } => Self {
                code,
                r#type,
                message,
                data,
                schema: None,
            },
        })
    }
}

impl From<ErrorSchema> for ErrorSchemaRepr {
    fn from(value: ErrorSchema) -> Self {
        match value.schema {
            Some(schema) => Self::Raw {
                code: value.code,
                schema,
                metadata: BTreeMap::new(),
            },
            None => Self::Legacy {
                code: value.code,
                r#type: value.r#type,
                message: value.message,
                data: value.data,
                metadata: BTreeMap::new(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::hash::compute_interface_hash;
    use serde_json::json;

    const ENRICHED: &str = r##"{
        "id": "com.example.events",
        "hash": "",
        "description": "Interface with x-* extensions at every level.",
        "x-linkrpc-codegen": { "clientName": "EventsClient" },
        "methods": {
            "subscribe": {
                "x-safety": { "readOnly": true },
                "params": { "type": "object", "additionalProperties": false },
                "result": { "type": "boolean" }
            },
            "on_event": {
                "x-linkrpc-codegen": { "kind": "serverNotification" },
                "params": { "type": "object", "additionalProperties": false }
            }
        }
    }"##;

    fn parse(doc: &str) -> LinkRpcInterfaceSchema {
        serde_json::from_str(doc).expect("valid schema")
    }

    fn raw_body() -> JsonValue {
        json!({
            "type": "object",
            "properties": {
                "message": {"type": "string"},
                "data": true
            },
            "required": ["message"],
            "additionalProperties": false
        })
    }

    fn with_errors(errors: JsonValue) -> LinkRpcInterfaceSchema {
        serde_json::from_value(json!({
            "id": "test.errors",
            "hash": "",
            "methods": {
                "request": {"params": true, "result": true, "errors": errors}
            }
        }))
        .unwrap()
    }

    #[test]
    fn error_declarations_round_trip_as_exact_union() {
        for value in [
            json!({"code": -32001, "schema": raw_body()}),
            json!({"code": 1, "schema": null}),
            json!({"code": 1, "type": "Missing", "message": "Not found", "data": true}),
            json!({"code": 2, "message": "Legacy"}),
        ] {
            let declaration: ErrorSchema = serde_json::from_value(value.clone()).unwrap();
            if value.get("schema").is_some() {
                assert!(declaration.schema.is_some());
                assert_eq!(declaration.message, "");
                assert_eq!(declaration.r#type, None);
                assert_eq!(declaration.data, None);
            } else {
                assert_eq!(declaration.schema, None);
            }
            assert_eq!(serde_json::to_value(declaration).unwrap(), value);
        }
    }

    #[test]
    fn error_declarations_accept_non_normative_metadata() {
        for canonical in [
            json!({"code": -32001, "schema": raw_body()}),
            json!({"code": 1, "type": "Missing", "message": "Not found", "data": true}),
            json!({"code": 2, "message": "Legacy"}),
        ] {
            let mut extended = canonical.clone();
            extended["comment"] = json!("Display metadata");
            extended["x-display"] = json!({"icon": "warning"});
            let declaration: ErrorSchema = serde_json::from_value(extended.clone()).unwrap();
            assert_eq!(serde_json::to_value(declaration).unwrap(), canonical);
            with_errors(json!([extended])).validate().unwrap();
        }
    }

    #[test]
    fn error_declarations_reject_mixed_union_members_even_when_null() {
        for schema in [raw_body(), JsonValue::Null] {
            for sibling in ["type", "message", "data"] {
                for value in [JsonValue::Null, json!("unexpected"), json!(true)] {
                    let mut declaration = json!({"code": 1, "schema": schema});
                    declaration[sibling] = value;
                    assert!(
                        serde_json::from_value::<ErrorSchema>(declaration.clone()).is_err(),
                        "{declaration}"
                    );
                    let interface = json!({
                        "id": "strict.raw.import", "hash": "",
                        "methods": {
                            "check": {"params": true, "result": true, "errors": [declaration]}
                        }
                    });
                    assert!(serde_json::from_value::<LinkRpcInterfaceSchema>(interface).is_err());
                }
            }
        }
        for declaration in [
            json!({"code": 1}),
            json!({"code": 1, "type": "Missing"}),
            json!({"schema": true}),
            json!({"code": 1, "message": "Legacy", "unknown": true}),
            json!({"code": 1, "schema": true, "unknown": true}),
        ] {
            assert!(
                serde_json::from_value::<ErrorSchema>(declaration.clone()).is_err(),
                "{declaration}"
            );
        }
    }

    #[test]
    fn raw_codes_are_unique_across_all_declarations_in_either_order() {
        let raw = json!({"code": 1, "schema": raw_body()});
        for other in [
            raw.clone(),
            json!({"code": 1, "type": "Missing", "message": "Not found"}),
            json!({"code": 1, "message": "Legacy"}),
        ] {
            for errors in [json!([raw, other]), json!([other, raw])] {
                let error = with_errors(errors).validate().unwrap_err();
                assert!(error.0.contains("duplicate raw error code 1"), "{error}");
            }
        }
        with_errors(json!([
            raw,
            {"code": 2, "type": "Missing", "message": "Not found"},
            {"code": 2, "type": "Denied", "message": "Denied"},
            {"code": 2, "message": "Legacy"},
            {"code": 2, "message": "Another legacy"}
        ]))
        .validate()
        .unwrap();
    }

    #[test]
    fn named_types_and_legacy_code_message_pairs_are_unique() {
        for errors in [
            json!([
                {"code": 1, "type": "Missing", "message": "Missing"},
                {"code": 2, "type": "Missing", "message": "Different"}
            ]),
            json!([
                {"code": 1, "message": "Missing"},
                {"code": 1, "message": "Missing", "data": true}
            ]),
            json!([{"code": 1, "type": "", "message": "Missing"}]),
        ] {
            assert!(with_errors(errors).validate().is_err());
        }
        with_errors(json!([
            {"code": 1, "message": "Missing"},
            {"code": 2, "message": "Missing"}
        ]))
        .validate()
        .unwrap();
    }

    #[test]
    fn only_named_errors_reject_reserved_codes() {
        for code in [-32800, -32768, -32603, -32099, -32000] {
            with_errors(json!([{"code": code, "schema": raw_body()}]))
                .validate()
                .unwrap();
            with_errors(json!([{"code": code, "message": "Imported foreign error"}]))
                .validate()
                .unwrap();
            let error = with_errors(json!([{
                "code": code, "type": "Named", "message": "Named error"
            }]))
            .validate()
            .unwrap_err();
            assert!(error.0.contains("protocol-reserved"));
        }
        for code in [-32801, -32769, -31999, 1] {
            with_errors(json!([{"code": code, "type": "Named", "message": "Named error"}]))
                .validate()
                .unwrap();
        }
    }

    #[test]
    fn raw_errors_remain_forbidden_on_notifications() {
        let mut interface = with_errors(json!([{"code": 1, "schema": raw_body()}]));
        interface.methods.get_mut("request").unwrap().result = None;
        assert!(interface.validate().unwrap_err().0.contains("notification"));
    }

    #[test]
    fn raw_body_schema_supports_unions_and_component_references() {
        for keyword in ["anyOf", "oneOf"] {
            let mut interface = with_errors(json!([{
                "code": -32001,
                "schema": {
                    keyword: [
                        {"$ref": "#/components/schemas/Body~1failure"},
                        {
                            "type": "object",
                            "properties": {
                                "message": {"enum": ["Retry", "Later"]},
                                "data": {"type": "null"}
                            },
                            "required": ["data", "message"]
                        }
                    ]
                }
            }]));
            let mut body = raw_body();
            body["properties"]["message"] = json!({"$ref": "#/components/schemas/Message"});
            interface.components = Some(Components {
                schemas: Some(BTreeMap::from([
                    ("Body/failure".to_string(), body),
                    (
                        "Message".to_string(),
                        json!({"anyOf": [
                            {"const": "Failure"}, {"type": "string"}
                        ]}),
                    ),
                ])),
            });
            interface.validate().unwrap();
            let value = serde_json::to_value(&interface).unwrap();
            assert_eq!(
                value["methods"]["request"]["errors"][0]["schema"][keyword]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
        }
    }

    #[test]
    fn raw_body_schema_accepts_general_constraints_without_proving_envelope_shape() {
        for schema in [
            json!(true),
            json!(false),
            json!({}),
            json!({"type": "string"}),
            json!({"type": "object", "properties": {"message": {"type": "string"}}}),
            json!({"type": "object", "properties": {"message": {"type": "number"}}, "required": ["message"]}),
            json!({"type": "object", "properties": {"message": {"anyOf": [{"type": "string"}, {"type": "number"}]}}, "required": ["message"]}),
            json!({"type": "object", "properties": {"message": {"type": "string"}, "code": {"type": "number"}}, "required": ["message"]}),
            json!({"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"], "additionalProperties": true}),
            json!({"anyOf": [raw_body(), {"type": "string"}]}),
            json!({"anyOf": [raw_body(), {"type": "object", "properties": {"message": {"type": "number"}}, "required": ["message"]}]}),
            json!({"const": {"message": 1}}),
            json!({"enum": [{"message": "Failure"}, {"message": "Failure", "code": 1}]}),
        ] {
            with_errors(json!([{"code": 1, "schema": schema}]))
                .validate()
                .unwrap_or_else(|error| panic!("{schema}: {error}"));
        }
    }

    #[test]
    fn raw_body_schema_rejects_malformed_schemas_and_references() {
        for schema in [
            JsonValue::Null,
            json!([]),
            json!({"type": "invalid-type"}),
            json!({"anyOf": [true, null]}),
            json!({"properties": {"data": 123}}),
            json!({"$ref": "#/components/schemas/Missing"}),
            json!({"type": "object", "properties": {"data": {"$ref": "#/components/schemas/Missing"}}}),
        ] {
            assert!(
                with_errors(json!([{"code": 1, "schema": schema}]))
                    .validate()
                    .is_err(),
                "{schema}"
            );
        }
        let mut interface = with_errors(json!([{
            "code": 1, "schema": {"$ref": "#/components/schemas/Cycle"}
        }]));
        interface.components = Some(Components {
            schemas: Some(BTreeMap::from([(
                "Cycle".to_string(),
                json!({"$ref": "#/components/schemas/Cycle"}),
            )])),
        });
        assert!(interface.validate().unwrap_err().0.contains("cycle"));
    }

    #[test]
    fn raw_body_schema_supports_literal_bodies_and_recursive_data() {
        for schema in [
            json!(false),
            json!({"const": {"message": "Failure"}}),
            json!({"enum": [{"message": "Failure"}, {"message": "Retry", "data": null}]}),
        ] {
            with_errors(json!([{"code": 1, "schema": schema}]))
                .validate()
                .unwrap();
        }
        let mut body = raw_body();
        body["properties"]["data"] = json!({"$ref": "#/components/schemas/Body"});
        let mut interface = with_errors(json!([{
            "code": 1, "schema": {"$ref": "#/components/schemas/Body"}
        }]));
        interface.components = Some(Components {
            schemas: Some(BTreeMap::from([("Body".to_string(), body)])),
        });
        interface.validate().unwrap();
    }

    #[test]
    fn top_level_and_method_extensions_survive_typed_parsing() {
        let schema = parse(ENRICHED);
        // Top-level x-* preserved and reachable.
        assert_eq!(
            schema.extension("x-linkrpc-codegen"),
            Some(&json!({ "clientName": "EventsClient" }))
        );
        // Method-level x-* preserved.
        let on_event = &schema.methods["on_event"];
        assert_eq!(
            on_event.extension("x-linkrpc-codegen"),
            Some(&json!({ "kind": "serverNotification" }))
        );
        assert_eq!(
            schema.methods["subscribe"].extension("x-safety"),
            Some(&json!({ "readOnly": true }))
        );
        // Absent extensions are None.
        assert_eq!(schema.methods["subscribe"].extension("x-missing"), None);
    }

    #[test]
    fn extensions_round_trip_through_serialization() {
        let schema = parse(ENRICHED);
        let reserialized = serde_json::to_value(&schema).unwrap();
        // The flattened x-* keys appear at their original level on the way out.
        assert_eq!(
            reserialized["x-linkrpc-codegen"],
            json!({ "clientName": "EventsClient" })
        );
        assert_eq!(
            reserialized["methods"]["on_event"]["x-linkrpc-codegen"]["kind"],
            "serverNotification"
        );
        // Full fidelity: re-parsing yields the same typed value.
        let round: LinkRpcInterfaceSchema = serde_json::from_value(reserialized).unwrap();
        assert_eq!(schema, round);
    }

    #[test]
    fn extensions_are_hash_invisible() {
        // The enriched document hashes identically to the same contract with all
        // x-* keys removed: identity is the simple wire projection.
        let enriched = parse(ENRICHED);
        let plain = parse(
            r##"{
                "id": "com.example.events",
                "hash": "",
                "description": "Interface with x-* extensions at every level.",
                "methods": {
                    "subscribe": {
                        "params": { "type": "object", "additionalProperties": false },
                        "result": { "type": "boolean" }
                    },
                    "on_event": {
                        "params": { "type": "object", "additionalProperties": false }
                    }
                }
            }"##,
        );
        assert_eq!(
            compute_interface_hash(&enriched),
            compute_interface_hash(&plain)
        );
    }

    #[test]
    fn editing_an_extension_value_does_not_change_the_hash() {
        let a = parse(ENRICHED);
        let mut b = a.clone();
        b.extensions.insert(
            "x-linkrpc-codegen".to_string(),
            json!({ "clientName": "SomethingElse", "extra": [1, 2, 3] }),
        );
        assert_ne!(a, b); // typed values differ...
        assert_eq!(compute_interface_hash(&a), compute_interface_hash(&b)); // ...but hash is stable.
    }

    #[test]
    fn schema_without_extensions_serializes_without_extra_keys() {
        // Backward compatibility: an empty extension map adds nothing to the wire form.
        let schema = MethodSchema::request(json!(true), json!({ "type": "string" }));
        let value = serde_json::to_value(&schema).unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("params"));
        assert!(obj.contains_key("result"));
        // No stray flattened keys.
        assert_eq!(obj.len(), 2);
    }
}
