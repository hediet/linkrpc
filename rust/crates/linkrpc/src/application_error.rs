//! Opt-in, schema-described application errors.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use serde_json::Value;

use crate::client::RpcCallError;
use crate::protocol::jsonrpc::JsonRpcError;
use crate::schema::interface_schema::{component_ref, component_ref_name};
use crate::schema::{Components, ErrorSchema};

/// A validation failure, located by a JSON Pointer relative to the wire error object.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ValidationIssue {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ApplicationErrorDecodeError {
    Unhandled(JsonRpcError),
    Invalid {
        original: Box<JsonRpcError>,
        issues: Vec<ValidationIssue>,
    },
}

/// LinkRPC's default application-error code (not a JSON-RPC standard code).
pub const DEFAULT_APPLICATION_ERROR_CODE: i32 = 1;

/// A closed set of application errors declared by an RPC method.
///
/// Codes select the handled set. The decoder decides which values are accepted;
/// a decoding failure for a handled code is never an unhandled error.
pub trait ApplicationError: Sized {
    fn into_rpc_error(self) -> JsonRpcError;
    fn try_from_rpc_error(error: JsonRpcError) -> Result<Self, JsonRpcError>;
    fn try_from_rpc_error_detailed(
        error: JsonRpcError,
    ) -> Result<Self, ApplicationErrorDecodeError> {
        let schemas = Self::error_schemas();
        if !schemas
            .iter()
            .any(|schema| i64::from(schema.code) == error.code)
        {
            return Err(ApplicationErrorDecodeError::Unhandled(error));
        }
        Self::try_from_rpc_error(error).map_err(|original| ApplicationErrorDecodeError::Invalid {
            original: Box::new(original),
            issues: vec![ValidationIssue {
                path: String::new(),
                message: "declared error could not be decoded by its Rust binding".into(),
            }],
        })
    }
    fn error_schemas() -> Vec<ErrorSchema>;
    fn error_components() -> Components {
        Components { schemas: None }
    }
}

/// Selects the error surface of generated clients.
///
/// The derive implements this separately from `ApplicationError` so existing
/// handwritten wire codecs remain source-compatible. Handwritten codecs used
/// in generated clients can choose `CallError<Self>` and delegate to
/// `CallError::from_call_error`.
pub trait ClientApplicationError: ApplicationError {
    type ClientError;
    fn from_call_error(error: RpcCallError) -> Self::ClientError;
}

/// Failure from a typed RPC call.
#[derive(Clone, Debug, PartialEq)]
pub enum CallError<E> {
    /// A declared, successfully decoded application error.
    Application(E),
    /// An undeclared or invalid remote error, local codec failure, or transport failure.
    Generic(RpcCallError),
}

impl<E> CallError<E> {
    pub fn from_remote(error: JsonRpcError) -> Self
    where
        E: ApplicationError,
    {
        match E::try_from_rpc_error_detailed(error) {
            Ok(error) => Self::Application(error),
            Err(ApplicationErrorDecodeError::Unhandled(original)) => {
                Self::Generic(RpcCallError::Remote(original))
            }
            Err(ApplicationErrorDecodeError::Invalid { original, issues }) => {
                Self::Generic(RpcCallError::NonCompliantServer { original, issues })
            }
        }
    }

    pub fn from_call_error(error: crate::client::RpcCallError) -> Self
    where
        E: ApplicationError,
    {
        match error {
            crate::client::RpcCallError::Remote(error) => Self::from_remote(error),
            error => Self::Generic(error),
        }
    }

    pub fn into_rpc_error(self) -> JsonRpcError
    where
        E: ApplicationError,
    {
        match self {
            Self::Application(error) => error.into_rpc_error(),
            Self::Generic(RpcCallError::Remote(error) | RpcCallError::Local(error)) => error,
            Self::Generic(RpcCallError::NonCompliantServer { original, .. }) => *original,
            Self::Generic(RpcCallError::Transport(error)) => JsonRpcError::new(
                crate::protocol::jsonrpc::error_codes::INTERNAL_ERROR,
                error.to_string(),
            ),
        }
    }
}

