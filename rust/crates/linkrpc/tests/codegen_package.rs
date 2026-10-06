use std::io::Write;
use std::process::{Command, Stdio};

use linkrpc::schema::codegen::{generate_rust_package, GenerateRustPackage, GeneratedRustPackage};
use serde_json::{json, Value};

fn definition() -> Value {
    let schema = |id, result| {
        let mut method = json!({"params": {"$ref":"#/components/schemas/Shared"}});
        if result {
            method["result"] = json!({"$ref":"#/components/schemas/Shared"});
        }
        json!({
            "id":id, "hash":"", "methods":{"changed":method},
            "components":{"schemas":{"Shared":{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}}}
        })
    };
    json!({
        "header":"// package fixture\n",
        "options":{"generateServer":true,"defaultServerMethods":true},
        "modules":[
            {"name":"commands","schema":schema("example.commands",true),"options":{"generateServer":true,"defaultServerMethods":true,"clientName":"CommandsClient","bindings":[{"name":"DOMAIN","address":{"kind":"bare","value":"Example."}}]}},
            {"name":"events","schema":schema("example.events",false),"options":{"bindings":[{"name":"DOMAIN","address":{"kind":"bare","value":"Example."}}]}}
        ],
        "facades":[
            {"name":"Client","catalog":"command_interfaces","members":[{"name":"commands","module":"commands","binding":"DOMAIN"}]},
            {"name":"EventsClient","catalog":"event_interfaces","members":[{"name":"events","module":"events","binding":"DOMAIN"}]}
        ]
    })
}

fn generate(value: Value) -> Result<GeneratedRustPackage, String> {
    let package: GenerateRustPackage = serde_json::from_value(value).map_err(|e| e.to_string())?;
    generate_rust_package(&package).map_err(|e| e.to_string())
}

#[test]
fn shared_types_directional_bindings_facades_and_hashes_are_deterministic() {
    let first = generate(definition()).unwrap();
    let second = generate(definition()).unwrap();
    assert_eq!(first.files, second.files);
    assert_eq!(first.interface_hashes, second.interface_hashes);
    assert!(first.unsupported.is_empty());
    assert_ne!(
        first.interface_hashes["commands"],
        first.interface_hashes["events"]
    );
    assert_eq!(first.files.len(), 4);
    assert!(first.files["types.rs"].contains("pub struct Shared"));
    assert!(!first.files["commands.rs"].contains("pub struct Shared"));
    assert!(first.files["commands.rs"].contains("super::types::Shared"));
    assert!(first.files["commands.rs"].contains("Example."));
    assert!(first.files["commands.rs"].contains("METHOD_NOT_FOUND"));
    let index = &first.files["mod.rs"];
    assert!(index.contains("commands::DOMAIN.client(self.caller.clone())"));
    assert!(index.contains("events::DOMAIN.prefix()"));
    assert!(first
        .files
        .values()
        .all(|code| code.starts_with("// package fixture\n")));
}

#[test]
fn default_options_apply_to_modules_without_overrides() {
    let mut input = definition();
    input["facades"] = json!([]);
    input["modules"][1]
        .as_object_mut()
        .unwrap()
        .remove("options");
    let output = generate(input).unwrap();
    assert!(output.files["events.rs"].contains("ExampleEventsService"));
}

#[test]
fn rejects_stale_hash_conflicting_components_and_invalid_source_layout() {
    for (pointer, value, expected) in [
        ("/modules/0/schema/hash", json!("stale"), "invalid hash"),
        (
            "/modules/1/schema/components/schemas/Shared/type",
            json!("string"),
            "conflicting shared component",
        ),
        (
            "/modules/1/name",
            json!("commands"),
            "duplicate/reserved module",
        ),
        (
            "/modules/0/name",
            json!("../escape"),
            "invalid Rust identifier",
        ),
        (
            "/modules/0/name",
            json!("types"),
            "duplicate/reserved module",
        ),
        (
            "/facades/0/members/0/module",
            json!("missing"),
            "unknown facade module",
        ),
        (
            "/facades/0/members/0/binding",
            json!("missing"),
            "unknown binding",
        ),
        (
            "/facades/0/members/0/name",
            json!("root"),
            "duplicate facade accessor",
        ),
        (
            "/facades/0/name",
            json!("EventsClient"),
            "duplicate facade/catalog export",
        ),
    ] {
        let mut input = definition();
        *input.pointer_mut(pointer).unwrap() = value;
        let error = generate(input).unwrap_err();
        assert!(error.contains(expected), "{pointer}: {error}");
    }
}

#[test]
fn all_address_kinds_round_trip_through_json_options() {
    for address in [
        json!({"kind":"root"}),
        json!({"kind":"default"}),
        json!({"kind":"service","value":"worker"}),
        json!({"kind":"bare","value":"Example."}),
    ] {
        let mut input = definition();
        input["modules"][0]["options"]["bindings"][0]["address"] = address;
        let output = generate(input).unwrap();
        assert!(output.files["commands.rs"].contains("DOMAIN"));
    }
}

#[test]
fn cli_accepts_stdin_and_returns_source_files_hashes_and_fallback_diagnostics() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_linkrpc-codegen"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(definition().to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: GeneratedRustPackage = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result.files, generate(definition()).unwrap().files);
    assert!(result.unsupported.is_empty());
}

#[test]
fn cli_rejects_unknown_options_and_check_without_output() {
    for argument in ["--unknown", "--check"] {
        let output = Command::new(env!("CARGO_BIN_EXE_linkrpc-codegen"))
            .arg(argument)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn cli_writes_and_checks_exact_output_without_modifying_stale_files() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("codegen-cli-fixture-{}", std::process::id()));
    assert!(!directory.exists());
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(directory.clone());
    let run = |check: bool| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_linkrpc-codegen"));
        command.arg("--output").arg(&directory);
        if check {
            command.arg("--check");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(definition().to_string().as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    };
    assert!(!run(true).status.success());
    assert!(!directory.exists());
    assert!(run(false).status.success());
    assert!(run(true).status.success());
    let output = directory.join("mod.rs");
    std::fs::write(&output, "stale").unwrap();
    assert!(!run(true).status.success());
    assert_eq!(std::fs::read_to_string(&output).unwrap(), "stale");
    assert!(run(false).status.success());
    let obsolete = directory.join("obsolete.rs");
    std::fs::write(&obsolete, "unrelated").unwrap();
    assert!(!run(true).status.success());
    assert!(!run(false).status.success());
    assert_eq!(std::fs::read_to_string(obsolete).unwrap(), "unrelated");
}
