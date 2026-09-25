//! Bridges `schemars` output into the normalized linkrpc JSON Schema subset.
//!
//! This module exposes two intentionally different paths:
//!
//! - [`schemars_to_subset`] is the original standalone bridge. It inlines a serialized root's
//!   definitions and therefore rejects recursive references.
//! - [`InterfaceSchemaCollector`] is the interface-scoped bridge used by the trait macro. It uses
//!   one generator for all parameter/result roots and retains reachable shared or recursive
//!   definitions in `components.schemas`.
//!
//! `schemars` (draft-07) and zod's `toJSONSchema` describe the same types differently. This
//! standalone pre-pass erases the incidental differences **before** the language-agnostic
//! normalize runs:
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
//! Both paths use the shared `normalize_json_schema` for required-sort, object closure,
//! discriminator synthesis, and `{}`/`{"not":{}}` collapse. The standalone path targets
//! inline Zod parity; shared exports instead require consumers to preserve the component names
//! and reference topology to retain the same interface hash.

use crate::protocol::json_value::{JsonMap, JsonValue};
use crate::schema::interface_schema::component_ref;
use crate::schema::interface_schema::Components;
use crate::schema::normalize::{normalize_json_schema, NormalizeError};
use schemars::r#gen::{SchemaGenerator, SchemaSettings};
use schemars::schema::Schema;
use schemars::JsonSchema;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

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
                if let Some(name) = decoded_ref_target(reference)
                    .or_else(|| raw_ref_target(reference).map(str::to_string))
                {
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

type GenerateRoot = fn(&mut SchemaGenerator) -> Schema;
type GenerateSnapshot = fn() -> Result<ContractSnapshot, SchemarsSubsetError>;

struct RootRegistration {
    rust_type: &'static str,
    generate: GenerateRoot,
    snapshot: GenerateSnapshot,
}

#[derive(PartialEq)]
struct ContractSnapshot {
    root: JsonValue,
    definitions: BTreeMap<String, JsonValue>,
}

/// Collects all schemas for one interface through a single schemars generator.
///
/// Root types must be registered before [`Self::initialize`]. Initialization generates roots in
/// sorted `JsonSchema::schema_id()` order, which makes schemars' collision suffixes independent of
/// method declaration order for a fixed type graph. Adding another colliding schema name can still
/// rename components, because schemars 0.8 does not expose its identity-to-name map.
pub struct InterfaceSchemaCollector {
    generator: SchemaGenerator,
    registrations: BTreeMap<String, RootRegistration>,
    roots: BTreeMap<String, Schema>,
    emitted_roots: Vec<JsonValue>,
    initialized: bool,
}

impl Default for InterfaceSchemaCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl InterfaceSchemaCollector {
    pub fn new() -> Self {
        let generator = interface_generator();
        Self {
            generator,
            registrations: BTreeMap::new(),
            roots: BTreeMap::new(),
            emitted_roots: Vec::new(),
            initialized: false,
        }
    }

    /// Register an actual parameter or result type as an interface root.
    pub fn register<T: JsonSchema>(&mut self) -> Result<(), SchemarsSubsetError> {
        if self.initialized {
            return Err(SchemarsSubsetError::AlreadyInitialized);
        }
        fn generate<T: JsonSchema>(generator: &mut SchemaGenerator) -> Schema {
            generator.subschema_for::<T>()
        }
        fn snapshot<T: JsonSchema>() -> Result<ContractSnapshot, SchemarsSubsetError> {
            contract_snapshot::<T>()
        }

        let schema_id = T::schema_id().into_owned();
        let rust_type = std::any::type_name::<T>();
        if let Some(previous) = self.registrations.get(&schema_id) {
            // Box<T>, Arc<T>, references, and transparent derives intentionally forward T's
            // identity. Only reject a reused identity when its isolated contract graph differs.
            if previous.rust_type != rust_type && (previous.snapshot)()? != snapshot::<T>()? {
                return Err(SchemarsSubsetError::DuplicateSchemaId {
                    schema_id,
                    first_type: previous.rust_type,
                    second_type: rust_type,
                });
            }
            return Ok(());
        }
        self.registrations.insert(
            schema_id,
            RootRegistration {
                rust_type,
                generate: generate::<T>,
                snapshot: snapshot::<T>,
            },
        );
        Ok(())
    }

    /// Generate every registered root in canonical schema-identity order.
    pub fn initialize(&mut self) -> Result<(), SchemarsSubsetError> {
        if self.initialized {
            return Ok(());
        }
        let callbacks: Vec<_> = self
            .registrations
            .iter()
            .map(|(id, registration)| (id.clone(), registration.generate))
            .collect();
        for (schema_id, generate) in callbacks {
            self.roots.insert(schema_id, generate(&mut self.generator));
        }
        self.initialized = true;
        Ok(())
    }

    /// Return a registered root schema, preserving references into the eventual components bag.
    pub fn root_schema<T: JsonSchema>(&mut self) -> Result<JsonValue, SchemarsSubsetError> {
        self.ensure_initialized()?;
        let schema_id = T::schema_id().into_owned();
        let raw = self
            .roots
            .get(&schema_id)
            .cloned()
            .ok_or_else(|| SchemarsSubsetError::UnregisteredRoot(schema_id.clone()))?;
        self.materialize(raw)
    }

    /// Generate a non-root schema body inline.
    ///
    /// This is used for the macro's synthetic parameter wrappers so their implementation-only
    /// names never appear in components. All field types must have been registered first.
    pub fn inline_schema<T: JsonSchema>(&mut self) -> Result<JsonValue, SchemarsSubsetError> {
        self.ensure_initialized()?;
        let before: BTreeSet<_> = self.generator.definitions().keys().cloned().collect();
        let raw = T::json_schema(&mut self.generator);
        let after: BTreeSet<_> = self.generator.definitions().keys().cloned().collect();
        if before != after {
            return Err(SchemarsSubsetError::InlineAddedDefinitions);
        }
        self.materialize(raw)
    }

    /// Build the reachable normalized components after all member schemas have been emitted.
    pub fn components(&self) -> Result<Option<Components>, SchemarsSubsetError> {
        self.ensure_initialized()?;
        let names = component_names(self.generator.definitions().keys().cloned());
        let mut definitions = BTreeMap::new();
        for (raw_name, schema) in self.generator.definitions() {
            let raw = serde_json::to_value(schema)?;
            let prepared = prepare_shared_schema(&raw);
            let remapped = remap_schema_refs(&prepared, &names)?;
            definitions.insert(names[raw_name].clone(), normalize_json_schema(&remapped)?);
        }

        let mut pending = VecDeque::new();
        for root in &self.emitted_roots {
            collect_component_refs(root, &mut pending)?;
        }
        let mut reachable = BTreeSet::new();
        while let Some(name) = pending.pop_front() {
            if !reachable.insert(name.clone()) {
                continue;
            }
            let schema = definitions.get(&name).ok_or_else(|| {
                SchemarsSubsetError::UnresolvedRef(format!("#/components/schemas/{name}"))
            })?;
            collect_component_refs(schema, &mut pending)?;
        }

        let schemas: BTreeMap<_, _> = definitions
            .into_iter()
            .filter(|(name, _)| reachable.contains(name))
            .collect();
        validate_guarded_references(&self.emitted_roots, &schemas)?;
        if schemas.is_empty() {
            Ok(None)
        } else {
            Ok(Some(Components {
                schemas: Some(schemas),
            }))
        }
    }

    fn ensure_initialized(&self) -> Result<(), SchemarsSubsetError> {
        if self.initialized {
            Ok(())
        } else {
            Err(SchemarsSubsetError::NotInitialized)
        }
    }

    fn materialize(&mut self, schema: Schema) -> Result<JsonValue, SchemarsSubsetError> {
        let names = component_names(self.generator.definitions().keys().cloned());
        let raw = serde_json::to_value(schema)?;
        let prepared = prepare_shared_schema(&raw);
        let remapped = remap_schema_refs(&prepared, &names)?;
        let normalized = normalize_json_schema(&remapped)?;
        self.emitted_roots.push(normalized.clone());
        Ok(normalized)
    }
}

fn interface_generator() -> SchemaGenerator {
    let settings = SchemaSettings::draft07().with(|settings| {
        settings.meta_schema = None;
        // In particular, do not run draft-07's RemoveRefSiblings visitor: descriptions on
        // reference sites are part of the contract and `allOf` is outside our subset.
        settings.visitors.clear();
    });
    settings.into_generator()
}

fn contract_snapshot<T: JsonSchema>() -> Result<ContractSnapshot, SchemarsSubsetError> {
    let mut generator = interface_generator();
    let root = generator.subschema_for::<T>();
    let raw = serde_json::to_value(root)?;
    let root = normalize_json_schema(&prepare_shared_schema(&raw))?;
    let mut definitions = BTreeMap::new();
    for (name, schema) in generator.definitions() {
        let raw = serde_json::to_value(schema)?;
        let prepared = prepare_shared_schema(&raw);
        definitions.insert(name.clone(), normalize_json_schema(&prepared)?);
    }
    Ok(ContractSnapshot { root, definitions })
}

fn component_names(raw_names: impl Iterator<Item = String>) -> BTreeMap<String, String> {
    let raw_names: BTreeSet<_> = raw_names.collect();
    let mut used: BTreeSet<String> = raw_names
        .iter()
        .filter(|name| is_readable_component_name(name))
        .cloned()
        .collect();
    let mut result = BTreeMap::new();
    for raw in raw_names {
        let name = if is_readable_component_name(&raw) {
            raw.clone()
        } else {
            let mut encoded = String::from("__linkrpc_");
            for byte in raw.as_bytes() {
                use std::fmt::Write;
                write!(encoded, "{byte:02X}").expect("writing to String cannot fail");
            }
            while used.contains(&encoded) {
                encoded.push('_');
            }
            used.insert(encoded.clone());
            encoded
        };
        result.insert(raw, name);
    }
    result
}

fn is_readable_component_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn prepare_shared_schema(value: &JsonValue) -> JsonValue {
    let JsonValue::Object(object) = value else {
        return value.clone();
    };
    let is_numeric = matches!(
        object.get("type").and_then(JsonValue::as_str),
        Some("number") | Some("integer")
    );
    let mut out = JsonMap::new();
    for (key, value) in object {
        match key.as_str() {
            "$schema" | "title" | "definitions" | "$defs" => continue,
            "format" if is_numeric => continue,
            "properties" => {
                let properties = match value {
                    JsonValue::Object(properties) => properties
                        .iter()
                        .map(|(name, schema)| (name.clone(), prepare_shared_schema(schema)))
                        .collect(),
                    _ => JsonMap::new(),
                };
                out.insert(key.clone(), JsonValue::Object(properties));
            }
            "items" | "additionalProperties" | "not" => {
                out.insert(key.clone(), prepare_shared_schema(value));
            }
            "prefixItems" | "anyOf" | "oneOf" | "allOf" => {
                let schemas = value
                    .as_array()
                    .map(|schemas| schemas.iter().map(prepare_shared_schema).collect())
                    .unwrap_or_default();
                out.insert(key.clone(), JsonValue::Array(schemas));
            }
            _ => {
                out.insert(key.clone(), value.clone());
            }
        }
    }
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
    JsonValue::Object(out)
}

fn remap_schema_refs(
    value: &JsonValue,
    names: &BTreeMap<String, String>,
) -> Result<JsonValue, SchemarsSubsetError> {
    let JsonValue::Object(object) = value else {
        return Ok(value.clone());
    };
    let mut out = object.clone();
    if let Some(JsonValue::String(reference)) = object.get("$ref") {
        // schemars emits definition names verbatim rather than JSON Pointer-escaping them.
        let raw_name = raw_ref_target(reference)
            .ok_or_else(|| SchemarsSubsetError::UnresolvedRef(reference.clone()))?;
        let component_name = names
            .get(raw_name)
            .ok_or_else(|| SchemarsSubsetError::UnresolvedRef(reference.clone()))?;
        out.insert(
            "$ref".to_string(),
            JsonValue::String(format!("#/components/schemas/{component_name}")),
        );
    }
    for key in ["items", "additionalProperties", "not"] {
        if let Some(value) = object.get(key) {
            out.insert(key.to_string(), remap_schema_refs(value, names)?);
        }
    }
    if let Some(JsonValue::Object(properties)) = object.get("properties") {
        let mut remapped = JsonMap::new();
        for (name, schema) in properties {
            remapped.insert(name.clone(), remap_schema_refs(schema, names)?);
        }
        out.insert("properties".to_string(), JsonValue::Object(remapped));
    }
    for key in ["prefixItems", "anyOf", "oneOf", "allOf"] {
        if let Some(JsonValue::Array(schemas)) = object.get(key) {
            let remapped = schemas
                .iter()
                .map(|schema| remap_schema_refs(schema, names))
                .collect::<Result<_, _>>()?;
            out.insert(key.to_string(), JsonValue::Array(remapped));
        }
    }
    Ok(JsonValue::Object(out))
}

fn collect_component_refs(
    value: &JsonValue,
    refs: &mut VecDeque<String>,
) -> Result<(), SchemarsSubsetError> {
    let JsonValue::Object(object) = value else {
        return Ok(());
    };
    if let Some(JsonValue::String(reference)) = object.get("$ref") {
        let name = reference
            .strip_prefix("#/components/schemas/")
            .filter(|name| !name.is_empty())
            .ok_or_else(|| SchemarsSubsetError::UnresolvedRef(reference.clone()))?;
        refs.push_back(name.to_string());
    }
    for key in ["items", "additionalProperties"] {
        if let Some(value) = object.get(key) {
            collect_component_refs(value, refs)?;
        }
    }
    if let Some(JsonValue::Object(properties)) = object.get("properties") {
        for schema in properties.values() {
            collect_component_refs(schema, refs)?;
        }
    }
    for key in ["prefixItems", "anyOf", "oneOf"] {
        if let Some(JsonValue::Array(schemas)) = object.get(key) {
            for schema in schemas {
                collect_component_refs(schema, refs)?;
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct SchemaReferenceGraph {
    edges: Vec<Vec<usize>>,
    pending_refs: Vec<(usize, String)>,
    component_roots: BTreeMap<String, usize>,
}

impl SchemaReferenceGraph {
    fn new_node(&mut self) -> usize {
        let id = self.edges.len();
        self.edges.push(Vec::new());
        id
    }

    fn add_schema(&mut self, schema: &JsonValue) -> Result<usize, SchemarsSubsetError> {
        let id = self.new_node();
        self.populate_node(id, schema)?;
        Ok(id)
    }

    fn populate_node(&mut self, id: usize, schema: &JsonValue) -> Result<(), SchemarsSubsetError> {
        let JsonValue::Object(object) = schema else {
            return Ok(());
        };
        if let Some(JsonValue::String(reference)) = object.get("$ref") {
            let name = super::interface_schema::component_ref_name(reference)
                .ok_or_else(|| SchemarsSubsetError::UnresolvedRef(reference.clone()))?;
            self.pending_refs.push((id, name));
        }

        for key in ["anyOf", "oneOf", "allOf"] {
            if let Some(JsonValue::Array(schemas)) = object.get(key) {
                for schema in schemas {
                    let child = self.add_schema(schema)?;
                    self.edges[id].push(child);
                }
            }
        }

        for key in ["not", "if", "then", "else"] {
            if let Some(schema) = object.get(key) {
                let child = self.add_schema(schema)?;
                self.edges[id].push(child);
            }
        }
        for key in ["properties", "patternProperties", "dependentSchemas"] {
            if let Some(JsonValue::Object(properties)) = object.get(key) {
                for schema in properties.values() {
                    self.add_schema(schema)?;
                }
            }
        }
        for key in [
            "additionalProperties",
            "propertyNames",
            "contains",
            "additionalItems",
            "unevaluatedProperties",
            "unevaluatedItems",
        ] {
            if let Some(schema) = object.get(key) {
                self.add_schema(schema)?;
            }
        }
        for key in ["prefixItems", "items"] {
            if let Some(JsonValue::Array(schemas)) = object.get(key) {
                for schema in schemas {
                    self.add_schema(schema)?;
                }
            } else if let Some(schema) = object.get(key) {
                self.add_schema(schema)?;
            }
        }
        Ok(())
    }

    fn resolve_refs(&mut self) -> Result<(), SchemarsSubsetError> {
        for (source, name) in &self.pending_refs {
            let target = self.component_roots.get(name).ok_or_else(|| {
                SchemarsSubsetError::UnresolvedRef(format!("#/components/schemas/{name}"))
            })?;
            self.edges[*source].push(*target);
        }
        Ok(())
    }

    fn reject_unguarded_cycles(&self) -> Result<(), SchemarsSubsetError> {
        fn visit(
            node: usize,
            edges: &[Vec<usize>],
            state: &mut [u8],
        ) -> Result<(), SchemarsSubsetError> {
            match state[node] {
                1 => return Err(SchemarsSubsetError::UnguardedRecursiveSchema),
                2 => return Ok(()),
                _ => {}
            }
            state[node] = 1;
            for child in &edges[node] {
                visit(*child, edges, state)?;
            }
            state[node] = 2;
            Ok(())
        }

        let mut state = vec![0; self.edges.len()];
        for node in 0..self.edges.len() {
            visit(node, &self.edges, &mut state)?;
        }
        Ok(())
    }
}

pub(crate) fn validate_guarded_references(
    roots: &[JsonValue],
    components: &BTreeMap<String, JsonValue>,
) -> Result<(), SchemarsSubsetError> {
    let mut graph = SchemaReferenceGraph::default();
    for name in components.keys() {
        let node = graph.new_node();
        graph.component_roots.insert(name.clone(), node);
    }
    for root in roots {
        graph.add_schema(root)?;
    }
    for (name, schema) in components {
        let node = graph.component_roots[name];
        graph.populate_node(node, schema)?;
    }
    graph.resolve_refs()?;
    graph.reject_unguarded_cycles()
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

fn raw_ref_target(s: &str) -> Option<&str> {
    REF_PREFIXES
        .iter()
        .find_map(|prefix| s.strip_prefix(prefix))
        .filter(|name| !name.is_empty())
}

fn decoded_ref_target(s: &str) -> Option<String> {
    let encoded = raw_ref_target(s)?;
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
        let Some(raw_name) = raw_ref_target(r) else {
            return Err(SchemarsSubsetError::UnresolvedRef(r.clone()));
        };
        let name = if defs.contains_key(raw_name) {
            raw_name.to_string()
        } else if let Some(decoded) = decoded_ref_target(r) {
            decoded
        } else {
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
    #[error("interface schema collector was used before initialize()")]
    NotInitialized,
    #[error("interface schema collector cannot register roots after initialize()")]
    AlreadyInitialized,
    #[error("schema root {0} was not registered")]
    UnregisteredRoot(String),
    #[error(
        "schema id {schema_id:?} produces conflicting contracts for Rust types {first_type} and {second_type}"
    )]
    DuplicateSchemaId {
        schema_id: String,
        first_type: &'static str,
        second_type: &'static str,
    },
    #[error("unguarded recursive schema: cycle does not descend into a child value")]
    UnguardedRecursiveSchema,
    #[error("inline schema generation introduced an unregistered component type")]
    InlineAddedDefinitions,
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
    #[error(transparent)]
    Normalize(#[from] NormalizeError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use schemars::schema::{InstanceType, SchemaObject, SubschemaValidation};
    use serde_json::json;
    use std::borrow::Cow;

    #[allow(dead_code)]
    #[derive(JsonSchema)]
    struct AliasTarget {
        value: String,
    }

    struct ConflictingString;
    struct ConflictingInteger;
    struct UnguardedRecursive;

    impl JsonSchema for ConflictingString {
        fn schema_name() -> String {
            "Conflict".to_string()
        }

        fn schema_id() -> Cow<'static, str> {
            Cow::Borrowed("tests::same-id")
        }

        fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
            SchemaObject {
                instance_type: Some(InstanceType::String.into()),
                ..Default::default()
            }
            .into()
        }
    }

    impl JsonSchema for ConflictingInteger {
        fn schema_name() -> String {
            "Conflict".to_string()
        }

        fn schema_id() -> Cow<'static, str> {
            Cow::Borrowed("tests::same-id")
        }

        fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
            SchemaObject {
                instance_type: Some(InstanceType::Integer.into()),
                ..Default::default()
            }
            .into()
        }
    }

    impl JsonSchema for UnguardedRecursive {
        fn schema_name() -> String {
            "UnguardedRecursive".to_string()
        }

        fn schema_id() -> Cow<'static, str> {
            Cow::Borrowed("tests::unguarded-recursive")
        }

        fn json_schema(generator: &mut SchemaGenerator) -> Schema {
            let null = SchemaObject {
                instance_type: Some(InstanceType::Null.into()),
                ..Default::default()
            }
            .into();
            SchemaObject {
                subschemas: Some(Box::new(SubschemaValidation {
                    any_of: Some(vec![null, generator.subschema_for::<Self>()]),
                    ..Default::default()
                })),
                ..Default::default()
            }
            .into()
        }
    }

    #[test]
    fn identity_forwarding_aliases_share_a_registered_root() {
        let mut collector = InterfaceSchemaCollector::new();
        collector.register::<AliasTarget>().unwrap();
        collector.register::<Box<AliasTarget>>().unwrap();
        collector.initialize().unwrap();

        let direct = collector.root_schema::<AliasTarget>().unwrap();
        let boxed = collector.root_schema::<Box<AliasTarget>>().unwrap();
        assert_eq!(direct, boxed);
        assert!(direct.get("$ref").is_some());
        assert_eq!(
            collector
                .components()
                .unwrap()
                .unwrap()
                .schemas
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn conflicting_contracts_with_the_same_schema_id_are_rejected() {
        let mut collector = InterfaceSchemaCollector::new();
        collector.register::<ConflictingString>().unwrap();
        assert!(matches!(
            collector.register::<ConflictingInteger>(),
            Err(SchemarsSubsetError::DuplicateSchemaId { .. })
        ));
    }

    #[test]
    fn collector_rejects_unguarded_union_recursion() {
        let mut collector = InterfaceSchemaCollector::new();
        collector.register::<UnguardedRecursive>().unwrap();
        collector.initialize().unwrap();
        collector.root_schema::<UnguardedRecursive>().unwrap();
        assert!(matches!(
            collector.components(),
            Err(SchemarsSubsetError::UnguardedRecursiveSchema)
        ));
    }

    #[test]
    fn guarded_object_recursion_is_accepted() {
        let node = json!({
            "type": "object",
            "properties": {
                "next": { "$ref": "#/components/schemas/Node" }
            },
            "additionalProperties": false
        });
        assert!(validate_guarded_references(
            std::slice::from_ref(&node),
            &BTreeMap::from([("Node".to_string(), node.clone())])
        )
        .is_ok());
    }

    #[test]
    fn problematic_component_names_are_encoded_injectively() {
        let names = component_names(
            ["A/B", "A~B", "__linkrpc_412F42"]
                .into_iter()
                .map(str::to_string),
        );
        assert_eq!(names["__linkrpc_412F42"], "__linkrpc_412F42");
        assert_eq!(names["A/B"], "__linkrpc_412F42_");
        assert_eq!(names["A~B"], "__linkrpc_417E42");
        assert_eq!(names.values().collect::<BTreeSet<_>>().len(), 3);
    }

    #[test]
    fn shared_preparation_keeps_ref_sibling_descriptions() {
        let raw = json!({
            "$ref": "#/definitions/Thing",
            "title": "FieldName",
            "description": "Normative field docs"
        });
        assert_eq!(
            prepare_shared_schema(&raw),
            json!({
                "$ref": "#/definitions/Thing",
                "description": "Normative field docs"
            })
        );
    }

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
                    "optional": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                    "requiredNullable": { "anyOf": [{ "type": "string" }, { "type": "null" }] }
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