impl<E: ApplicationError> From<RpcCallError> for CallError<E> {
    fn from(error: RpcCallError) -> Self {
        Self::from_call_error(error)
    }
}

impl<E: fmt::Display> fmt::Display for CallError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Application(error) => error.fmt(f),
            Self::Generic(RpcCallError::Remote(error)) => {
                write!(f, "remote error {}: {}", error.code, error.message)
            }
            Self::Generic(RpcCallError::Local(error)) => {
                write!(f, "local error {}: {}", error.code, error.message)
            }
            Self::Generic(RpcCallError::NonCompliantServer { original, issues }) => {
                write!(
                    f,
                    "non-compliant server error {}: {} ({issues:?})",
                    original.code, original.message
                )
            }
            Self::Generic(RpcCallError::Transport(error)) => error.fmt(f),
        }
    }
}

impl<E: fmt::Debug + fmt::Display> std::error::Error for CallError<E> {}

/// Runtime support for the derive: binds Rust variants to either named or legacy contracts.
#[doc(hidden)]
pub fn encode_application_error(
    tagged: Value,
    code: i32,
    message: &str,
    schemas: &[ErrorSchema],
    components: &Components,
) -> JsonRpcError {
    if let Some(schema) = schemas
        .iter()
        .find(|s| s.code == code && s.schema.is_some())
        .and_then(|s| s.schema.as_ref())
    {
        let body = tagged.get("data").cloned().unwrap_or(Value::Null);
        let Some(message) = body.get("message").and_then(Value::as_str) else {
            return JsonRpcError::new(-32603, "raw error body requires a string message");
        };
        let error = JsonRpcError {
            code: i64::from(code),
            message: message.to_owned(),
            data: body.get("data").cloned(),
        };
        if body
            .as_object()
            .is_some_and(|body| body.keys().all(|key| key == "message" || key == "data"))
            && validate_json_schema(&body, schema, Some(components))
        {
            return error;
        }
        return JsonRpcError::new(-32603, "raw error body does not match its declared schema");
    }
    let name = tagged.get("type").and_then(Value::as_str);
    let payload = tagged.get("data");
    let named = schemas
        .iter()
        .find(|s| s.r#type.as_deref().is_some_and(|ty| Some(ty) == name));
    let declaration = named.filter(|s| s.code == code).or_else(|| {
        if named.is_some() {
            return None;
        }
        schemas.iter().find(|s| {
            s.schema.is_none() && s.r#type.is_none() && s.code == code && s.message == message
        })
    });
    let Some(declaration) = declaration.filter(|s| valid_payload(payload, s, components)) else {
        return JsonRpcError::new(
            crate::protocol::jsonrpc::error_codes::INTERNAL_ERROR,
            "application error payload or variant does not match its declared schema",
        );
    };
    JsonRpcError {
        code: i64::from(code),
        message: message.to_owned(),
        data: if declaration.r#type.is_some() {
            Some(tagged)
        } else {
            payload.cloned()
        },
    }
}

#[doc(hidden)]
pub fn decode_application_error(
    error: &JsonRpcError,
    bindings: &[(&str, i32, &str, bool)],
    schemas: &[ErrorSchema],
    _components: &Components,
) -> Option<Value> {
    decode_application_error_candidates(error, bindings, schemas)
        .ok()?
        .into_iter()
        .next()
}

