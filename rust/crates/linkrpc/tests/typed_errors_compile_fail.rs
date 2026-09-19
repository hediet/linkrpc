//! Compile-fail coverage for diagnostics which derive expansion must reject.

use std::path::PathBuf;
use std::process::Command;

fn assert_compile_fails(bin: &str, expected: &str) {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let manifest = manifest_dir
        .join("tests")
        .join("compile_fail")
        .join("Cargo.toml");
    let target = manifest_dir
        .join("..")
        .join("..")
        .join("target")
        .join("typed-errors-compile-fail");

    let output = Command::new(env!("CARGO"))
        .args([
            "check",
            "--quiet",
            "--manifest-path",
            manifest.to_str().unwrap(),
            "--bin",
            bin,
        ])
        .env("CARGO_TARGET_DIR", target)
        .output()
        .expect("run cargo check for compile-fail fixture");

    assert!(
        !output.status.success(),
        "compile-fail fixture `{bin}` unexpectedly compiled"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(expected),
        "fixture `{bin}` did not report `{expected}`:\n{stderr}"
    );
}

#[test]
fn derive_rejects_reserved_error_code() {
    assert_compile_fails(
        "reserved",
        "application error codes must not use protocol-reserved codes (-32768..=-32000 or -32800)",
    );
}

#[test]
fn derive_rejects_linkrpc_cancelled_error_code() {
    assert_compile_fails(
        "cancelled",
        "application error codes must not use protocol-reserved codes (-32768..=-32000 or -32800)",
    );
}

#[test]
fn derive_rejects_duplicate_error_code() {
    assert_compile_fails("duplicate", "duplicate application error code 1001");
}

#[test]
fn typed_variant_rejects_wrong_payload_type() {
    assert_compile_fails("wrong_payload", "expected `MissingData`, found `String`");
}
