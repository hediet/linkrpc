use std::sync::Arc;

use linkrpc::prelude::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;

fn assert_noncompliant<E: std::fmt::Debug>(
    error: CallError<E>,
    expected: &JsonRpcError,
) -> Vec<ValidationIssue> {
    match error {
        CallError::Generic(RpcCallError::NonCompliantServer { original, issues }) => {
            assert_eq!(original.as_ref(), expected);
            assert!(!issues.is_empty());
            issues
        }
        other => panic!("expected non-compliant server, got {other:?}"),
    }
}

#[test]
fn boxed_compliance_errors_preserve_original_through_conversions() {
    for data in [
        None,
        Some(JsonValue::Null),
        Some(json!({"type": "Unknown"})),
    ] {
        let wire = JsonRpcError {
            code: 1,
            message: "Rejected error".into(),
            data,
        };
        for failure in [
            NamedError::try_from_rpc_error_detailed(wire.clone()).unwrap_err(),
            ManualError::try_from_rpc_error_detailed(wire.clone()).unwrap_err(),
        ] {
            let ApplicationErrorDecodeError::Invalid { original, issues } = failure else {
                panic!("known code must be a compliance error");
            };
            assert_eq!(original.as_ref(), &wire);
            assert!(!issues.is_empty());
            let error = CallError::<NamedError>::Generic(RpcCallError::NonCompliantServer {
                original,
                issues,
            });
            assert_eq!(error.into_rpc_error(), wire);
        }
        assert_eq!(
            NamedError::try_from_rpc_error(wire.clone()).unwrap_err(),
            wire
        );
    }
}

