#[path = "codegen/generated_raw_errors.rs"]
mod generated;

pub use linkrpc as renamed_runtime;

#[path = "codegen/generated_raw_errors_renamed.rs"]
mod renamed;

use generated::*;
use linkrpc::prelude::*;
use serde_json::{json, Value};
use std::sync::Arc;

#[test]
fn raw_wire_import_requires_string_messages_and_json_data() {
    for wire in [
        r#"{"code":-32003,"message":42,"data":"value"}"#,
        r#"{"code":-32003,"message":null,"data":3}"#,
        r#"{"code":-32003,"message":"Invalid JSON","data":NaN}"#,
        r#"{"code":-32003,"message":"Invalid JSON","data":Infinity}"#,
        r#"{"code":-32003,"message":"Invalid JSON","data":undefined}"#,
    ] {
        assert!(
            serde_json::from_str::<JsonRpcError>(wire).is_err(),
            "{wire}"
        );
    }
}

struct Provider;

#[test]
fn general_raw_body_schemas_are_constraints_on_protocol_valid_errors() {
    for wire in [
        JsonRpcError::new(-32010, "Top schema"),
        JsonRpcError {
            code: -32010,
            message: "Any JSON data".into(),
            data: Some(json!({"nested": [null, true, 1]})),
        },
        JsonRpcError {
            code: -32012,
            message: "Broad union".into(),
            data: Some(json!(true)),
        },
        JsonRpcError::new(-32013, "Referenced open object"),
        JsonRpcError {
            code: -32015,
            message: "Never-or-integer union".into(),
            data: Some(json!(5)),
        },
    ] {
        let decoded = CheckError::try_from_rpc_error(wire.clone()).unwrap();
        assert_eq!(decoded.into_rpc_error(), wire);
    }
    for wire in [
        JsonRpcError::new(-32011, "False schema"),
        JsonRpcError::new(-32014, "Referenced false schema"),
        JsonRpcError::new(-32012, "Broad union still requires data"),
        JsonRpcError {
            code: -32012,
            message: "Wrong union data".into(),
            data: Some(json!("not a boolean")),
        },
        JsonRpcError {
            code: -32015,
            message: "False branch cannot accept anything".into(),
            data: Some(json!(false)),
        },
    ] {
        assert!(matches!(
            CallError::<CheckError>::from_remote(wire.clone()),
            CallError::Generic(RpcCallError::NonCompliantServer { original, issues })
                if *original == wire && !issues.is_empty()
        ));
    }
    let unknown = JsonRpcError::new(-32099, "Unknown code");
    assert!(matches!(
        CallError::<CheckError>::from_remote(unknown.clone()),
        CallError::Generic(RpcCallError::Remote(original)) if original == unknown
    ));
}

#[test]
fn broad_schemas_cannot_encode_protocol_invalid_raw_bodies() {
    for body in [
        json!(null),
        json!({}),
        json!({"message": 42}),
        json!({"message": "Valid string", "extra": true}),
        json!({"message": "Valid string", "code": -32010}),
    ] {
        let error = CheckError::CodeNeg32010(body).into_rpc_error();
        assert_eq!(error.code, error_codes::INTERNAL_ERROR);
    }
    for body in [
        json!({"message": 42.0}),
        json!({"data": true}),
        json!({"message": "Valid string", "data": true, "extra": 1}),
    ] {
        let error =
            CheckError::CodeNeg32012(serde_json::from_value(body).unwrap()).into_rpc_error();
        assert_eq!(error.code, error_codes::INTERNAL_ERROR);
    }
    let error = CheckError::CodeNeg32013(serde_json::from_value(json!({"extra": 1})).unwrap())
        .into_rpc_error();
    assert_eq!(error.code, error_codes::INTERNAL_ERROR);
}

#[test]
fn raw_private_tag_cannot_shadow_a_named_wire_type_on_another_code() {
    let raw = JsonRpcError::new(-32001, "Raw dynamic message");
    assert!(matches!(
        CallError::<CheckError>::from_remote(raw),
        CallError::Application(CheckError::CodeNeg32001(_))
    ));
    let named = JsonRpcError {
        code: 43,
        message: "Named dynamic message".into(),
        data: Some(json!({"type": "CodeNeg32001"})),
    };
    assert!(matches!(
        CallError::<CheckError>::from_remote(named),
        CallError::Application(CheckError::CodeNeg320012)
    ));
    assert_eq!(
        CheckError::CodeNeg320012.into_rpc_error().data,
        Some(json!({"type": "CodeNeg32001"})),
    );
    let wrong_code = JsonRpcError::new(43, "Raw body on named code");
    assert!(matches!(
        CallError::<CheckError>::from_remote(wrong_code.clone()),
        CallError::Generic(RpcCallError::NonCompliantServer { original, .. }) if *original == wrong_code
    ));
    assert!(matches!(
        CallError::<CheckError>::from_remote(JsonRpcError {
            code: -32001,
            message: "Named envelope on raw code".into(),
            data: Some(json!({"type": "CodeNeg32001"})),
        }),
        CallError::Application(CheckError::CodeNeg32001(_))
    ));
}

