use std::{env, fs, path::PathBuf};

use linkrpc::schema::{
    codegen::{generate_rust_interface, GenerateRustOptions},
    compute_interface_hash, LinkRpcInterfaceSchema,
};

fn main() {
    println!("cargo:rerun-if-env-changed=LINKRPC_TEMPLATE_SCHEMA");
    let input = PathBuf::from(
        env::var_os("LINKRPC_TEMPLATE_SCHEMA")
            .expect("LINKRPC_TEMPLATE_SCHEMA must name the TS-authored template interface JSON"),
    );
    println!("cargo:rerun-if-changed={}", input.display());
    let json = fs::read(&input).expect("read TS-authored schema");
    let schema: LinkRpcInterfaceSchema =
        serde_json::from_slice(&json).expect("parse TS-authored schema");
    let original: serde_json::Value = serde_json::from_slice(&json).unwrap();
    assert_eq!(serde_json::to_value(&schema).unwrap(), original);
    assert!(schema.extension("x-interface-templates").is_some());
    assert_eq!(compute_interface_hash(&schema), schema.hash);
    let mut plain = schema.clone();
    plain.extensions.remove("x-interface-templates");
    assert_eq!(compute_interface_hash(&plain), schema.hash);
    let generated = generate_rust_interface(
        &schema,
        &GenerateRustOptions {
            generate_server: true,
            inline_params: false,
            ..GenerateRustOptions::default()
        },
    );
    assert!(
        generated.unsupported.is_empty(),
        "template contract must not use codegen fallbacks: {:?}",
        generated.unsupported,
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
    let contract = output.join("generated.rs");
    fs::write(&contract, generated.code).expect("write generated Rust contract");
    fs::write(
        output.join("contract.rs"),
        format!("#[path = {:?}]\nmod contract;\n", contract),
    )
    .expect("write generated Rust module");
}
