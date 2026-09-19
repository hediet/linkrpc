//! Bridge raw `schemars` output into the shape the shared
//! [`normalize_json_schema`](crate::schema::normalize::normalize_json_schema) expects, so a
//! Rust-derived schema hashes identically to the equivalent zod-derived one in TypeScript.
//!
//! `schemars` (draft-07) and zod's `toJSONSchema` describe the same types differently. This
//! pre-pass erases the incidental differences **before** the language-agnostic normalize runs:
//!
//! 1. **Inline `$ref`** against the root `definitions` / `$defs` bag and drop the bag — zod
//!    inlines every subschema, schemars factors them out.
//! 2. **Drop `title`** (schemars stamps the Rust type name; `title` is otherwise hash-kept)
//!    and `$schema`.
//! 3. **Drop numeric `format`** (`uint32`, `float`, …) on `number`/`integer` schemas — a
//!    representation hint zod never emits. String formats (`date-time`, `uuid`, …) are kept.
//! 4. **Single-element `enum` → `const`** — schemars lowers a unit/`literal` to `enum: [x]`,
//!    zod to `const: x`; the latter is also what `normalize`'s discriminator synthesis keys on.
//! 5. **Materialize empty `properties` maps** — zod emits `properties: {}` for
//!    empty objects while schemars omits it.
//!
//! After this pass the shared `normalize_json_schema` (required-sort, object closure,
//! discriminator synthesis, `{}`/`{"not":{}}` collapse) yields a value byte-identical to the TS
//! side, and therefore the same interface hash.

use crate::protocol::json_value::{JsonMap, JsonValue};
use crate::schema::interface_schema::component_ref;
use crate::schema::normalize::{normalize_json_schema, NormalizeError};
use std::collections::{BTreeMap, BTreeSet};

const REF_PREFIXES: &[&str] = &["#/definitions/", "#/$defs/"];

/// Convert a serialized `schemars` schema (a `RootSchema` as `serde_json::Value`) into the
/// decidable linkrpc subset. Equivalent to TS `zodToSvcJsonSchema`.
pub fn schemars_to_subset(root: &JsonValue) -> Result<JsonValue, SchemarsSubsetError> {
    let defs = collect_defs(root);
    let mut active = BTreeSet::new();
    let prepared = prepare(root, &defs, &mut active)?;
    Ok(normalize_json_schema(&prepared)?)
}

/// Convert schemars output while preserving definitions as LinkRPC components.
///
/// Unlike [`schemars_to_subset`], this supports recursive schemas by rewriting
/// local schemars references to `#/components/schemas/*`.
pub fn schemars_to_subset_with_components(
    root: &JsonValue,
) -> Result<(JsonValue, BTreeMap<String, JsonValue>), SchemarsSubsetError> {
    let defs = collect_defs(root);
    let root_value = prepare_hoisted(root)?;
    let root_schema = normalize_json_schema(&root_value)?;

    let mut components = BTreeMap::new();
    for (name, schema) in defs {
        components.insert(name, normalize_json_schema(&prepare_hoisted(&schema)?)?);
    }
    Ok((root_schema, components))
}

fn prepare_hoisted(value: &JsonValue) -> Result<JsonValue, SchemarsSubsetError> {
    match value {
        JsonValue::Bool(_) => Ok(value.clone()),
        JsonValue::Object(object) => {
            if let Some(JsonValue::String(reference)) = object.get("$ref") {
                if let Some(name) = ref_target(reference) {
                    let mut out = JsonMap::new();
                    out.insert("$ref".into(), JsonValue::String(component_ref(&name)));
                    return Ok(JsonValue::Object(out));
                }
                return Err(SchemarsSubsetError::UnresolvedRef(reference.clone()));
            }

            let is_numeric = matches!(
                object.get("type").and_then(JsonValue::as_str),
                Some("number") | Some("integer")
            );
            let mut out = JsonMap::new();
            for (key, child) in object {
                match key.as_str() {
                    "$schema" | "title" | "definitions" | "$defs" => continue,
                    "format" if is_numeric => continue,
                    "properties" => {
                        let mut properties_out = JsonMap::new();
                        if let JsonValue::Object(properties) = child {
                            for (name, property) in properties {
                                properties_out.insert(name.clone(), prepare_hoisted(property)?);
                            }
                        }
                        out.insert(key.clone(), JsonValue::Object(properties_out));
                    }
                    "items" | "additionalProperties" => {
                        out.insert(key.clone(), prepare_hoisted(child)?);
                    }
                    "prefixItems" | "anyOf" | "oneOf" => {
                        let values = child
                            .as_array()
                            .map(|children| {
                                children
                                    .iter()
                                    .map(prepare_hoisted)
                                    .collect::<Result<Vec<_>, _>>()
                            })
                            .transpose()?
                            .unwrap_or_default();
                        out.insert(key.clone(), JsonValue::Array(values));
                    }
                    // `const` and `enum` contain JSON data, not schemas.
                    _ => {
                        out.insert(key.clone(), child.clone());
                    }
                }
            }
            if let Some(JsonValue::Array(items)) = out.get("enum") {
                if items.len() == 1 {
                    let only = items[0].clone();
                    out.remove("enum");
                    out.insert("const".into(), only);
                }
            }
            if out.get("type").and_then(JsonValue::as_str) == Some("object")
                && !matches!(out.get("properties"), Some(JsonValue::Object(_)))
            {
                out.insert("properties".into(), JsonValue::Object(JsonMap::new()));
            }
            Ok(JsonValue::Object(out))
        }
        _ => Err(SchemarsSubsetError::Normalize(match value {
            JsonValue::Null => NormalizeError::ExpectedObject("null"),
            JsonValue::Array(_) => NormalizeError::ExpectedObject("array"),
            JsonValue::Number(_) => NormalizeError::ExpectedObject("number"),
            JsonValue::String(_) => NormalizeError::ExpectedObject("string"),
            _ => unreachable!(),
        })),
    }
}

