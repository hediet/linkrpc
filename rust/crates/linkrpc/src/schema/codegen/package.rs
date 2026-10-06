use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::schema::{compute_interface_hash, Components, ContractError, LinkRpcInterfaceSchema};

use super::{generate_rust_components, generate_rust_interface, ident, GenerateRustOptions};

/// Source layout, independent of which endpoint offers the interfaces.
///
/// Unlike an endpoint contract, different modules may bind the same wire prefix
/// on separate routers (for example a provider and a consumer).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateRustPackage {
    pub modules: Vec<GenerateRustModule>,
    /// Shared type options and defaults for modules without an override.
    #[serde(default)]
    pub options: GenerateRustOptions,
    #[serde(default)]
    pub facades: Vec<GenerateRustFacade>,
    #[serde(default)]
    pub header: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateRustModule {
    pub name: String,
    pub schema: LinkRpcInterfaceSchema,
    #[serde(default)]
    pub options: Option<GenerateRustOptions>,
}

/// A convenience client and catalog composed from existing named bindings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateRustFacade {
    pub name: String,
    pub catalog: String,
    #[serde(default)]
    pub description: String,
    pub members: Vec<GenerateRustFacadeMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateRustFacadeMember {
    pub name: String,
    pub module: String,
    pub binding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedRustPackage {
    pub files: BTreeMap<String, String>,
    pub unsupported: Vec<String>,
    /// Computed hashes, including those filled in for unhashed input definitions.
    pub interface_hashes: BTreeMap<String, String>,
}

fn identifier(name: &str) -> Result<(), ContractError> {
    let mut chars = name.chars();
    if !chars
        .next()
        .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
        || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
        || name == "_"
        || ident::escape_ident(name.to_owned()) != name
    {
        return Err(ContractError(format!("invalid Rust identifier `{name}`")));
    }
    Ok(())
}

fn module_options<'a>(
    module: &'a GenerateRustModule,
    package: &'a GenerateRustPackage,
) -> &'a GenerateRustOptions {
    module.options.as_ref().unwrap_or(&package.options)
}