#[async_trait]
impl DevLinkrpcRawErrorsService for Provider {
    async fn check(&self, _ctx: &CallCtx, params: String) -> Result<String, CheckError> {
        let data = match params.as_str() {
            "absent" => None,
            "null" => Some(RawBodyData::Variant1(())),
            _ => Some(RawBodyData::RawData(RawData {
                next: None,
                value: Some(json!({"nested": true})),
            })),
        };
        Err(CheckError::CodeNeg32001(RawBody {
            message: params,
            data,
        }))
    }
}

#[tokio::test]
async fn generated_raw_client_and_server_round_trip() {
    let (a, b) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(a));
    let server_connection = LinkRpcConnection::new(Box::new(b));
    server_connection
        .register_service(
            Arc::new(DevLinkrpcRawErrorsServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();
    let client_run = client_connection.clone();
    let server_run = server_connection.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move { server_run.run().await });
    let client = DevLinkrpcRawErrorsClient::new(client_connection);

    for (mode, data) in [
        ("absent", None),
        ("null", None),
        ("object", Some(json!({"value": {"nested": true}}))),
    ] {
        let error = client.check(mode.into()).await.unwrap_err();
        assert!(matches!(error, CheckError::CodeNeg32001(_)));
        assert_eq!(
            error.into_rpc_error(),
            JsonRpcError {
                code: -32001,
                message: mode.into(),
                data,
            }
        );
    }
}

#[test]
fn generated_raw_errors_follow_serde_optional_null_coalescing() {
    for (body, encoded) in [
        (json!({"message": "Absent"}), json!({"message": "Absent"})),
        (
            json!({"message": "Null", "data": null}),
            json!({"message": "Null"}),
        ),
        (
            json!({"message": "Recursive", "data": {"next": {"value": null}}}),
            json!({"message": "Recursive", "data": {"next": {}}}),
        ),
    ] {
        let typed: RawBody = serde_json::from_value(body.clone()).unwrap();
        assert_eq!(serde_json::to_value(&typed).unwrap(), encoded);
        let wire = CheckError::CodeNeg32001(typed).into_rpc_error();
        assert_eq!(wire.code, -32001);
        assert_eq!(wire.message, body["message"]);
        assert_eq!(wire.data.as_ref(), encoded.get("data"));
        let original = JsonRpcError {
            code: wire.code,
            message: wire.message.clone(),
            data: body.get("data").cloned(),
        };
        let decoded = CheckError::try_from_rpc_error(original).unwrap();
        assert!(matches!(decoded, CheckError::CodeNeg32001(_)));
        assert_eq!(decoded.into_rpc_error(), wire);
    }
}

#[test]
fn raw_body_union_and_required_null_use_the_full_schema() {
    for wire in [
        JsonRpcError {
            code: -32601,
            message: "Unavailable".into(),
            data: Some(Value::Null),
        },
        JsonRpcError {
            code: -32800,
            message: "Cancelled".into(),
            data: None,
        },
        JsonRpcError {
            code: -32800,
            message: "Stopped".into(),
            data: Some(json!(3)),
        },
        JsonRpcError {
            code: -32002,
            message: "Any".into(),
            data: None,
        },
        JsonRpcError {
            code: -32002,
            message: "Any".into(),
            data: Some(Value::Null),
        },
        JsonRpcError {
            code: -32002,
            message: "Any".into(),
            data: Some(json!([true, "payload"])),
        },
        JsonRpcError {
            code: -32600,
            message: "Legacy".into(),
            data: Some(json!(true)),
        },
        JsonRpcError {
            code: -32003,
            message: "Union string".into(),
            data: Some(json!("retry later")),
        },
        JsonRpcError {
            code: -32003,
            message: "Union number".into(),
            data: Some(json!(5.0)),
        },
        JsonRpcError {
            code: -32004,
            message: "Retry".into(),
            data: Some(json!({"retryAfter": 5.0})),
        },
    ] {
        let decoded = CheckError::try_from_rpc_error(wire.clone())
            .unwrap()
            .into_rpc_error();
        let expected = if wire.code == -32002 && wire.data == Some(Value::Null) {
            JsonRpcError { data: None, ..wire }
        } else {
            wire
        };
        assert_eq!(decoded, expected);
    }
}

