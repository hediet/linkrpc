//! Opt-in, schema-described application errors.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use serde_json::Value;

use crate::client::RpcCallError;
use crate::protocol::jsonrpc::JsonRpcError;
use crate::schema::interface_schema::{component_ref, component_ref_name};
use crate::schema::{Components, ErrorSchema};

/// LinkRPC's default application-error code (not a JSON-RPC standard code).
pub const DEFAULT_APPLICATION_ERROR_CODE: i32 = 1;

/// A closed set of application errors declared by an RPC method.
///
/// Named errors match code, type, data presence, and data shape, not message.
/// Legacy unnamed errors additionally match the declared message. Failed recognition
/// returns the original wire error unchanged.
pub trait ApplicationError: Sized {
    fn into_rpc_error(self) -> JsonRpcError;
    fn try_from_rpc_error(error: JsonRpcError) -> Result<Self, JsonRpcError>;
    fn error_schemas() -> Vec<ErrorSchema>;
    fn error_components() -> Components {
        Components { schemas: None }
    }
}

/// Failure from a typed RPC call.
#[derive(Clone, Debug, PartialEq)]
pub enum CallError<E> {
    /// A declared, fully validated application error.
    Application(E),
    /// An undeclared remote error, local codec failure, or transport failure.
    Generic(RpcCallError),
}

