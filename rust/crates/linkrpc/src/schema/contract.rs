//! A static endpoint contract separates interface identity from its addresses.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::{compute_interface_hash, LinkRpcInterfaceSchema};

/// An exact interface identity; hashes are never resolved by id alone.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InterfaceRef {
    #[serde(rename = "interfaceId")]
    pub id: String,
    #[serde(rename = "interfaceHash")]
    pub hash: String,
}

impl From<&LinkRpcInterfaceSchema> for InterfaceRef {
    fn from(schema: &LinkRpcInterfaceSchema) -> Self {
        Self {
            id: schema.id.clone(),
            hash: schema.hash.clone(),
        }
    }
}

/// Owned address specification used by tooling and code generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InterfaceAddress {
    Root,
    Service(String),
    Default,
    Bare(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceContract {
    /// The empty id is the root service, not an empty wire-name segment.
    pub service_id: String,
    pub interfaces: Vec<InterfaceRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BareInterfaceContract {
    pub interface: InterfaceRef,
    pub prefix: String,
}

/// Describes schemas and optional root/service/default/bare exposure independently.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkRpcContract {
    pub interface_schemas: Vec<LinkRpcInterfaceSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub services: Option<Vec<ServiceContract>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_interface: Option<InterfaceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bare_interfaces: Option<Vec<BareInterfaceContract>>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ContractError(pub String);

pub(crate) fn valid_service_id(value: &str) -> bool {
    !value.is_empty() && valid_prefix(value)
}

pub(crate) fn valid_prefix(value: &str) -> bool {
    !value.contains("::") && value.bytes().all(|byte| (b' '..=b'~').contains(&byte))
}

impl LinkRpcContract {
    /// Find a schema by exact identity, without falling back to another version.
    pub fn resolve(&self, reference: &InterfaceRef) -> Option<&LinkRpcInterfaceSchema> {
        self.interface_schemas
            .iter()
            .find(|s| s.id == reference.id && s.hash == reference.hash)
    }

    /// Validate identities, schema hashes, references, and unambiguous addresses.
    ///
    /// Nested bare prefixes are allowed and retain longest-prefix dispatch.
    /// A default preset and an empty bare prefix may describe the same exact
    /// interface, but conflict when they reference different identities.
    pub fn validate(&self) -> Result<(), ContractError> {
        let fail = |message: String| ContractError(message);
        let mut identities = BTreeSet::new();
        for schema in &self.interface_schemas {
            if schema.id.is_empty() {
                return Err(fail(format!("invalid interface id `{}`", schema.id)));
            }
            if schema.hash != compute_interface_hash(schema) {
                return Err(fail(format!("invalid hash for interface `{}`", schema.id)));
            }
            schema.validate().map_err(|e| fail(e.to_string()))?;
            let mut fragments = Vec::new();
            for method in schema.methods.values() {
                fragments.push(method.params.clone());
                fragments.extend(method.result.iter().cloned());
                fragments.extend(method.client_stream.iter().cloned());
                fragments.extend(method.server_stream.iter().cloned());
                for error in method.errors.as_deref().unwrap_or_default() {
                    fragments.extend(error.data.iter().cloned());
                    fragments.extend(error.schema.iter().cloned());
                }
            }
            if let Some(components) = schema.components.as_ref().and_then(|c| c.schemas.as_ref()) {
                fragments.extend(components.values().cloned());
            }
            if fragments.is_empty() {
                fragments.push(serde_json::Value::Bool(true));
            }
            super::schemars_subset::validate_guarded_references(
                &fragments,
                schema
                    .components
                    .as_ref()
                    .and_then(|c| c.schemas.as_ref())
                    .unwrap_or(&Default::default()),
            )
            .map_err(|error| {
                fail(format!(
                    "invalid references for interface `{}`: {error}",
                    schema.id
                ))
            })?;
            let validation_schema = serde_json::json!({
                "allOf": fragments,
                "components": schema.components,
            });
            jsonschema::JSONSchema::compile(&validation_schema).map_err(|error| {
                fail(format!(
                    "invalid schema for interface `{}`: {error}",
                    schema.id
                ))
            })?;
            for member in schema.methods.keys() {
                if member.is_empty() {
                    return Err(fail(format!("invalid member name `{member}`")));
                }
            }
            if !identities.insert(InterfaceRef::from(schema)) {
                return Err(fail(format!(
                    "duplicate interface `{}`",
                    schema.id_at_hash()
                )));
            }
        }
        let resolve = |reference: &InterfaceRef| {
            self.resolve(reference).ok_or_else(|| {
                fail(format!(
                    "unknown interface `{}@{}`",
                    reference.id, reference.hash
                ))
            })
        };
        let mut services = BTreeSet::new();
        let mut root = std::collections::BTreeMap::new();
        for service in self.services.as_deref().unwrap_or_default() {
            if !service.service_id.is_empty() && !valid_service_id(&service.service_id) {
                return Err(fail(format!("invalid service id `{}`", service.service_id)));
            }
            if !services.insert(&service.service_id) {
                return Err(fail(format!("duplicate service `{}`", service.service_id)));
            }
            let mut ids = BTreeSet::new();
            for reference in &service.interfaces {
                resolve(reference)?;
                if !ids.insert(&reference.id) {
                    return Err(fail(format!(
                        "conflicting interface `{}` in service `{}`",
                        reference.id, service.service_id
                    )));
                }
                if service.service_id.is_empty() {
                    root.insert(&reference.id, &reference.hash);
                }
            }
        }
        let mut prefixes = BTreeSet::new();
        if let Some(reference) = &self.default_interface {
            resolve(reference)?;
            if root
                .get(&reference.id)
                .is_some_and(|hash| **hash != reference.hash)
            {
                return Err(fail(format!(
                    "default interface conflicts with root `{}`",
                    reference.id
                )));
            }
        }
        for binding in self.bare_interfaces.as_deref().unwrap_or_default() {
            resolve(&binding.interface)?;
            if binding.prefix.is_empty()
                && self
                    .default_interface
                    .as_ref()
                    .is_some_and(|reference| reference != &binding.interface)
            {
                return Err(fail(
                    "empty bare prefix conflicts with defaultInterface".into(),
                ));
            }
            if !valid_prefix(&binding.prefix) {
                return Err(fail(format!("invalid bare prefix `{}`", binding.prefix)));
            }
            if !prefixes.insert(binding.prefix.as_str()) {
                return Err(fail(format!("duplicate bare prefix `{}`", binding.prefix)));
            }
        }
        Ok(())
    }
}