#[doc(hidden)]
pub fn decode_application_error_candidates(
    error: &JsonRpcError,
    bindings: &[(&str, i32, &str, bool)],
    schemas: &[ErrorSchema],
) -> Result<Vec<Value>, Vec<ValidationIssue>> {
    let mut candidates = Vec::new();
    let mut issues = Vec::new();
    for declaration in schemas
        .iter()
        .filter(|s| s.r#type.is_some())
        .chain(schemas.iter().filter(|s| s.r#type.is_none()))
        .filter(|s| i64::from(s.code) == error.code)
    {
        let branch_issues = validate_error_envelope(error, declaration);
        if !branch_issues.is_empty() {
            issues.extend(branch_issues);
            continue;
        }
        let raw_body = error_body(error);
        let (binding, payload) = if declaration.schema.is_some() {
            (
                bindings
                    .iter()
                    .find(|(_, code, _, _)| *code == declaration.code),
                Some(&raw_body),
            )
        } else if let Some(name) = &declaration.r#type {
            (
                bindings
                    .iter()
                    .find(|(n, code, _, _)| *n == name && *code == declaration.code),
                error.data.as_ref().and_then(|v| v.get("data")),
            )
        } else {
            (
                bindings.iter().find(|(name, code, message, _)| {
                    *code == declaration.code
                        && *message == declaration.message
                        && !schemas.iter().any(|s| s.r#type.as_deref() == Some(*name))
                }),
                error.data.as_ref(),
            )
        };
        let Some((name, _, _, has_payload)) =
            binding.filter(|(_, _, _, has_payload)| *has_payload == payload.is_some())
        else {
            issues.push(ValidationIssue {
                path: String::new(),
                message: "no Rust binding matches the declared error body".into(),
            });
            continue;
        };
        let mut tagged = serde_json::json!({ "type": name });
        if *has_payload {
            tagged["data"] = payload.cloned().expect("payload presence checked");
        }
        candidates.push(tagged);
    }
    if candidates.is_empty() {
        Err(issues)
    } else {
        Ok(candidates)
    }
}

#[doc(hidden)]
pub fn deserialize_application_error<T: serde::de::DeserializeOwned>(
    tagged: Value,
    payload_path: &str,
) -> Result<T, ValidationIssue> {
    serde_path_to_error::deserialize(tagged).map_err(|error| {
        let mut path = String::new();
        for segment in error.path() {
            match segment {
                serde_path_to_error::Segment::Seq { index } => {
                    path = pointer_child(&path, &index.to_string());
                }
                serde_path_to_error::Segment::Map { key } => {
                    path = pointer_child(&path, key);
                }
                serde_path_to_error::Segment::Enum { .. }
                | serde_path_to_error::Segment::Unknown => {}
            }
        }
        ValidationIssue {
            path: format!(
                "{payload_path}{}",
                path.strip_prefix("/data").unwrap_or(&path)
            ),
            message: error.inner().to_string(),
        }
    })
}

fn error_body(error: &JsonRpcError) -> Value {
    let mut body = serde_json::json!({ "message": error.message });
    if let Some(data) = &error.data {
        body["data"] = data.clone();
    }
    body
}

fn validate_error_envelope(error: &JsonRpcError, schema: &ErrorSchema) -> Vec<ValidationIssue> {
    if schema.schema.is_some() {
        return Vec::new();
    }
    let mut issues = Vec::new();
    let (payload, path) = if let Some(name) = &schema.r#type {
        let Some(envelope) = error.data.as_ref().and_then(Value::as_object) else {
            return vec![ValidationIssue {
                path: "/data".into(),
                message: "expected a tagged error object".into(),
            }];
        };
        if envelope.get("type").and_then(Value::as_str) != Some(name) {
            issues.push(ValidationIssue {
                path: "/data/type".into(),
                message: format!("expected error type {name:?}"),
            });
        }
        for key in envelope
            .keys()
            .filter(|key| *key != "type" && *key != "data")
        {
            issues.push(ValidationIssue {
                path: pointer_child("/data", key),
                message: "unexpected property".into(),
            });
        }
        (envelope.get("data"), "/data/data")
    } else {
        if error.message != schema.message {
            issues.push(ValidationIssue {
                path: "/message".into(),
                message: format!("expected message {:?}", schema.message),
            });
        }
        (error.data.as_ref(), "/data")
    };
    match (payload, &schema.data) {
        (None, None) => {}
        (Some(_), Some(_)) => {}
        (None, Some(_)) => issues.push(ValidationIssue {
            path: path.into(),
            message: "required property is missing".into(),
        }),
        (Some(_), None) => issues.push(ValidationIssue {
            path: path.into(),
            message: "unexpected property".into(),
        }),
    }
    issues
}

fn valid_payload(payload: Option<&Value>, schema: &ErrorSchema, components: &Components) -> bool {
    match (payload, &schema.data) {
        (None, None) => true,
        (Some(payload), Some(schema)) => validate_json_schema(payload, schema, Some(components)),
        _ => false,
    }
}

/// Validate a value against the normalized LinkRPC JSON Schema subset.
///
/// References into `#/components/schemas/*` are resolved lazily, so recursive
/// component graphs are supported. Cycles are bounded by the finite input
/// value rather than rejected.
pub fn validate_json_schema(
    value: &Value,
    schema: &Value,
    components: Option<&Components>,
) -> bool {
    validate_json_schema_issues(value, schema, components).is_empty()
}

pub fn validate_json_schema_issues(
    value: &Value,
    schema: &Value,
    components: Option<&Components>,
) -> Vec<ValidationIssue> {
    validate(value, schema, components)
}

fn pointer_child(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn validate(
    value: &Value,
    schema: &Value,
    components: Option<&Components>,
) -> Vec<ValidationIssue> {
    enum Step<'a> {
        Check(&'a Value, &'a Value, String),
        Merge(usize),
        Union(usize, String, &'static str),
        ExitRef((usize, String)),
    }
    let mut pending = vec![Step::Check(value, schema, String::new())];
    let mut results: Vec<Vec<ValidationIssue>> = Vec::new();
    let mut active_refs = HashSet::new();
    while let Some(step) = pending.pop() {
        let (value, schema, path) = match step {
            Step::Check(value, schema, path) => (value, schema, path),
            Step::ExitRef(key) => {
                active_refs.remove(&key);
                continue;
            }
            Step::Merge(count) => {
                let children = results.split_off(results.len() - count);
                results.push(children.into_iter().flatten().collect());
                continue;
            }
            Step::Union(count, path, keyword) => {
                let children = results.split_off(results.len() - count);
                if children.iter().any(Vec::is_empty) {
                    results.push(Vec::new());
                } else {
                    let mut issues = vec![ValidationIssue {
                        path,
                        message: format!("value does not match any {keyword} branch"),
                    }];
                    issues.extend(children.into_iter().flatten());
                    results.push(issues);
                }
                continue;
            }
        };
        let mut issues = Vec::new();
        let mut children = Vec::new();
        let mut child_count = 0;
        let issue = |message: String| ValidationIssue {
            path: path.clone(),
            message,
        };
        match schema {
            Value::Bool(true) => {}
            Value::Bool(false) => issues.push(issue("value is forbidden by schema".into())),
            Value::Object(obj) => {
                if let Some(reference) = obj.get("$ref").and_then(Value::as_str) {
                    if let Some((name, target)) = component_ref_name(reference).and_then(|name| {
                        components
                            .and_then(|c| c.schemas.as_ref())
                            .and_then(|schemas| schemas.get(&name))
                            .map(|target| (name, target))
                    }) {
                        let key = (value as *const Value as usize, name);
                        if active_refs.insert(key.clone()) {
                            pending.push(Step::ExitRef(key));
                            pending.push(Step::Check(value, target, path));
                            continue;
                        }
                        issues.push(issue(format!(
                            "unguarded recursive schema reference {reference:?}"
                        )));
                    } else {
                        issues.push(issue(format!("unresolved schema reference {reference:?}")));
                    }
                    results.push(issues);
                    continue;
                }

                if let Some(constant) = obj.get("const") {
                    if value != constant {
                        issues.push(issue(format!("expected constant {constant}")));
                    }
                }
                if let Some(values) = obj.get("enum").and_then(Value::as_array) {
                    if !values.iter().any(|candidate| candidate == value) {
                        issues.push(issue("value does not match any enum member".into()));
                    }
                }
                if let Some(branches) = obj.get("allOf").and_then(Value::as_array) {
                    for branch in branches {
                        children.push(Step::Check(value, branch, path.clone()));
                        child_count += 1;
                    }
                }
                for keyword in ["anyOf", "oneOf"] {
                    if let Some(branches) = obj.get(keyword).and_then(Value::as_array) {
                        children.push(Step::Union(branches.len(), path.clone(), keyword));
                        for branch in branches {
                            children.push(Step::Check(value, branch, path.clone()));
                        }
                        child_count += 1;
                    }
                }

                if let Some(kind) = obj.get("type") {
                    let type_matches = |kind: &str| match kind {
                        "null" => value.is_null(),
                        "boolean" => value.is_boolean(),
                        "string" => value.is_string(),
                        "number" => value.is_number(),
                        "integer" => {
                            value.as_i64().is_some()
                                || value.as_u64().is_some()
                                || value.as_f64().is_some_and(|number| {
                                    number.is_finite() && number.fract() == 0.0
                                })
                        }
                        "array" => value.is_array(),
                        "object" => value.is_object(),
                        _ => false,
                    };
                    let valid = match kind {
                        Value::String(kind) => type_matches(kind),
                        Value::Array(kinds) => {
                            kinds.iter().filter_map(Value::as_str).any(type_matches)
                        }
                        _ => false,
                    };
                    if !valid {
                        issues.push(issue(format!("expected type {kind}")));
                        results.push(issues);
                        continue;
                    }
                }

                if let Some(items) = value.as_array() {
                    let prefix_len = obj
                        .get("prefixItems")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    if let Some(prefix) = obj.get("prefixItems").and_then(Value::as_array) {
                        if items.len() < prefix.len() {
                            issues.push(issue(format!(
                                "expected at least {} tuple items",
                                prefix.len()
                            )));
                        }
                        for (index, (schema, item)) in prefix.iter().zip(items).enumerate() {
                            children.push(Step::Check(
                                item,
                                schema,
                                pointer_child(&path, &index.to_string()),
                            ));
                            child_count += 1;
                        }
                    }
                    if let Some(item_schema) = obj.get("items") {
                        for (index, item) in items.iter().enumerate().skip(prefix_len) {
                            children.push(Step::Check(
                                item,
                                item_schema,
                                pointer_child(&path, &index.to_string()),
                            ));
                            child_count += 1;
                        }
                    }
                }

                if let Some(instance) = value.as_object() {
                    let properties = obj.get("properties").and_then(Value::as_object);
                    if let Some(required) = obj.get("required").and_then(Value::as_array) {
                        for name in required
                            .iter()
                            .filter_map(Value::as_str)
                            .filter(|name| !instance.contains_key(*name))
                        {
                            issues.push(ValidationIssue {
                                path: pointer_child(&path, name),
                                message: "required property is missing".into(),
                            });
                        }
                    }
                    for (name, member) in instance {
                        if let Some(member_schema) = properties.and_then(|p| p.get(name)) {
                            children.push(Step::Check(
                                member,
                                member_schema,
                                pointer_child(&path, name),
                            ));
                            child_count += 1;
                        } else {
                            match obj.get("additionalProperties") {
                                Some(Value::Bool(false)) => issues.push(ValidationIssue {
                                    path: pointer_child(&path, name),
                                    message: "unexpected property".into(),
                                }),
                                Some(schema) => {
                                    children.push(Step::Check(
                                        member,
                                        schema,
                                        pointer_child(&path, name),
                                    ));
                                    child_count += 1;
                                }

                                _ => {}
                            }
                        }
                    }
                }
            }
            _ => issues.push(issue("invalid JSON schema".into())),
        }
        results.push(issues);
        pending.push(Step::Merge(child_count + 1));
        pending.extend(children);
    }
    results.pop().expect("root validation result")
}

/// Prefix component names and schema-position references for a method-local
/// error contract. JSON values under `const`/`enum` are never interpreted as schemas.
pub fn scope_error_contract(scope: &str, errors: &mut [ErrorSchema], components: &mut Components) {
    let Some(schemas) = components.schemas.take() else {
        return;
    };
    let names: BTreeMap<String, String> = schemas
        .keys()
        .map(|name| (name.clone(), format!("{scope}.{name}")))
        .collect();
    let mut scoped = BTreeMap::new();
    for (name, mut schema) in schemas {
        rewrite_schema_refs(&mut schema, &names);
        scoped.insert(names[&name].clone(), schema);
    }
    for error in errors {
        if let Some(schema) = &mut error.data {
            rewrite_schema_refs(schema, &names);
        }
        if let Some(schema) = &mut error.schema {
            rewrite_schema_refs(schema, &names);
        }
    }
    components.schemas = Some(scoped);
}

fn rewrite_schema_refs(schema: &mut Value, names: &BTreeMap<String, String>) {
    let Value::Object(object) = schema else {
        return;
    };
    if let Some(Value::String(reference)) = object.get_mut("$ref") {
        if let Some(name) = component_ref_name(reference) {
            if let Some(scoped) = names.get(&name) {
                *reference = component_ref(scoped);
            }
        }

        return;
    }

    if let Some(Value::Object(properties)) = object.get_mut("properties") {
        for property in properties.values_mut() {
            rewrite_schema_refs(property, names);
        }
    }
    for keyword in ["items", "additionalProperties"] {
        if let Some(child) = object.get_mut(keyword) {
            rewrite_schema_refs(child, names);
        }
    }
    for keyword in ["prefixItems", "anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(children)) = object.get_mut(keyword) {
            for child in children {
                rewrite_schema_refs(child, names);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validator_supports_escaped_refs_and_structural_one_of() {
        let components = Components {
            schemas: Some(BTreeMap::from([(
                "a/b~c".into(),
                json!({ "oneOf": [{ "type": "number" }, { "type": "integer" }] }),
            )])),
        };
        assert!(validate_json_schema(
            &json!(1.0),
            &json!({ "$ref": "#/components/schemas/a~1b~0c" }),
            Some(&components),
        ));
    }

    #[test]
    fn validator_handles_deep_guarded_recursion_without_depth_cutoff() {
        let components = Components {
            schemas: Some(BTreeMap::from([(
                "Node".into(),
                json!({
                    "type": "object",
                    "properties": {
                        "next": {
                            "anyOf": [
                                { "type": "null" },
                                { "$ref": "#/components/schemas/Node" }
                            ]
                        }
                    },
                    "required": ["next"],
                    "additionalProperties": false
                }),
            )])),
        };
        let mut value = Value::Null;
        for _ in 0..300 {
            value = json!({ "next": value });
        }
        assert!(validate_json_schema(
            &value,
            &json!({ "$ref": "#/components/schemas/Node" }),
            Some(&components),
        ));
    }

    #[test]
    fn validator_rejects_reference_only_cycles() {
        let components = Components {
            schemas: Some(BTreeMap::from([
                ("A".into(), json!({ "$ref": "#/components/schemas/B" })),
                ("B".into(), json!({ "$ref": "#/components/schemas/A" })),
            ])),
        };
        assert!(!validate_json_schema(
            &json!("anything"),
            &json!({ "$ref": "#/components/schemas/A" }),
            Some(&components),
        ));
    }

    #[test]
    fn scoping_rewrites_only_schema_refs() {
        let mut errors = vec![ErrorSchema {
            code: 1,
            schema: None,
            r#type: None,
            message: "x".into(),
            data: Some(json!({
                "type": "object",
                "properties": {
                    "child": { "$ref": "#/components/schemas/a~1b" },
                    "literal": { "const": { "$ref": "#/components/schemas/a~1b" } }
                }
            })),
        }];
        let mut components = Components {
            schemas: Some(BTreeMap::from([(
                "a/b".into(),
                json!({ "type": "string" }),
            )])),
        };
        scope_error_contract("method.Code1", &mut errors, &mut components);
        assert_eq!(
            errors[0].data.as_ref().unwrap()["properties"]["child"]["$ref"],
            "#/components/schemas/method.Code1.a~1b"
        );
        assert_eq!(
            errors[0].data.as_ref().unwrap()["properties"]["literal"]["const"]["$ref"],
            "#/components/schemas/a~1b"
        );
    }
}