fn collect_defs(root: &JsonValue) -> JsonMap<String, JsonValue> {
    let mut defs = JsonMap::new();
    if let Some(obj) = root.as_object() {
        for key in ["definitions", "$defs"] {
            if let Some(JsonValue::Object(bag)) = obj.get(key) {
                for (name, schema) in bag {
                    defs.insert(name.clone(), schema.clone());
                }
            }
        }
    }
    defs
}

fn ref_target(s: &str) -> Option<String> {
    let encoded = REF_PREFIXES
        .iter()
        .find_map(|p| s.strip_prefix(p))
        .filter(|name| !name.is_empty())?;
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

fn prepare(
    value: &JsonValue,
    defs: &JsonMap<String, JsonValue>,
    active: &mut BTreeSet<String>,
) -> Result<JsonValue, SchemarsSubsetError> {
    match value {
        JsonValue::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for v in arr {
                out.push(prepare(v, defs, active)?);
            }
            Ok(JsonValue::Array(out))
        }
        JsonValue::Object(obj) => prepare_object(obj, defs, active),
        other => Ok(other.clone()),
    }
}

fn prepare_object(
    obj: &JsonMap<String, JsonValue>,
    defs: &JsonMap<String, JsonValue>,
    active: &mut BTreeSet<String>,
) -> Result<JsonValue, SchemarsSubsetError> {
    // Resolve `$ref` by inlining the referenced (and prepared) definition.
    if let Some(JsonValue::String(r)) = obj.get("$ref") {
        let Some(name) = ref_target(r) else {
            return Err(SchemarsSubsetError::UnresolvedRef(r.clone()));
        };
        let Some(target) = defs.get(&name) else {
            return Err(SchemarsSubsetError::UnresolvedRef(r.clone()));
        };
        if !active.insert(name.clone()) {
            return Err(SchemarsSubsetError::RecursiveRef(name));
        }
        let inlined = prepare(target, defs, active)?;
        active.remove(&name);
        return Ok(inlined);
    }

    let is_numeric = matches!(
        obj.get("type").and_then(JsonValue::as_str),
        Some("number") | Some("integer")
    );

    let mut out = JsonMap::new();
    for (k, v) in obj {
        match k.as_str() {
            // schemars bookkeeping that has no place in the decidable subset.
            "$schema" | "title" | "definitions" | "$defs" => continue,
            // Numeric representation hint zod never emits.
            "format" if is_numeric => continue,
            // Property names are user data, not schema keywords. Descend into
            // each property's schema without interpreting names such as
            // `title` or `format` as annotations on this schema node.
            "properties" => {
                let prepared = match v {
                    JsonValue::Object(properties) => {
                        let mut prepared = JsonMap::new();
                        for (name, schema) in properties {
                            prepared.insert(name.clone(), prepare(schema, defs, active)?);
                        }
                        JsonValue::Object(prepared)
                    }
                    other => prepare(other, defs, active)?,
                };
                out.insert(k.clone(), prepared);
                continue;
            }
            _ => {}
        }
        out.insert(k.clone(), prepare(v, defs, active)?);
    }

    // Single-element `enum` ⇒ `const` (schemars lowers literals to a one-element enum).
    if let Some(JsonValue::Array(items)) = out.get("enum") {
        if items.len() == 1 {
            let only = items[0].clone();
            out.remove("enum");
            out.insert("const".to_string(), only);
        }
    }

    if out.get("type").and_then(JsonValue::as_str) == Some("object")
        && !matches!(out.get("properties"), Some(JsonValue::Object(_)))
    {
        out.insert("properties".to_string(), JsonValue::Object(JsonMap::new()));
    }

    Ok(JsonValue::Object(out))
}

