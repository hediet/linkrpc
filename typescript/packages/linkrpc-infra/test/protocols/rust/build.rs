use std::{
    env, fs,
    path::{Path, PathBuf},
};

use linkrpc::schema::codegen::{generate_rust_interface, GenerateRustOptions};
use linkrpc::schema::interface_schema::LinkRpcInterfaceSchema;
use serde_json::json;

fn main() {
    println!("cargo:rerun-if-env-changed=LINKRPC_PROTOCOL_SCHEMAS");
    println!("cargo:rerun-if-env-changed=LINKRPC_PROTOCOL_REPORT");
    let input = PathBuf::from(
        env::var_os("LINKRPC_PROTOCOL_SCHEMAS")
            .expect("LINKRPC_PROTOCOL_SCHEMAS must point at the generated schema directory"),
    );
    println!("cargo:rerun-if-changed={}", input.display());

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
    let mut modules = String::new();
    let mut interfaces = Vec::new();
    let mut selected = Vec::new();
    for group in ["full", "selected"] {
        let group_dir = input.join(group);
        let mut schemas = fs::read_dir(&group_dir)
            .unwrap_or_else(|e| panic!("read {}: {e}", group_dir.display()))
            .map(|entry| entry.expect("read schema directory entry").path())
            .filter(|path| path.extension().and_then(|x| x.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        schemas.sort();
        assert!(
            !schemas.is_empty(),
            "{} must contain canonical interface schema JSON files",
            group_dir.display()
        );
        if group == "full" {
            assert_eq!(
                schemas.len(),
                74,
                "full must contain the complete 74-interface CDP/LSP corpus"
            );
        }

        modules.push_str(&format!("pub mod {group} {{\n"));
        for schema_path in schemas {
            let bytes = fs::read(&schema_path)
                .unwrap_or_else(|e| panic!("read {}: {e}", schema_path.display()));
            let schema: LinkRpcInterfaceSchema = serde_json::from_slice(&bytes)
                .unwrap_or_else(|e| panic!("parse {}: {e}", schema_path.display()));
            let generated = generate_rust_interface(
                &schema,
                &GenerateRustOptions {
                    generate_server: true,
                    inline_params: false,
                    ..GenerateRustOptions::default()
                },
            );
            let module = rust_module_name(&schema.id);
            let generated_path = output.join(format!("{group}_{module}.rs"));
            fs::write(&generated_path, generated.code)
                .unwrap_or_else(|e| panic!("write {}: {e}", generated_path.display()));
            modules.push_str(&format!(
                "    #[path = {}]\n    pub mod {module};\n",
                rust_string(&generated_path)
            ));
            let diagnostics = json!({
                "id": schema.id,
                "unsupported": generated.unsupported,
            });
            if group == "full" {
                interfaces.push(diagnostics);
            } else {
                selected.push(diagnostics);
            }
        }
        modules.push_str("}\n");
    }

    let generated_root = output.join("protocol_schemas.rs");
    fs::write(&generated_root, modules).expect("write generated module index");
    let manifest_path = output.join("unsupported-manifest.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&json!({
            "interfaces": interfaces,
            "selected": selected,
        }))
        .expect("serialize unsupported manifest"),
    )
    .expect("write unsupported manifest");
    println!(
        "cargo:warning=LinkRPC Rust codegen diagnostics: {}",
        manifest_path.display()
    );
    if let Some(target_dir) = env::var_os("CARGO_TARGET_DIR") {
        let target_report = PathBuf::from(target_dir).join("generation-report.json");
        fs::copy(&manifest_path, &target_report)
            .unwrap_or_else(|e| panic!("write {}: {e}", target_report.display()));
    }
    if let Some(report_path) = env::var_os("LINKRPC_PROTOCOL_REPORT") {
        let report_path = PathBuf::from(report_path);
        fs::copy(&manifest_path, &report_path)
            .unwrap_or_else(|e| panic!("write {}: {e}", report_path.display()));
    }
}

fn rust_module_name(interface_id: &str) -> String {
    let mut result = interface_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    if result.starts_with(|ch: char| ch.is_ascii_digit()) {
        result.insert(0, '_');
    }
    result
}

fn rust_string(path: &Path) -> String {
    format!("{:?}", path.to_string_lossy())
}
