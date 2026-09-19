//! Opt-in, schema-described application errors.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use serde_json::Value;

use crate::protocol::jsonrpc::JsonRpcError;
use crate::schema::interface_schema::{component_ref, component_ref_name};
use crate::schema::{Components, ErrorSchema};
use crate::transport::message::TransportError;

/// A closed set of application errors declared by an RPC method.
///
/// Implementations must only recognize an error when its code, normative
/// message, data presence, and data shape all match. A failed recognition
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
    /// Any undeclared or malformed remote JSON-RPC error.
    Remote(JsonRpcError),
    /// A local encode/decode failure unrelated to the transport.
    Local(JsonRpcError),
    /// The transport closed or failed locally; this can never be spoofed by a peer error code.
    Transport(TransportError),
}

impl<E> CallError<E> {
    pub fn from_remote(error: JsonRpcError) -> Self
    where
        E: ApplicationError,
    {
        match E::try_from_rpc_error(error) {
            Ok(error) => Self::Application(error),
            Err(original) => Self::Remote(original),
        }
    }

    pub fn from_call_error(error: crate::client::RpcCallError) -> Self
    where
        E: ApplicationError,
    {
        match error {
            crate::client::RpcCallError::Remote(error) => Self::from_remote(error),
            crate::client::RpcCallError::Local(error) => Self::Local(error),
            crate::client::RpcCallError::Transport(error) => Self::Transport(error),
        }
    }

    pub fn into_rpc_error(self) -> JsonRpcError
    where
        E: ApplicationError,
    {
        match self {
            Self::Application(error) => error.into_rpc_error(),
            Self::Remote(error) => error,
            Self::Local(error) => error,
            Self::Transport(error) => JsonRpcError::new(
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
            Self::Remote(error) => write!(f, "remote error {}: {}", error.code, error.message),
            Self::Local(error) => write!(f, "local error {}: {}", error.code, error.message),
            Self::Transport(error) => error.fmt(f),
        }
    }
}

impl<E: fmt::Debug + fmt::Display> std::error::Error for CallError<E> {}

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