/// Errors from [`schemars_to_subset`].
#[derive(Debug, thiserror::Error)]
pub enum SchemarsSubsetError {
    #[error("schemars_to_subset: could not resolve {0}")]
    UnresolvedRef(String),
    #[error("schemars_to_subset: recursive $ref to {0} cannot be inlined into the linkrpc subset")]
    RecursiveRef(String),
    #[error(transparent)]
    Normalize(#[from] NormalizeError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_title_schema_and_numeric_format() {
        let raw = json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": "OrderConfirmation",
            "type": "object",
            "required": ["n"],
            "properties": { "n": { "type": "integer", "format": "uint32", "minimum": 0.0 } }
        });
        let got = schemars_to_subset(&raw).unwrap();
        assert_eq!(
            got,
            json!({
                "type": "object",
                "properties": { "n": { "type": "integer" } },
                "required": ["n"],
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn hoisted_bridge_preserves_normalization_and_literal_ref_data() {
        let raw = json!({
            "title": "Root",
            "type": "object",
            "properties": {
                "child": { "$ref": "#/definitions/a~1b" },
                "literal": {
                    "enum": [{ "$ref": "#/definitions/not-a-schema" }]
                },
                "count": { "type": "integer", "format": "uint32" }
            },
            "required": ["child", "literal", "count"],
            "definitions": {
                "a/b": {
                    "title": "Child",
                    "type": "string",
                    "enum": ["only"]
                }
            }
        });
        let (schema, components) = schemars_to_subset_with_components(&raw).unwrap();
        assert_eq!(
            schema["properties"]["child"]["$ref"],
            "#/components/schemas/a~1b"
        );
        assert_eq!(
            schema["properties"]["literal"]["const"],
            json!({ "$ref": "#/definitions/not-a-schema" })
        );
        assert!(schema["properties"]["count"].get("format").is_none());
        assert_eq!(components["a/b"]["const"], "only");
        assert!(components["a/b"].get("title").is_none());
    }

    #[test]
    fn preserves_property_names_that_match_schema_annotations() {
        let raw = json!({
            "title": "TargetSnapshot",
            "type": "object",
            "properties": {
                "title": { "type": "string" },
                "format": { "type": "string" },
                "definitions": { "type": "boolean" }
            },
            "required": ["title", "format", "definitions"]
        });

        let normalized = schemars_to_subset(&raw).unwrap();
        assert_eq!(
            normalized,
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "format": { "type": "string" },
                    "definitions": { "type": "boolean" }
                },
                "required": ["definitions", "format", "title"],
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn keeps_string_format() {
        let raw = json!({ "type": "string", "format": "date-time" });
        let got = schemars_to_subset(&raw).unwrap();
        assert_eq!(got, json!({ "type": "string", "format": "date-time" }));
    }

    #[test]
    fn inlines_refs_and_drops_definitions() {
        let raw = json!({
            "type": "object",
            "required": ["kind"],
            "properties": { "kind": { "$ref": "#/definitions/Kind" } },
            "definitions": {
                "Kind": { "type": "string", "enum": ["a", "b"] }
            }
        });
        let got = schemars_to_subset(&raw).unwrap();
        assert_eq!(
            got,
            json!({
                "type": "object",
                "properties": { "kind": { "type": "string", "enum": ["a", "b"] } },
                "required": ["kind"],
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn single_element_enum_becomes_const_enabling_discriminator() {
        // Two object branches whose tag is a one-element enum (schemars' lowering
        // of a literal). The subset bridge rewrites them to `const`, and normalize
        // then synthesizes the discriminator — matching zod's output.
        let raw = json!({
            "oneOf": [
                { "type": "object", "required": ["t"],
                  "properties": { "t": { "type": "string", "enum": ["x"] } } },
                { "type": "object", "required": ["t"],
                  "properties": { "t": { "type": "string", "enum": ["y"] } } }
            ]
        });
        let got = schemars_to_subset(&raw).unwrap();
        assert_eq!(got["discriminator"], json!({ "propertyName": "t" }));
        assert_eq!(
            got["oneOf"][0]["properties"]["t"],
            json!({ "type": "string", "const": "x" })
        );
    }

    #[test]
    fn optional_nullable_properties_are_preserved_and_empty_objects_keep_properties() {
        let raw = json!({
            "type": "object",
            "properties": {
                "optional": { "type": ["string", "null"] },
                "requiredNullable": { "type": ["string", "null"] }
            },
            "required": ["requiredNullable"]
        });
        assert_eq!(
            schemars_to_subset(&raw).unwrap(),
            json!({
                "type": "object",
                "properties": {
                    "optional": { "type": ["string", "null"] },
                    "requiredNullable": { "type": ["string", "null"] }
                },
                "required": ["requiredNullable"],
                "additionalProperties": false
            })
        );

        assert_eq!(
            schemars_to_subset(&json!({ "type": "object" })).unwrap(),
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn recursive_ref_is_rejected() {
        let raw = json!({
            "$ref": "#/definitions/Node",
            "definitions": {
                "Node": {
                    "type": "object",
                    "properties": { "next": { "$ref": "#/definitions/Node" } }
                }
            }
        });
        assert!(matches!(
            schemars_to_subset(&raw),
            Err(SchemarsSubsetError::RecursiveRef(_))
        ));
    }
}
