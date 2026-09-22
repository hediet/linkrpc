use std::{env, fs, path::PathBuf};

use linkrpc::schema::{
    codegen::{generate_rust_interface, GenerateRustOptions},
    LinkRpcInterfaceSchema,
};

fn main() {
    println!("cargo:rustc-check-cfg=cfg(typed_error_negative_test)");
    println!("cargo:rerun-if-env-changed=LINKRPC_TYPED_ERROR_SCHEMA");
    if env::var_os("CARGO_FEATURE_GENERATED").is_none() {
        return;
    }
    let input = PathBuf::from(
        env::var_os("LINKRPC_TYPED_ERROR_SCHEMA")
            .expect("LINKRPC_TYPED_ERROR_SCHEMA must name the TypeScript-exported interface JSON"),
    );
    println!("cargo:rerun-if-changed={}", input.display());
    let schema: LinkRpcInterfaceSchema =
        serde_json::from_slice(&fs::read(&input).expect("read TS-authored schema"))
            .expect("parse TS-authored schema");
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
        "typed error contract must not use codegen fallbacks: {:?}",
        generated.unsupported,
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
    let contract = output.join("ts_errors.rs");
    fs::write(&contract, generated.code).expect("write generated Rust contract");
    fs::write(
        output.join("contract.rs"),
        format!("#[path = {:?}]\nmod contract;\n", contract),
    )
    .expect("write generated Rust module");
}
