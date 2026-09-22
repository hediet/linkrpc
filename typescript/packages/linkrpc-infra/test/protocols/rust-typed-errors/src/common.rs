use linkrpc::prelude::*;
use linkrpc_tokio::NdjsonTransport;

pub const RAW_MODES: [&str; 6] = [
    "raw",
    "raw-absent",
    "raw-null",
    "raw-value",
    "raw-string",
    "raw-number",
];
pub const UNHANDLED_MODES: [&str; 5] = [
    "unknown",
    "protocol",
    "spoof-transport",
    "wrong-code",
    "raw-unknown-code",
];
pub const NONCOMPLIANT_MODES: [&str; 14] = [
    "unknown-type",
    "missing-type",
    "wrong-data",
    "missing-data",
    "wrong-variant-code",
    "extra-data",
    "missing-nullable",
    "extra-property",
    "extra-envelope",
    "bad-recursion",
    "raw-invalid",
    "raw-missing-data",
    "raw-null-required",
    "raw-bad-union",
];

pub fn connection() -> LinkRpcConnection {
    LinkRpcConnection::new(Box::new(NdjsonTransport::new(
        tokio::io::stdin(),
        tokio::io::stdout(),
    )))
}

pub fn remote_error(mode: &str, base: i64) -> JsonRpcError {
    let data = |code, message: &str, data| JsonRpcError {
        code,
        message: message.to_owned(),
        data: Some(data),
    };
    match mode {
        "unknown" => data(9001, "Unknown", serde_json::json!({"kept": true})),
        "protocol" => JsonRpcError::new(error_codes::INVALID_PARAMS, "Protocol failure"),
        "spoof-transport" => JsonRpcError::new(error_codes::PEER_DISCONNECTED, "Connection closed"),
        "changed-message" => data(
            1,
            "Dynamic diagnostic",
            serde_json::json!({"type": "Missing", "data": {"resource": "file"}}),
        ),
        "unknown-type" => data(
            1,
            "Missing",
            serde_json::json!({"type": "Undeclared", "data": {"resource": "file"}}),
        ),
        "missing-type" => data(
            1,
            "Missing",
            serde_json::json!({"data": {"resource": "file"}}),
        ),
        "wrong-code" => data(
            9001,
            "Missing",
            serde_json::json!({"type": "Missing", "data": {"resource": "file"}}),
        ),
        "wrong-variant-code" => data(
            base + 5,
            "Missing",
            serde_json::json!({"type": "Missing", "data": {"resource": "file"}}),
        ),
        "wrong-data" => data(
            1,
            "Missing",
            serde_json::json!({"type": "Missing", "data": {"resource": 42}}),
        ),
        "missing-data" => data(1, "Missing", serde_json::json!({"type": "Missing"})),
        "extra-data" => data(1, "Busy", serde_json::json!({"type": "Busy", "data": null})),
        "missing-nullable" => data(
            base + 3,
            "Nullable",
            serde_json::json!({"type": "Nullable"}),
        ),
        "extra-property" => data(
            1,
            "Missing",
            serde_json::json!({"type": "Missing", "data": {"resource": "file", "extra": true}}),
        ),
        "bad-recursion" => data(
            base + 4,
            "Recursive",
            serde_json::json!({"type": "Recursive", "data": {"label": "root", "children": [{"label": 42, "children": []}]}}),
        ),
        "extra-envelope" => data(
            1,
            "Missing",
            serde_json::json!({"type": "Missing", "data": {"resource": "file"}, "extra": true}),
        ),
        "raw" => data(
            -32001,
            "Retry after maintenance",
            serde_json::json!({"retryAfter": 5}),
        ),
        "raw-absent" => JsonRpcError::new(-32002, "Optional diagnostic"),
        "raw-null" => data(-32002, "Optional diagnostic", serde_json::Value::Null),
        "raw-value" => data(
            -32002,
            "Optional diagnostic",
            serde_json::json!({"arbitrary": ["data"]}),
        ),
        "raw-string" => data(-32003, "Union diagnostic", serde_json::json!("file")),
        "raw-number" => data(-32003, "Union diagnostic", serde_json::json!(5)),
        "raw-unknown-code" => data(
            -32004,
            "Retry after maintenance",
            serde_json::json!({"retryAfter": 5}),
        ),
        "raw-invalid" => data(
            -32001,
            "Retry after maintenance",
            serde_json::json!({"retryAfter": "soon"}),
        ),
        "raw-missing-data" => JsonRpcError::new(-32001, "Retry after maintenance"),
        "raw-null-required" => data(-32001, "Retry after maintenance", serde_json::Value::Null),
        "raw-bad-union" => data(-32003, "Union diagnostic", serde_json::json!(false)),
        _ => panic!("unexpected fixture mode: {mode}"),
    }
}

pub fn assert_generic_error<E: std::fmt::Debug>(error: CallError<E>, mode: &str, base: i64) {
    if UNHANDLED_MODES.contains(&mode) {
        match error {
            CallError::Generic(RpcCallError::Remote(original)) => {
                assert_eq!(original, remote_error(mode, base));
            }
            other => panic!("{mode}: expected unhandled remote error, got {other:?}"),
        }
    } else {
        match error {
            CallError::Generic(RpcCallError::NonCompliantServer { original, issues }) => {
                assert_eq!(*original, remote_error(mode, base));
                assert!(!issues.is_empty(), "{mode}: missing validation diagnostics");
                assert!(issues.iter().all(|issue| !issue.message.is_empty()));
                if mode == "raw-invalid" {
                    assert!(issues.iter().any(|issue| issue.path == "/data/retryAfter"));
                }
            }
            other => panic!("{mode}: expected compliance failure, got {other:?}"),
        }
    }
}

pub fn raw_body(mode: &str) -> serde_json::Value {
    let error = remote_error(mode, 0);
    let mut body = serde_json::json!({ "message": error.message });
    if let Some(data) = error.data {
        body["data"] = data;
    }
    body
}