/// Generate deterministic sibling modules with shared component identity.
///
/// Empty interface hashes are computed; nonempty hashes must match. Components
/// with the same wire name must agree. Facades do not introduce new addresses:
/// every member selects a binding already declared on its module.
pub fn generate_rust_package(
    package: &GenerateRustPackage,
) -> Result<GeneratedRustPackage, ContractError> {
    let mut components = BTreeMap::new();
    let mut modules = BTreeMap::new();
    let mut interface_hashes = BTreeMap::new();
    for module in &package.modules {
        identifier(&module.name)?;
        if matches!(module.name.as_str(), "mod" | "types")
            || modules.insert(module.name.clone(), module).is_some()
        {
            return Err(ContractError(format!(
                "duplicate/reserved module `{}`",
                module.name
            )));
        }
        let hash = compute_interface_hash(&module.schema);
        if !module.schema.hash.is_empty() && module.schema.hash != hash {
            return Err(ContractError(format!(
                "invalid hash for interface `{}`",
                module.schema.id
            )));
        }
        module
            .schema
            .validate()
            .map_err(|e| ContractError(e.to_string()))?;
        interface_hashes.insert(module.name.clone(), hash);
        if let Some(schemas) = module
            .schema
            .components
            .as_ref()
            .and_then(|c| c.schemas.as_ref())
        {
            for (name, schema) in schemas {
                if components.get(name).is_some_and(|old| old != schema) {
                    return Err(ContractError(format!(
                        "conflicting shared component `{name}`"
                    )));
                }
                components.insert(name.clone(), schema.clone());
            }
        }
        let mut bindings = BTreeSet::new();
        let options = module_options(module, package);
        if let Some(name) = &options.client_name {
            identifier(name)?;
        }
        if let Some(name) = &options.method_type_prefix {
            if !name.is_empty() {
                identifier(name)?;
            }
        }
        for binding in &options.bindings {
            identifier(&binding.name)?;
            match &binding.address {
                super::InterfaceAddress::Bare(prefix)
                    if !crate::schema::contract::valid_prefix(prefix) =>
                {
                    return Err(ContractError(format!("invalid bare prefix `{prefix}`")));
                }
                super::InterfaceAddress::Service(id)
                    if !crate::schema::contract::valid_service_id(id) =>
                {
                    return Err(ContractError(format!("invalid service id `{id}`")));
                }
                _ => {}
            }
            if !bindings.insert(&binding.name) {
                return Err(ContractError(format!(
                    "duplicate binding `{}`",
                    binding.name
                )));
            }
        }
    }
    let shared = generate_rust_components(
        &Components {
            schemas: Some(components),
        },
        &package.options,
    );
    let external_components: BTreeMap<_, _> = shared
        .names
        .iter()
        .map(|(wire, name)| {
            (
                wire.clone(),
                package
                    .options
                    .external_components
                    .get(wire)
                    .cloned()
                    .unwrap_or_else(|| format!("super::types::{name}")),
            )
        })
        .collect();
    let mut files = BTreeMap::from([("types.rs".to_owned(), shared.code)]);
    let mut unsupported = shared.unsupported;
    let mut index = String::from("mod types;\npub use types::*;\n");
    for module in &package.modules {
        let name = &module.name;
        let mut schema = module.schema.clone();
        schema.hash = interface_hashes[name].clone();
        let mut options = module_options(module, package).clone();
        options
            .external_components
            .extend(external_components.clone());
        let generated = generate_rust_interface(&schema, &options);
        unsupported.extend(generated.unsupported);
        files.insert(format!("{name}.rs"), generated.code);
        index.push_str(&format!("pub mod {name};\n"));
    }
    let mut exports: BTreeSet<_> = modules
        .keys()
        .cloned()
        .chain(["types".to_string()])
        .collect();
    exports.extend(shared.names.values().cloned());
    let mut catalogs = String::new();
    for facade in &package.facades {
        identifier(&facade.name)?;
        identifier(&facade.catalog)?;
        if !exports.insert(facade.name.clone()) || !exports.insert(facade.catalog.clone()) {
            return Err(ContractError("duplicate facade/catalog export".into()));
        }
        let runtime = &package.options.linkrpc_path;
        index.push_str(&format!(
            "#[derive(Clone)]\npub struct {}<C> {{ caller: C }}\n\
             impl<C: {runtime}::prelude::RpcCall + Clone> {}<C> {{\n\
             pub fn root(caller: C) -> Self {{ Self {{ caller }} }}\n",
            facade.name, facade.name,
        ));
        for line in facade.description.lines() {
            catalogs.push_str(&format!("/// {line}\n"));
        }
        catalogs.push_str(&format!(
            "pub fn {}() -> Vec<(String, {runtime}::prelude::InterfaceDefinition)> {{\nvec![\n",
            facade.catalog,
        ));
        let mut accessors = BTreeSet::from(["root"]);
        for member in &facade.members {
            identifier(&member.name)?;
            if !accessors.insert(&member.name) {
                return Err(ContractError(format!(
                    "duplicate facade accessor `{}`",
                    member.name
                )));
            }
            let module = modules.get(&member.module).ok_or_else(|| {
                ContractError(format!("unknown facade module `{}`", member.module))
            })?;
            let options = module_options(module, package);
            if !options
                .bindings
                .iter()
                .any(|binding| binding.name == member.binding)
            {
                return Err(ContractError(format!(
                    "unknown binding `{}::{}`",
                    member.module, member.binding
                )));
            }
            let client = options
                .client_name
                .clone()
                .unwrap_or_else(|| format!("{}Client", ident::to_pascal_case(&module.schema.id)));
            identifier(&client)?;
            index.push_str(&format!(
                "pub fn {}(&self) -> {}::{client}<C> {{ {}::{}.client(self.caller.clone()) }}\n",
                member.name, member.module, member.module, member.binding,
            ));
            catalogs.push_str(&format!(
                "({}::{}.prefix(), {}::{}.interface()),\n",
                member.module, member.binding, member.module, member.binding,
            ));
        }
        index.push_str("}\n");
        catalogs.push_str("]\n}\n");
    }
    index.push_str(&catalogs);
    files.insert("mod.rs".into(), index);
    for code in files.values_mut() {
        code.insert_str(0, &package.header);
    }
    Ok(GeneratedRustPackage {
        files,
        unsupported,
        interface_hashes,
    })
}
