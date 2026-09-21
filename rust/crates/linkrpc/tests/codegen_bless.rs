//! Regenerates the golden `generated_graph.rs` from `graph_interface.json`.
//!
//! Run with `cargo test -p linkrpc --test codegen_bless -- --ignored --nocapture`
//! to (re)write the golden file after intentional generator changes.

use std::path::PathBuf;

use linkrpc::schema::codegen::{generate_rust_interface, GenerateRustOptions};
use linkrpc::schema::interface_schema::LinkRpcInterfaceSchema;

#[path = "codegen/contract_fixture.rs"]
mod contract_fixture;

#[test]
#[ignore = "regenerates shared-component and contract golden files on demand"]
fn bless_contract() {
    use linkrpc::schema::codegen::{generate_rust_components, generate_rust_contract};
    let shared = generate_rust_components(&contract_fixture::components(), &Default::default());
    assert!(shared.unsupported.is_empty());
    std::fs::write(dir().join("generated_shared.rs"), shared.code).unwrap();
    for (schema, domain) in contract_fixture::schemas()
        .iter()
        .zip(["Runtime", "Debugger"])
    {
        let mut options = contract_fixture::options(domain);
        options.external_components = shared
            .names
            .iter()
            .map(|(name, ty)| (name.clone(), format!("super::shared::{ty}")))
            .collect();
        let generated = generate_rust_interface(schema, &options);
        assert!(
            generated.unsupported.is_empty(),
            "{:?}",
            generated.unsupported
        );
        std::fs::write(
            dir().join(format!("generated_{}.rs", domain.to_lowercase())),
            generated.code,
        )
        .unwrap();
    }
    for (contract, directory) in [
        (contract_fixture::contract(), "generated_contract"),
        (
            contract_fixture::colliding_module_contract(),
            "generated_contract_collisions",
        ),
    ] {
        let generated = generate_rust_contract(
            &contract,
            &GenerateRustOptions {
                generate_server: true,
                default_server_methods: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(generated.unsupported.is_empty());
        let target = dir().join(directory);
        std::fs::create_dir_all(&target).unwrap();
        for (name, source) in generated.files {
            std::fs::write(target.join(name), source).unwrap();
        }
    }
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("codegen")
}

fn generate() -> linkrpc::schema::codegen::GeneratedRust {
    let text = std::fs::read_to_string(dir().join("graph_interface.json")).unwrap();
    let schema: LinkRpcInterfaceSchema = serde_json::from_str(&text).unwrap();
    generate_rust_interface(&schema, &GenerateRustOptions::default())
}

fn generate_server() -> linkrpc::schema::codegen::GeneratedRust {
    let text = std::fs::read_to_string(dir().join("graph_interface.json")).unwrap();
    let schema: LinkRpcInterfaceSchema = serde_json::from_str(&text).unwrap();
    generate_rust_interface(
        &schema,
        &GenerateRustOptions {
            generate_server: true,
            default_server_methods: true,
            ..GenerateRustOptions::default()
        },
    )
}

#[test]
#[ignore = "regenerates the golden file on demand"]
fn bless_golden() {
    let generated = generate();
    let target = dir().join("generated_graph.rs");
    std::fs::write(&target, generated.code).unwrap();
    eprintln!("wrote {}", target.display());
    eprintln!("unsupported constructs: {:#?}", generated.unsupported);

    let generated = generate_server();
    let target = dir().join("generated_graph_server.rs");
    std::fs::write(&target, generated.code).unwrap();
    eprintln!("wrote {}", target.display());
    eprintln!("unsupported constructs: {:#?}", generated.unsupported);

    for (input, output, runtime) in [
        (
            "typed_errors_interface.json",
            "generated_typed_errors.rs",
            "linkrpc",
        ),
        (
            "streaming_interface.json",
            "generated_streaming.rs",
            "linkrpc",
        ),
        (
            "typed_errors_interface.json",
            "generated_renamed_runtime.rs",
            "crate::renamed_runtime",
        ),
    ] {
        let schema =
            serde_json::from_str(&std::fs::read_to_string(dir().join(input)).unwrap()).unwrap();
        let generated = generate_rust_interface(
            &schema,
            &GenerateRustOptions {
                generate_server: true,
                linkrpc_path: runtime.to_string(),
                ..Default::default()
            },
        );
        assert!(
            generated.unsupported.is_empty(),
            "{:?}",
            generated.unsupported
        );
        std::fs::write(dir().join(output), generated.code).unwrap();
    }
}