#[derive(Clone, Debug, PartialEq, linkrpc::ApplicationError)]
enum RawError {
    #[rpc_error(code = -32001, raw)]
    Busy { message: String, data: MissingData },
    #[rpc_error(code = -32002, raw)]
    Optional {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<String>,
    },
    #[rpc_error(code = -32003, raw)]
    Nullable {
        message: String,
        data: Option<String>,
    },
    #[rpc_error(code = -32004, raw)]
    Body(RawBody),
    #[rpc_error(code = -32006, raw)]
    OptionalBody(OptionalRawBody),
    #[rpc_error(code = -32005, raw)]
    OptionalNullable {
        message: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_present"
        )]
        data: Option<Option<String>>,
    },
    #[rpc_error(message = "Named still works")]
    Named,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct RawBody {
    message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct OptionalRawBody {
    message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<JsonValue>,
}

#[derive(Debug, PartialEq, linkrpc::ApplicationError)]
enum AnyRawBodyError {
    #[rpc_error(code = -32010, raw)]
    Any(JsonValue),
}

#[test]
fn authored_raw_top_schema_accepts_only_protocol_valid_bodies_at_runtime() {
    assert_eq!(
        serde_json::to_value(AnyRawBodyError::error_schemas()).unwrap(),
        json!([{ "code": -32010, "schema": true }]),
    );
    for body in [
        json!({"message": "Dynamic"}),
        json!({"message": "Null", "data": null}),
        json!({"message": "JSON", "data": [1, true, {"nested": null}]}),
    ] {
        let error = AnyRawBodyError::Any(body.clone()).into_rpc_error();
        assert_eq!(error.code, -32010);
        assert_eq!(error.data.as_ref(), body.get("data"));
        assert_eq!(
            CallError::<AnyRawBodyError>::from_remote(error),
            CallError::Application(AnyRawBodyError::Any(body)),
        );
    }
    for body in [
        json!({}),
        json!({"message": false}),
        json!({"message": "Unexpected sibling", "extra": true}),
    ] {
        assert_eq!(
            AnyRawBodyError::Any(body).into_rpc_error().code,
            error_codes::INTERNAL_ERROR
        );
    }
}

#[derive(Clone, Debug, PartialEq, linkrpc::ApplicationError)]
enum RawTagCollision {
    #[rpc_error(code = -32001, raw)]
    Shared(RawBody),
    #[rpc_error(code = 17, name = "Shared", message = "Named")]
    Named,
    #[rpc_error(code = 18, name = "Shared2", message = "Another named")]
    AnotherNamed,
}

#[derive(Clone, Debug, PartialEq, linkrpc::ApplicationError)]
enum ReversedRawTagCollision {
    #[rpc_error(code = 17, name = "Shared", message = "Named")]
    Named,
    #[rpc_error(code = -32001, raw)]
    Shared(RawBody),
}

#[test]
fn raw_derive_allocates_private_tags_against_all_named_wire_names() {
    for error in [
        RawTagCollision::Shared(RawBody {
            message: "Raw".into(),
        }),
        RawTagCollision::Named,
        RawTagCollision::AnotherNamed,
    ] {
        assert_eq!(
            RawTagCollision::try_from_rpc_error(error.clone().into_rpc_error()),
            Ok(error)
        );
    }
    for error in [
        ReversedRawTagCollision::Shared(RawBody {
            message: "Raw".into(),
        }),
        ReversedRawTagCollision::Named,
    ] {
        assert_eq!(
            ReversedRawTagCollision::try_from_rpc_error(error.clone().into_rpc_error()),
            Ok(error)
        );
    }
    assert_eq!(
        RawTagCollision::Named.into_rpc_error().data,
        Some(json!({"type": "Shared"}))
    );
    assert_eq!(
        RawTagCollision::Shared(RawBody {
            message: "Raw".into()
        })
        .into_rpc_error()
        .data,
        None
    );
}

#[test]
fn raw_optional_unknown_newtype_accepts_absence_and_null() {
    for data in [
        None,
        Some(JsonValue::Null),
        Some(json!({"arbitrary": true})),
    ] {
        let original = JsonRpcError {
            code: -32006,
            message: "Dynamic message".into(),
            data: data.clone(),
        };
        let decoded_data = data.filter(|value| !value.is_null());
        assert_eq!(
            CallError::<RawError>::from_remote(original),
            CallError::Application(RawError::OptionalBody(OptionalRawBody {
                message: "Dynamic message".into(),
                data: decoded_data,
            })),
        );
    }
}

fn deserialize_present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[test]
fn raw_foreign_errors_have_dynamic_messages_and_no_envelope() {
    for error in [
        RawError::Busy {
            message: "Retry after 12 seconds".into(),
            data: MissingData {
                resource: "x".into(),
            },
        },
        RawError::Optional {
            message: "No data".into(),
            data: None,
        },
        RawError::Optional {
            message: "Some data".into(),
            data: Some("x".into()),
        },
        RawError::Nullable {
            message: "Null data".into(),
            data: None,
        },
        RawError::Body(RawBody {
            message: "Body only".into(),
        }),
        RawError::OptionalNullable {
            message: "Absent".into(),
            data: None,
        },
        RawError::OptionalNullable {
            message: "Null".into(),
            data: Some(None),
        },
        RawError::OptionalNullable {
            message: "String".into(),
            data: Some(Some("x".into())),
        },
        RawError::Named,
    ] {
        let wire = error.clone().into_rpc_error();
        assert_eq!(
            CallError::<RawError>::from_remote(wire.clone()),
            CallError::Application(error)
        );
        if wire.code == -32001 {
            assert_eq!(wire.message, "Retry after 12 seconds");
            assert_eq!(wire.data, Some(json!({"resource": "x"})));
        }
        if wire.code == -32002 && wire.message == "No data" {
            assert_eq!(
                serde_json::to_value(&wire).unwrap(),
                json!({"code": -32002, "message": "No data"})
            );
        }
        if wire.code == -32003 {
            assert_eq!(
                serde_json::to_value(&wire).unwrap(),
                json!({"code": -32003, "message": "Null data", "data": null})
            );
        }
    }
    let schemas = serde_json::to_value(RawError::error_schemas()).unwrap();
    assert_eq!(schemas[0]["code"], -32001);
    assert!(schemas[0].get("message").is_none());
    assert!(schemas[0].get("type").is_none());
    assert_eq!(
        schemas[0]["schema"]["properties"]["message"]["type"],
        "string"
    );
    let mut schema = lookup::interface().to_schema();
    schema.methods.get_mut("lookup").unwrap().errors = Some(RawError::error_schemas());
    schema.components = Some(RawError::error_components());
    schema.validate().unwrap();
}

#[test]
fn handled_raw_code_uses_serde_option_semantics_and_reports_decode_failures() {
    let absent = JsonRpcError::new(-32003, "required nullable data missing");
    assert_eq!(
        CallError::<RawError>::from_remote(absent.clone()),
        CallError::Application(RawError::Nullable {
            message: absent.message,
            data: None,
        }),
    );
    let malformed = JsonRpcError {
        code: -32001,
        message: "busy".into(),
        data: Some(json!({"resource": 42})),
    };
    let issues = assert_noncompliant(
        CallError::<RawError>::from_remote(malformed.clone()),
        &malformed,
    );
    assert!(issues
        .iter()
        .any(|issue| issue.path == "/data/resource" && issue.message.contains("string")));
    let null = JsonRpcError {
        code: -32002,
        message: "optional but nonnullable".into(),
        data: Some(json!(null)),
    };
    assert_eq!(
        CallError::<RawError>::from_remote(null.clone()),
        CallError::Application(RawError::Optional {
            message: null.message,
            data: None,
        }),
    );
    let unknown = JsonRpcError {
        code: -32099,
        message: "foreign".into(),
        data: Some(json!(null)),
    };
    assert_eq!(
        CallError::<RawError>::from_remote(unknown.clone()),
        CallError::Generic(RpcCallError::Remote(unknown))
    );
}

#[derive(Debug, PartialEq, Serialize, JsonSchema)]
struct DecoderNumber(#[schemars(with = "String")] i64);

static DECODE_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

impl<'de> Deserialize<'de> for DecoderNumber {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        DECODE_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        i64::deserialize(deserializer).map(Self)
    }
}

#[derive(Debug, PartialEq, linkrpc::ApplicationError)]
enum DecoderError {
    #[rpc_error(message = "Number")]
    Number(DecoderNumber),
    #[rpc_error(code = -32001, raw)]
    Raw {
        message: String,
        data: DecoderNumber,
    },
}

#[derive(Debug, PartialEq)]
struct ManualDecoderError(DecoderError);

impl ApplicationError for ManualDecoderError {
    fn into_rpc_error(self) -> JsonRpcError {
        self.0.into_rpc_error()
    }

    fn try_from_rpc_error(error: JsonRpcError) -> Result<Self, JsonRpcError> {
        DecoderError::try_from_rpc_error(error).map(Self)
    }

    fn error_schemas() -> Vec<ErrorSchema> {
        DecoderError::error_schemas()
    }
}

#[test]
fn the_decoder_is_authoritative_and_runs_once_per_error() {
    DECODE_CALLS.store(0, std::sync::atomic::Ordering::SeqCst);
    let named = JsonRpcError {
        code: 1,
        message: "Number".into(),
        data: Some(json!({"type": "Number", "data": 42})),
    };
    assert_eq!(
        CallError::<DecoderError>::from_remote(named.clone()),
        CallError::Application(DecoderError::Number(DecoderNumber(42))),
    );
    assert_eq!(DECODE_CALLS.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        CallError::<ManualDecoderError>::from_remote(named),
        CallError::Application(ManualDecoderError(DecoderError::Number(DecoderNumber(42)))),
    );
    assert_eq!(DECODE_CALLS.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(
        CallError::<DecoderError>::from_remote(JsonRpcError {
            code: -32001,
            message: "Number".into(),
            data: Some(json!(42)),
        }),
        CallError::Application(DecoderError::Raw {
            message: "Number".into(),
            data: DecoderNumber(42),
        }),
    );
    assert_eq!(DECODE_CALLS.load(std::sync::atomic::Ordering::SeqCst), 3);
}

#[test]
fn issue_paths_escape_json_pointer_segments() {
    let issues = validate_json_schema_issues(
        &json!({"a/b~c": [false]}),
        &json!({"type": "object", "properties": {"a/b~c": {"type": "array", "items": {"type": "string"}}}}),
        None,
    );
    assert_eq!(
        issues,
        vec![ValidationIssue {
            path: "/a~1b~0c/0".into(),
            message: "expected type \"string\"".into()
        }]
    );
}

#[derive(Debug, Serialize, JsonSchema)]
struct SerdeRejected(String);

impl<'de> Deserialize<'de> for SerdeRejected {
    fn deserialize<D: serde::Deserializer<'de>>(_deserializer: D) -> Result<Self, D::Error> {
        Err(serde::de::Error::custom(
            "custom application deserializer rejected data",
        ))
    }
}

#[derive(Debug, linkrpc::ApplicationError)]
enum SerdeError {
    #[rpc_error(message = "Rejected")]
    Rejected(SerdeRejected),
}

#[test]
fn serde_failures_are_compliance_errors_with_details() {
    let original = JsonRpcError {
        code: 1,
        message: "x".into(),
        data: Some(json!({"type": "Rejected", "data": "schema-valid"})),
    };
    let issues = assert_noncompliant(
        CallError::<SerdeError>::from_remote(original.clone()),
        &original,
    );
    assert!(issues.iter().any(|issue| issue
        .message
        .contains("custom application deserializer rejected data")));
    assert!(issues.iter().any(|issue| issue.path == "/data/data"));
}

#[derive(Debug, PartialEq)]
struct ManualError(NamedError);

impl ApplicationError for ManualError {
    fn into_rpc_error(self) -> JsonRpcError {
        self.0.into_rpc_error()
    }

    fn try_from_rpc_error(error: JsonRpcError) -> Result<Self, JsonRpcError> {
        NamedError::try_from_rpc_error(error).map(Self)
    }

    fn error_schemas() -> Vec<ErrorSchema> {
        NamedError::error_schemas()
    }

    fn error_components() -> Components {
        NamedError::error_components()
    }
}

#[test]
fn existing_trait_implementers_get_code_first_detailed_validation() {
    let malformed = JsonRpcError {
        code: 1,
        message: "unrecognized type".into(),
        data: Some(json!({"type": "Other"})),
    };
    assert_noncompliant(
        CallError::<ManualError>::from_remote(malformed.clone()),
        &malformed,
    );
    let valid = NamedError::Busy.into_rpc_error();
    assert_eq!(
        CallError::<ManualError>::from_remote(valid.clone()),
        CallError::Application(ManualError(NamedError::Busy))
    );
    assert_eq!(
        CallError::<ManualError>::from_call_error(RpcCallError::Local(valid.clone())),
        CallError::Generic(RpcCallError::Local(valid)),
    );
    let unknown = JsonRpcError {
        code: 505,
        message: "unknown".into(),
        data: Some(json!(null)),
    };
    assert_eq!(
        CallError::<ManualError>::from_remote(unknown.clone()),
        CallError::Generic(RpcCallError::Remote(unknown))
    );
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct MissingData {
    resource: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
struct RecursiveData {
    label: String,
    children: Vec<RecursiveData>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
struct BadParam;

impl Serialize for BadParam {
    fn serialize<S: serde::Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom(
            "intentional serialization failure",
        ))
    }
}

#[derive(Clone, Debug, PartialEq, linkrpc::ApplicationError)]
enum LookupError {
    #[rpc_error(code = 1001, message = "Missing")]
    Missing(MissingData),
    #[rpc_error(code = 1002, message = "Busy")]
    Busy,
    #[rpc_error(code = 1003, message = "Nullable")]
    Nullable(Option<String>),
    #[rpc_error(code = 1004, message = "Recursive")]
    Recursive(RecursiveData),
}

#[derive(Clone, Debug, PartialEq, linkrpc::ApplicationError)]
#[rpc_error(display)]
enum NamedError {
    #[rpc_error(message = "Not found")]
    NotFound { resource: String },
    #[rpc_error(message = "Busy")]
    Busy,
    #[rpc_error(message = "Nullable")]
    Nullable(Option<String>),
    #[rpc_error(message = "Recursive")]
    Recursive(RecursiveData),
    #[rpc_error(code = 41, message = "Explicit", name = "stable-wire-name")]
    Renamed { resource: String },
}

#[test]
fn named_errors_use_default_code_and_tagged_serde_payloads() {
    for (error, code, data) in [
        (
            NamedError::NotFound {
                resource: "widget".into(),
            },
            1,
            json!({"type": "NotFound", "data": {"resource": "widget"}}),
        ),
        (NamedError::Busy, 1, json!({"type": "Busy"})),
        (
            NamedError::Nullable(None),
            1,
            json!({"type": "Nullable", "data": null}),
        ),
        (
            NamedError::Renamed {
                resource: "widget".into(),
            },
            41,
            json!({"type": "stable-wire-name", "data": {"resource": "widget"}}),
        ),
    ] {
        let mut wire = error.clone().into_rpc_error();
        assert_eq!(wire.code, code);
        assert_eq!(wire.data, Some(data));
        wire.message = "Human-readable explanation may vary".into();
        assert_eq!(NamedError::try_from_rpc_error(wire), Ok(error));
    }
    assert_eq!(DEFAULT_APPLICATION_ERROR_CODE, 1);
    assert_eq!(
        NamedError::NotFound {
            resource: "x".into()
        }
        .to_string(),
        "Not found"
    );
    let schemas = NamedError::error_schemas();
    assert_eq!(schemas[0].code, 1);
    assert_eq!(schemas[0].r#type.as_deref(), Some("NotFound"));
    assert_eq!(
        schemas[0].data.as_ref().unwrap()["properties"]["resource"]["type"],
        "string"
    );
    assert!(schemas[1].data.is_none());
    let mut schema = lookup::interface().to_schema();
    schema.methods.get_mut("lookup").unwrap().errors = Some(schemas);
    schema.validate().unwrap();
    let recursive = NamedError::Recursive(RecursiveData {
        label: "root".into(),
        children: vec![RecursiveData {
            label: "leaf".into(),
            children: vec![],
        }],
    });
    assert_eq!(
        NamedError::try_from_rpc_error(recursive.clone().into_rpc_error()),
        Ok(recursive)
    );
}

#[test]
fn malformed_named_errors_retain_original_remote_error() {
    for data in [
        json!({"data": {"resource": "x"}}),
        json!({"type": "Unknown"}),
        json!({"type": 42, "data": {"resource": "x"}}),
        json!({"type": "NotFound"}),
        json!({"type": "NotFound", "data": {"resource": 42}}),
        json!({"type": "NotFound", "data": {"resource": "x", "extra": true}}),
        json!({"type": "NotFound", "data": null}),
        json!({"type": "Busy", "data": null}),
        json!({"type": "Busy", "extra": true}),
        json!({"type": "Nullable"}),
        json!({"type": "stable-wire-name", "data": {"resource": "x"}}),
        json!({"type": "Recursive", "data": {"label": "x", "children": [null]}}),
        json!(null),
    ] {
        let original = JsonRpcError {
            code: 1,
            message: "Not found".into(),
            data: Some(data),
        };
        assert_noncompliant(
            CallError::<NamedError>::from_remote(original.clone()),
            &original,
        );
    }
}

fn nullable_field_schema() -> LinkRpcInterfaceSchema {
    serde_json::from_value(json!({
        "id": "nullable.field", "hash": "", "methods": {
            "check": { "params": true, "result": true, "errors": [{
                "code": 1, "type": "Nullable", "message": "Nullable",
                "data": {
                    "type": "object",
                    "properties": { "value": { "anyOf": [{ "type": "string" }, { "type": "null" }] } },
                    "required": ["value"],
                    "additionalProperties": false
                }
            }] }
        }
    })).unwrap()
}

#[derive(Debug, PartialEq, linkrpc::ApplicationError)]
#[rpc_error(schema = nullable_field_schema, method = "check")]
enum NullableFieldError {
    #[rpc_error(message = "Nullable")]
    Nullable { value: Option<String> },
}

#[test]
fn nullable_struct_fields_follow_serde_while_invalid_envelopes_are_rejected() {
    let error = NullableFieldError::Nullable { value: None }.into_rpc_error();
    assert_eq!(
        error.data,
        Some(json!({ "type": "Nullable", "data": { "value": null } }))
    );
    assert_eq!(
        NullableFieldError::try_from_rpc_error(error),
        Ok(NullableFieldError::Nullable { value: None })
    );
    assert_eq!(
        NullableFieldError::try_from_rpc_error(JsonRpcError {
            code: 1,
            message: "Nullable".into(),
            data: Some(json!({ "type": "Nullable", "data": {} })),
        }),
        Ok(NullableFieldError::Nullable { value: None })
    );
    for data in [
        None,
        Some(json!({ "type": "Nullable" })),
        Some(json!({ "type": "Nullable", "data": { "value": null, "extra": true } })),
    ] {
        let original = JsonRpcError {
            code: 1,
            message: "Nullable".into(),
            data,
        };
        assert_noncompliant(
            CallError::<NullableFieldError>::from_remote(original.clone()),
            &original,
        );
    }
}

fn mixed_error_schema() -> LinkRpcInterfaceSchema {
    serde_json::from_value(json!({
        "id": "mixed.errors", "hash": "", "methods": {
            "check": { "params": true, "result": true, "errors": [
                { "code": 1, "message": "Shared", "data": true },
                { "code": 1, "type": "Named", "message": "Shared", "data": { "type": "boolean" } }
            ] }
        }
    }))
    .unwrap()
}

#[derive(Debug, PartialEq, linkrpc::ApplicationError)]
#[rpc_error(schema = mixed_error_schema, method = "check")]
enum MixedError {
    #[rpc_error(message = "Shared")]
    Legacy(JsonValue),
    #[rpc_error(message = "Shared")]
    Named(bool),
}

#[test]
fn named_recognition_precedes_legacy_when_codes_collide() {
    let schema = mixed_error_schema();
    schema.validate().unwrap();
    let generated = generate_rust_interface(&schema, &GenerateRustOptions::default());
    assert!(!generated.code.contains("compile_error!"));
    assert!(generated.code.contains("Code1("));
    assert!(generated.code.contains("Named(bool)"));

    let named = MixedError::Named(true).into_rpc_error();
    assert_eq!(named.data, Some(json!({ "type": "Named", "data": true })));
    assert_eq!(
        MixedError::try_from_rpc_error(named),
        Ok(MixedError::Named(true))
    );
    let legacy = MixedError::Legacy(json!(42)).into_rpc_error();
    assert_eq!(legacy.data, Some(json!(42)));
    assert_eq!(
        MixedError::try_from_rpc_error(legacy),
        Ok(MixedError::Legacy(json!(42)))
    );
}

#[test]
fn declared_code_union_accepts_a_valid_legacy_branch_after_invalid_named_branch() {
    for data in [
        json!({ "type": "Named", "data": "not a boolean" }),
        json!({ "type": "Named", "data": true, "extra": true }),
        json!({ "type": "Named" }),
        json!({ "type": "Named", "data": null }),
    ] {
        let original = JsonRpcError {
            code: 1,
            message: "Shared".into(),
            data: Some(data.clone()),
        };
        assert_eq!(
            CallError::<MixedError>::from_remote(original.clone()),
            CallError::Application(MixedError::Legacy(data)),
        );
    }
    let data = json!({ "type": "Unknown", "data": "legacy payload" });
    let legacy = JsonRpcError {
        code: 1,
        message: "Shared".into(),
        data: Some(data.clone()),
    };
    assert_eq!(
        MixedError::try_from_rpc_error(legacy),
        Ok(MixedError::Legacy(data))
    );
}

#[derive(Debug, Serialize)]
struct RejectedBool(bool);

impl<'de> Deserialize<'de> for RejectedBool {
    fn deserialize<D: serde::Deserializer<'de>>(_deserializer: D) -> Result<Self, D::Error> {
        Err(serde::de::Error::custom("named branch cannot decode"))
    }
}

#[derive(Debug, linkrpc::ApplicationError)]
#[rpc_error(schema = mixed_error_schema, method = "check")]
enum SerdeUnionError {
    #[rpc_error(message = "Shared")]
    Legacy(JsonValue),
    #[rpc_error(message = "Shared")]
    Named(RejectedBool),
}

#[test]
fn code_union_tries_legacy_after_named_serde_failure() {
    let data = json!({ "type": "Named", "data": true });
    let error = JsonRpcError {
        code: 1,
        message: "Shared".into(),
        data: Some(data.clone()),
    };
    assert!(matches!(
        CallError::<SerdeUnionError>::from_remote(error),
        CallError::Application(SerdeUnionError::Legacy(value)) if value == data
    ));
    let original = JsonRpcError {
        code: 1,
        message: "Not the legacy message".into(),
        data: Some(json!({ "type": "Other" })),
    };
    let issues = assert_noncompliant(
        CallError::<SerdeUnionError>::from_remote(original.clone()),
        &original,
    );
    assert!(issues.iter().any(|issue| issue.path == "/message"));
    assert!(issues.iter().any(|issue| issue.path == "/data/type"));
}

#[derive(Debug, linkrpc::ApplicationError)]
enum InvalidRawBodyError {
    #[rpc_error(code = -32001, raw)]
    Invalid(String),
}

#[linkrpc::prelude::link_rpc_interface(id = "example.invalid-raw-body")]
trait InvalidRawBodyApi {
    async fn check() -> Result<(), InvalidRawBodyError>;
}

#[test]
fn raw_newtypes_enforce_protocol_body_when_encoding_not_when_importing_schema() {
    invalid_raw_body_api::interface()
        .to_schema()
        .validate()
        .unwrap();
    let error = InvalidRawBodyError::Invalid("not an error object".into()).into_rpc_error();
    assert_eq!(error.code, error_codes::INTERNAL_ERROR);
    assert!(error.message.contains("requires a string message"));
}

#[derive(Debug, linkrpc::ApplicationError)]
enum InvalidPayloadError {
    #[rpc_error(code = 1100, message = "Invalid float")]
    InvalidFloat(f64),
}

mod first {
    use super::*;
    #[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
    pub struct Payload {
        pub children: Vec<Payload>,
    }
    #[derive(Debug, linkrpc::ApplicationError)]
    pub enum Error {
        #[rpc_error(code = 1201, message = "First")]
        Value(Payload),
    }
}

mod second {
    use super::*;
    #[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
    pub struct Payload {
        pub label: String,
        pub child: Option<Box<Payload>>,
    }
    #[derive(Debug, linkrpc::ApplicationError)]
    pub enum Error {
        #[rpc_error(code = 1202, message = "Second")]
        Value(Payload),
    }
}

#[derive(Debug, linkrpc::ApplicationError)]
enum CombinedError {
    #[rpc_error(code = 1203, message = "Combined first")]
    First(first::Payload),
    #[rpc_error(code = 1204, message = "Combined second")]
    Second(second::Payload),
}

#[linkrpc::prelude::link_rpc_interface(id = "example.collisions")]
trait CollisionApi {
    async fn first() -> Result<(), first::Error>;
    async fn second() -> Result<(), second::Error>;
    async fn combined() -> Result<(), CombinedError>;
}

#[linkrpc::prelude::link_rpc_interface(id = "example.lookup")]
trait Lookup {
    async fn lookup(resource: String) -> Result<String, CallError<LookupError>>;

    async fn bad_param(value: BadParam) -> Result<String, LookupError>;

    async fn direct(resource: String) -> std::result::Result<String, LookupErrorAlias>;

    #[output_stream(String)]
    async fn streaming(resource: String) -> Result<String, CallError<LookupError>>;

    async fn legacy() -> Result<String, linkrpc::prelude::JsonRpcError>;
}

type LookupErrorAlias = LookupError;

struct Provider;

#[test]
#[should_panic(expected = "protocol-reserved")]
fn manually_authored_errors_cannot_bypass_validation() {
    let interface = InterfaceDefinition::new(
        InterfaceInfo::new("example.invalid-errors"),
        vec![(
            "check".into(),
            Member::Request(Box::new(RequestMember {
                params_schema: json!(true),
                result_schema: json!(true),
                client_stream_schema: None,
                server_stream_schema: None,
                errors: Some(vec![ErrorSchema {
                    code: -32603,
                    schema: None,
                    r#type: Some("Invalid".into()),
                    message: "Invalid application code".into(),
                    data: None,
                }]),
                error_components: None,
                docs: MemberDocs::default(),
            })),
        )],
    );
    interface.to_schema();
}

#[test]
#[should_panic(expected = "duplicate error type")]
fn imported_interfaces_reject_duplicate_names() {
    let mut schema = lookup::interface().to_schema();
    let errors = schema
        .methods
        .get_mut("lookup")
        .unwrap()
        .errors
        .as_mut()
        .unwrap();
    errors[1].r#type = errors[0].r#type.clone();
    InterfaceDefinition::from_schema(schema);
}

#[test]
#[should_panic(expected = "must not declare errors")]
fn imported_notifications_reject_even_empty_error_declarations() {
    let mut schema = lookup::interface().to_schema();
    let method = schema.methods.get_mut("lookup").unwrap();
    method.result = None;
    method.errors = Some(vec![]);
    InterfaceDefinition::from_schema(schema);
}

#[async_trait]
impl Lookup for Provider {
    async fn streaming(
        &self,
        _ctx: &CallCtx,
        resource: String,
        progress: StreamSender<String>,
    ) -> Result<String, CallError<LookupError>> {
        progress
            .send("started".into())
            .await
            .map_err(|e| CallError::Generic(RpcCallError::Local(e)))?;
        match resource.as_str() {
            "unknown" => Err(CallError::Generic(RpcCallError::Remote(JsonRpcError::new(
                9999, "Unknown",
            )))),
            "malformed" => Err(CallError::Generic(RpcCallError::Remote(JsonRpcError {
                code: 1001,
                message: "Missing".into(),
                data: Some(json!({ "resource": 42 })),
            }))),
            _ => self
                .direct(_ctx, resource)
                .await
                .map_err(CallError::Application),
        }
    }

    async fn direct(&self, _ctx: &CallCtx, resource: String) -> Result<String, LookupErrorAlias> {
        match resource.as_str() {
            "known" => Ok("found".into()),
            "busy" => Err(LookupError::Busy),
            _ => Err(LookupError::Missing(MissingData { resource })),
        }
    }

    async fn lookup(
        &self,
        _ctx: &CallCtx,
        resource: String,
    ) -> Result<String, CallError<LookupError>> {
        Err(CallError::Application(LookupError::Missing(MissingData {
            resource,
        })))
    }

    async fn legacy(&self, _ctx: &CallCtx) -> Result<String, JsonRpcError> {
        Err(JsonRpcError::new(-31_000, "legacy"))
    }

    async fn bad_param(&self, _ctx: &CallCtx, _value: BadParam) -> Result<String, LookupError> {
        Ok("unused".into())
    }
}

#[test]
fn derive_requires_exact_wire_contract() {
    let known = JsonRpcError {
        code: 1001,
        message: "Descriptive text is not a discriminator".into(),
        data: Some(json!({ "type": "Missing", "data": { "resource": "a" } })),
    };
    assert_eq!(
        LookupError::try_from_rpc_error(known),
        Ok(LookupError::Missing(MissingData {
            resource: "a".into()
        }))
    );
    assert_eq!(
        LookupError::try_from_rpc_error(JsonRpcError {
            code: 1003,
            message: "Nullable".into(),
            data: Some(json!({ "type": "Nullable", "data": null })),
        }),
        Ok(LookupError::Nullable(None))
    );
    let recursive = LookupError::Recursive(RecursiveData {
        label: "root".into(),
        children: vec![RecursiveData {
            label: "child".into(),
            children: vec![],
        }],
    })
    .into_rpc_error();
    assert!(matches!(
        LookupError::try_from_rpc_error(recursive),
        Ok(LookupError::Recursive(RecursiveData { children, .. })) if children.len() == 1
    ));

    for malformed in [
        JsonRpcError {
            code: 1001,
            message: "missing".into(),
            data: Some(json!({ "resource": "a" })),
        },
        JsonRpcError {
            code: 1003,
            message: "Nullable".into(),
            data: None,
        },
        JsonRpcError {
            code: 1001,
            message: "Missing".into(),
            data: None,
        },
        JsonRpcError {
            code: 1001,
            message: "Missing".into(),
            data: Some(json!({ "resource": "a", "extra": true })),
        },
        JsonRpcError {
            code: 1002,
            message: "Busy".into(),
            data: Some(JsonValue::Null),
        },
    ] {
        let original = malformed.clone();
        assert_eq!(LookupError::try_from_rpc_error(malformed), Err(original));
    }
}

#[test]
fn trait_schema_exports_declared_errors() {
    let schema = lookup::interface().to_schema();
    let errors = schema.methods["lookup"].errors.as_ref().unwrap();
    assert_eq!(errors.len(), 4);
    assert_eq!(errors[0].code, 1001);
    assert_eq!(errors[0].message, "Missing");
    assert!(errors[0].data.is_some());
    assert_eq!(errors[1].code, 1002);
    assert!(errors[1].data.is_none());
    assert!(schema.methods["legacy"].errors.is_none());
    assert!(schema
        .components
        .as_ref()
        .and_then(|components| components.schemas.as_ref())
        .is_some_and(|schemas| schemas.keys().any(|name| name.ends_with(".RecursiveData"))));
}

#[test]
fn outgoing_invalid_payload_becomes_internal_error_without_panicking() {
    let error = InvalidPayloadError::InvalidFloat(f64::NAN).into_rpc_error();
    assert_eq!(error.code, error_codes::INTERNAL_ERROR);
    assert!(error.data.is_none());
}

#[test]
fn derived_error_components_are_scoped_by_method_and_name() {
    let schema = collision_api::interface().to_schema();
    let schemas = schema.components.unwrap().schemas.unwrap();
    assert!(schemas.keys().any(|name| name.starts_with("first.Value.")));
    assert!(schemas.keys().any(|name| name.starts_with("second.Value.")));
    assert!(schemas
        .keys()
        .any(|name| name.starts_with("combined.First.")));
    assert!(schemas
        .keys()
        .any(|name| name.starts_with("combined.Second.")));
    assert_eq!(schemas.len(), 4);
}

#[tokio::test]
async fn typed_client_and_server_round_trip() {
    let (a, b) = transport_pair();
    let client_conn = LinkRpcConnection::new(Box::new(a));
    let server_conn = LinkRpcConnection::new(Box::new(b));
    server_conn
        .register_service(
            Arc::new(LookupServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();
    let client_run = client_conn.clone();
    let server_run = server_conn.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move { server_run.run().await });

    let client = LookupClient::new(client_conn);
    assert_eq!(
        client.lookup("widget".into()).await.unwrap_err(),
        CallError::Application(LookupError::Missing(MissingData {
            resource: "widget".into()
        }))
    );

    let legacy = client.legacy().await.unwrap_err();
    assert_eq!(legacy.code, -31_000);

    assert_eq!(client.direct("known".into()).await, Ok("found".into()));
    assert_eq!(
        client.direct("busy".into()).await,
        Err(CallError::Application(LookupError::Busy))
    );
    assert_eq!(
        client.direct("widget".into()).await,
        Err(CallError::Application(LookupError::Missing(MissingData {
            resource: "widget".into()
        })))
    );

    let schema = lookup::interface().to_schema();
    assert_eq!(schema.methods["direct"].errors.as_ref().unwrap().len(), 4);
    assert!(schema.methods["legacy"].errors.is_none());
}

#[tokio::test]
async fn inferred_errors_preserve_streaming_and_final_error_types() {
    let (a, b) = transport_pair();
    let client_conn = LinkRpcConnection::new(Box::new(a));
    let server_conn = LinkRpcConnection::new(Box::new(b));
    server_conn
        .register_service(
            Arc::new(LookupServer::new(Arc::new(Provider))),
            RegisterOptions::default(),
        )
        .unwrap();
    let client_run = client_conn.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move { server_conn.run().await });
    let client = LookupClient::new(client_conn);

    for resource in ["known", "busy", "widget", "unknown", "malformed"] {
        let call = client.streaming(resource.into()).await.unwrap();
        let (result, _, mut progress, _) = call.into_parts();
        assert_eq!(progress.recv().await, Some("started".into()));
        let result: Result<String, CallError<LookupError>> = result.await;
        match resource {
            "known" => assert_eq!(result, Ok("found".into())),
            "busy" => assert_eq!(result, Err(CallError::Application(LookupError::Busy))),
            "widget" => assert_eq!(
                result,
                Err(CallError::Application(LookupError::Missing(MissingData {
                    resource: "widget".into(),
                })))
            ),
            "unknown" => {
                assert!(
                    matches!(result, Err(CallError::Generic(RpcCallError::Remote(error))) if error.code == 9999)
                )
            }
            "malformed" => assert!(
                matches!(result, Err(CallError::Generic(RpcCallError::NonCompliantServer { original, issues }))
                if original.data == Some(json!({ "resource": 42 })) && !issues.is_empty())
            ),
            _ => unreachable!(),
        }
        assert_eq!(progress.recv().await, None);
    }
}

#[tokio::test]
async fn authored_client_marks_param_serialization_failures_local() {
    let (transport, _peer) = transport_pair();
    let client = LookupClient::new(LinkRpcConnection::new(Box::new(transport)));
    let error = client.bad_param(BadParam).await.unwrap_err();
    assert!(matches!(
        error,
        CallError::Generic(RpcCallError::Local(JsonRpcError {
            code: error_codes::INTERNAL_ERROR,
            ..
        }))
    ));
}

#[tokio::test]
async fn typed_client_preserves_transport_origin_when_peer_closes() {
    let (client_transport, peer_transport) = transport_pair();
    let client_connection = LinkRpcConnection::new(Box::new(client_transport));
    let client_run = client_connection.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move {
        // Wait until the request is in flight, then simulate NDJSON EOF.
        let _request = peer_transport.recv().await;
        drop(peer_transport);
    });

    let error = LookupClient::new(client_connection)
        .lookup("disconnect".into())
        .await
        .unwrap_err();
    assert_eq!(
        error,
        CallError::Generic(RpcCallError::Transport(TransportError::Closed))
    );

    // A peer cannot spoof this branch with the JSON-RPC PEER_DISCONNECTED code:
    // wire errors always enter through Remote classification.
    let spoofed = CallError::<LookupError>::from_remote(JsonRpcError::new(
        error_codes::PEER_DISCONNECTED,
        "channel closed",
    ));
    assert!(matches!(
        spoofed,
        CallError::Generic(RpcCallError::Remote(_))
    ));
}

#[test]
fn generated_errors_are_typed_and_validate_against_components() {
    let schema: LinkRpcInterfaceSchema = serde_json::from_value(json!({
        "id": "example.generated",
        "hash": "",
        "methods": {
            "fetch": {
                "params": { "type": "object", "properties": {}, "additionalProperties": false },
                "result": { "type": "string" },
                "errors": [
                    {
                        "code": 1001,
                        "message": "Missing",
                        "data": { "$ref": "#/components/schemas/Problem" }
                    },
                    { "code": -7, "message": "Offline" }
                ]
            }
        },
        "components": {
            "schemas": {
                "Problem": {
                    "type": "object",
                    "properties": { "reason": { "type": "string" } },
                    "required": ["reason"],
                    "additionalProperties": false
                }
            }
        }
    }))
    .unwrap();
    let generated = generate_rust_interface(&schema, &GenerateRustOptions::default()).code;
    assert!(generated.contains("pub enum FetchError"));
    assert!(generated.contains("Code1001(Problem)"));
    assert!(generated.contains("CodeMinus7"));
    assert!(generated.contains("CallError<FetchError>"));
    assert!(generated.contains("#[derive(Clone, Debug, linkrpc::prelude::ApplicationError)]"));
    assert!(
        generated.contains("#[rpc_error(schema = __linkrpc_interface::schema, method = \"fetch\"")
    );
}
