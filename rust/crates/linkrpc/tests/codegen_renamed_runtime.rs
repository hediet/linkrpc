pub use linkrpc as renamed_runtime;

#[path = "codegen/generated_renamed_runtime.rs"]
mod generated;

use linkrpc::prelude::*;

#[test]
fn imported_macro_and_error_derive_support_a_custom_runtime_path() {
    let schema: LinkRpcInterfaceSchema =
        serde_json::from_str(include_str!("codegen/typed_errors_interface.json")).unwrap();
    let exported = generated::interface().to_schema();
    assert_eq!(
        exported,
        InterfaceDefinition::from_schema(schema).to_schema()
    );
    let error = generated::CheckError::Code2001(generated::MissingData::new("gone".into()))
        .into_rpc_error();
    assert!(matches!(
        generated::CheckError::try_from_rpc_error(error),
        Ok(generated::CheckError::Code2001(_))
    ));
}

#[test]
fn custom_runtime_fixture_has_no_codegen_drift() {
    let schema = serde_json::from_str(include_str!("codegen/typed_errors_interface.json")).unwrap();
    let generated = linkrpc::schema::codegen::generate_rust_interface(
        &schema,
        &linkrpc::schema::codegen::GenerateRustOptions {
            generate_server: true,
            linkrpc_path: "crate::renamed_runtime".into(),
            ..Default::default()
        },
    );
    assert_eq!(
        generated.code.replace("\r\n", "\n"),
        include_str!("codegen/generated_renamed_runtime.rs").replace("\r\n", "\n")
    );
}