impl<E> CallError<E> {
    pub fn from_remote(error: JsonRpcError) -> Self
    where
        E: ApplicationError,
    {
        match E::try_from_rpc_error(error) {
            Ok(error) => Self::Application(error),
            Err(original) => Self::Generic(RpcCallError::Remote(original)),
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
            Self::Generic(RpcCallError::Transport(error)) => JsonRpcError::new(
                crate::protocol::jsonrpc::error_codes::INTERNAL_ERROR,
                error.to_string(),
            ),
        }
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
    let name = tagged.get("type").and_then(Value::as_str);
    let payload = tagged.get("data");
    let named = schemas
        .iter()
        .find(|s| s.r#type.as_deref().is_some_and(|ty| Some(ty) == name));
    let declaration = named.filter(|s| s.code == code).or_else(|| {
        if named.is_some() {
            return None;
        }
        schemas
            .iter()
            .find(|s| s.r#type.is_none() && s.code == code && s.message == message)
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
    components: &Components,
) -> Option<Value> {
    let wire_name = error
        .data
        .as_ref()
        .and_then(|data| data.get("type"))
        .and_then(Value::as_str);
    let named = schemas.iter().find(|schema| {
        i64::from(schema.code) == error.code
            && schema
                .r#type
                .as_deref()
                .is_some_and(|name| Some(name) == wire_name)
    });
    // A matching named declaration owns validation, even when malformed.
    // Do not let a permissive legacy payload bypass its envelope or payload checks.
    for declaration in named.into_iter().chain(
        schemas
            .iter()
            .filter(|schema| named.is_none() && schema.r#type.is_none()),
    ) {
        if i64::from(declaration.code) != error.code {
            continue;
        }
        let (name, payload) = if let Some(name) = &declaration.r#type {
            let Some(envelope) = error.data.as_ref().and_then(Value::as_object) else {
                continue;
            };
            if envelope.get("type").and_then(Value::as_str) != Some(name)
                || envelope.keys().any(|k| k != "type" && k != "data")
            {
                continue;
            }
            (name.as_str(), envelope.get("data"))
        } else {
            if error.message != declaration.message {
                continue;
            }
            let Some(binding) = bindings.iter().find(|(name, code, message, _)| {
                *code == declaration.code
                    && *message == declaration.message
                    && !schemas.iter().any(|s| s.r#type.as_deref() == Some(*name))
            }) else {
                continue;
            };
            (binding.0, error.data.as_ref())
        };
        if !bindings.iter().any(|(n, code, _, has_payload)| {
            *n == name && *code == declaration.code && *has_payload == payload.is_some()
        }) || !valid_payload(payload, declaration, components)
        {
            continue;
        }
        let mut tagged = serde_json::json!({ "type": name });
        if let Some(payload) = payload {
            tagged["data"] = payload.clone();
        }
        return Some(tagged);
    }
    None
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
    validate(value, schema, components, &mut HashSet::new())
}

fn validate(
    value: &Value,
    schema: &Value,
    components: Option<&Components>,
    active_refs: &mut HashSet<(usize, String)>,
) -> bool {
    match schema {
        Value::Bool(valid) => *valid,
        Value::Object(obj) => {
            if let Some(reference) = obj.get("$ref").and_then(Value::as_str) {
                let Some(name) = component_ref_name(reference) else {
                    return false;
                };
                let Some(target) = components
                    .and_then(|c| c.schemas.as_ref())
                    .and_then(|schemas| schemas.get(&name))
                else {
                    return false;
                };
                let key = (value as *const Value as usize, name);
                if !active_refs.insert(key.clone()) {
                    return false;
                }
                let result = validate(value, target, components, active_refs);
                active_refs.remove(&key);
                return result;
            }

            if let Some(constant) = obj.get("const") {
                if value != constant {
                    return false;
                }
            }
            if let Some(values) = obj.get("enum").and_then(Value::as_array) {
                if !values.iter().any(|candidate| candidate == value) {
                    return false;
                }
            }
            if let Some(branches) = obj.get("allOf").and_then(Value::as_array) {
                if !branches
                    .iter()
                    .all(|branch| validate(value, branch, components, active_refs))
                {
                    return false;
                }
            }
            if let Some(branches) = obj.get("anyOf").and_then(Value::as_array) {
                if !branches
                    .iter()
                    .any(|branch| validate(value, branch, components, active_refs))
                {
                    return false;
                }
            }
            if let Some(branches) = obj.get("oneOf").and_then(Value::as_array) {
                if !branches
                    .iter()
                    .any(|branch| validate(value, branch, components, active_refs))
                {
                    return false;
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
                            || value
                                .as_f64()
                                .is_some_and(|number| number.is_finite() && number.fract() == 0.0)
                    }
                    "array" => value.is_array(),
                    "object" => value.is_object(),
                    _ => false,
                };
                let valid = match kind {
                    Value::String(kind) => type_matches(kind),
                    Value::Array(kinds) => kinds.iter().filter_map(Value::as_str).any(type_matches),
                    _ => false,
                };
                if !valid {
                    return false;
                }
            }

            if let Some(items) = value.as_array() {
                let prefix_len = obj
                    .get("prefixItems")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                if let Some(prefix) = obj.get("prefixItems").and_then(Value::as_array) {
                    if items.len() < prefix.len()
                        || prefix
                            .iter()
                            .zip(items)
                            .any(|(schema, item)| !validate(item, schema, components, active_refs))
                    {
                        return false;
                    }
                }
                if let Some(item_schema) = obj.get("items") {
                    if !items
                        .iter()
                        .skip(prefix_len)
                        .all(|item| validate(item, item_schema, components, active_refs))
                    {
                        return false;
                    }
                }
            }

            if let Some(instance) = value.as_object() {
                let properties = obj.get("properties").and_then(Value::as_object);
                if let Some(required) = obj.get("required").and_then(Value::as_array) {
                    if required
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|name| !instance.contains_key(name))
                    {
                        return false;
                    }
                }
                for (name, member) in instance {
                    if let Some(member_schema) = properties.and_then(|p| p.get(name)) {
                        if !validate(member, member_schema, components, active_refs) {
                            return false;
                        }
                    } else {
                        match obj.get("additionalProperties") {
                            Some(Value::Bool(false)) => return false,
                            Some(schema) if !validate(member, schema, components, active_refs) => {
                                return false;
                            }

                            _ => {}
                        }
                    }
                }
            }
            true
        }
        _ => false,
    }
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
