use linkrpc::prelude::*;
use linkrpc_tokio::NdjsonTransport;

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
        _ => panic!("unexpected fixture mode: {mode}"),
    }
}
