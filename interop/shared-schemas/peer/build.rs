use std::{
    env, fs,
    path::{Path, PathBuf},
};

use linkrpc::schema::{generate_rust_interface, GenerateRustOptions, LinkRpcInterfaceSchema};

fn main() {
    println!("cargo:rerun-if-changed=../contract/src/lib.rs");
    let json = serde_json::to_vec(
        &shared_schemas_contract::shared_schemas_daemon::interface().to_schema(),
    )
    .expect("export canonical interface JSON");
    let schema: LinkRpcInterfaceSchema =
        serde_json::from_slice(&json).expect("read canonical interface JSON for Rust codegen");
    let generated = generate_rust_interface(
        &schema,
        &GenerateRustOptions {
            client_name: Some("GeneratedSharedClient".into()),
            generate_server: true,
            default_server_methods: true,
            inline_params: false,
            ..GenerateRustOptions::default()
        },
    );
    assert!(
        generated.unsupported.is_empty(),
        "fixture must stay fully typed: {:#?}",
        generated.unsupported
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
    let generated_path = output.join("generated.rs");
    fs::write(&generated_path, generated.code).expect("write generated Rust");
    fs::write(
        output.join("generated_module.rs"),
        format!(
            "#[path = {}]\nmod generated;\n",
            rust_string(&generated_path)
        ),
    )
    .expect("write generated module declaration");
}

fn rust_string(path: &Path) -> String {
    format!("{:?}", path.to_string_lossy())
}