#[test]
fn imported_raw_decoder_reports_serde_failures() {
    for wire in [
        JsonRpcError {
            code: -32601,
            message: "Unavailable".into(),
            data: None,
        },
        JsonRpcError {
            code: -32601,
            message: "Unknown".into(),
            data: Some(Value::Null),
        },
        JsonRpcError {
            code: -32800,
            message: "Stopped".into(),
            data: None,
        },
        JsonRpcError {
            code: -32003,
            message: "Required union absent".into(),
            data: None,
        },
        JsonRpcError {
            code: -32003,
            message: "Required union null".into(),
            data: Some(JsonValue::Null),
        },
        JsonRpcError {
            code: -32003,
            message: "Required union boolean".into(),
            data: Some(json!(false)),
        },
    ] {
        assert_eq!(
            CheckError::try_from_rpc_error(wire.clone()).unwrap_err(),
            wire
        );
        assert!(matches!(
            CallError::<CheckError>::from_remote(wire.clone()),
            CallError::Generic(RpcCallError::NonCompliantServer { original, issues })
                if *original == wire && !issues.is_empty()
        ));
    }
}

#[test]
fn imported_raw_decoder_uses_serde_unknown_field_rules() {
    for (wire, encoded_data) in [
        (
            JsonRpcError {
                code: -32800,
                message: "Cancelled".into(),
                data: Some(json!(3)),
            },
            None,
        ),
        (
            JsonRpcError {
                code: -32001,
                message: "Extra".into(),
                data: Some(json!({"unknown": true})),
            },
            Some(json!({})),
        ),
    ] {
        let decoded = CheckError::try_from_rpc_error(wire.clone()).unwrap();
        assert_eq!(
            decoded.into_rpc_error(),
            JsonRpcError {
                data: encoded_data,
                ..wire
            }
        );
    }
}

#[test]
fn raw_retry_schema_reports_actionable_wire_paths_and_preserves_original() {
    for (data, path) in [
        (json!({ "retryAfter": "invalid" }), "/data/retryAfter"),
        (json!({ "retryAfter": null }), "/data/retryAfter"),
        (json!({}), "/data"),
    ] {
        let wire = JsonRpcError {
            code: -32004,
            message: "Retry".into(),
            data: Some(data),
        };
        match CallError::<CheckError>::from_remote(wire.clone()) {
            CallError::Generic(RpcCallError::NonCompliantServer { original, issues }) => {
                assert_eq!(*original, wire);
                assert!(
                    issues
                        .iter()
                        .any(|issue| issue.path == path && !issue.message.is_empty()),
                    "{issues:?}"
                );
            }
            other => panic!("expected compliance error, got {other:?}"),
        }
    }
}

#[test]
fn raw_error_bindings_preserve_imported_contract_and_custom_runtime_path() {
    let schema: LinkRpcInterfaceSchema =
        serde_json::from_str(include_str!("codegen/raw_errors_interface.json")).unwrap();
    let expected = InterfaceDefinition::from_schema(schema.clone()).to_schema();
    assert_eq!(generated::interface().to_schema(), expected);
    assert_eq!(renamed::interface().to_schema(), expected);

    let wire = renamed::CheckError::CodeNeg32001(
        serde_json::from_value(json!({"message": "Nullable", "data": null})).unwrap(),
    )
    .into_rpc_error();
    assert_eq!(wire.data, None);
    assert!(matches!(
        renamed::CheckError::try_from_rpc_error(wire),
        Ok(renamed::CheckError::CodeNeg32001(_))
    ));

    let output = linkrpc::schema::codegen::generate_rust_interface(
        &schema,
        &linkrpc::schema::codegen::GenerateRustOptions {
            generate_server: true,
            linkrpc_path: "crate::renamed_runtime".into(),
            ..Default::default()
        },
    );
    assert_eq!(
        output.code.replace("\r\n", "\n"),
        include_str!("codegen/generated_raw_errors_renamed.rs").replace("\r\n", "\n")
    );
}
