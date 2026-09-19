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
        "wrong-message" => data(
            base + 1,
            "Wrong message",
            serde_json::json!({"resource": "file"}),
        ),
        "wrong-data" => data(base + 1, "Missing", serde_json::json!({"resource": 42})),
        "missing-data" => JsonRpcError::new(base + 1, "Missing"),
        "extra-data" => data(base + 2, "Busy", serde_json::Value::Null),
        "missing-nullable" => JsonRpcError::new(base + 3, "Nullable"),
        "extra-property" => data(
            base + 1,
            "Missing",
            serde_json::json!({"resource": "file", "extra": true}),
        ),
        "bad-recursion" => data(
            base + 4,
            "Recursive",
            serde_json::json!({"label": "root", "children": [{"label": 42, "children": []}]}),
        ),
        _ => panic!("unexpected fixture mode: {mode}"),
    }
}
