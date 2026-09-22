#![allow(clippy::too_many_arguments)]

use linkrpc::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

#[link_rpc_interface(schema_json = r#"{
    "id": "serde.params", "hash": "",
    "methods": {
        "inline": {"params": true, "result": true},
        "whole": {"params": true, "result": true}
    }
}"#)]
trait SerdeParams {
    async fn inline(
        plain: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")] omitted: Option<bool>,
        #[serde(
            default,
            deserialize_with = "deserialize_present",
            skip_serializing_if = "Option::is_none"
        )]
        non_null: Option<bool>,
        #[serde(deserialize_with = "Option::deserialize")] required_nullable: Option<bool>,
        #[serde(default = "default_count")] count: u32,
        #[serde(
            rename(serialize = "wireName", deserialize = "readName"),
            alias = "legacyName"
        )]
        name: String,
        #[serde(with = "string_number")] encoded: u32,
        #[serde(skip)] skipped: u32,
        #[serde(flatten)] extras: BTreeMap<String, Value>,
    ) -> Result<Value, JsonRpcError>;

    async fn whole(#[params] params: Params) -> Result<Value, JsonRpcError>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Params {
    plain: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    omitted: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    non_null: Option<bool>,
    #[serde(deserialize_with = "Option::deserialize")]
    required_nullable: Option<bool>,
    #[serde(default = "default_count")]
    count: u32,
    #[serde(
        rename(serialize = "wireName", deserialize = "readName"),
        alias = "legacyName"
    )]
    name: String,
    #[serde(with = "string_number")]
    encoded: u32,
    #[serde(skip)]
    skipped: u32,
    #[serde(flatten)]
    extras: BTreeMap<String, Value>,
}

struct Provider;

#[async_trait]
impl SerdeParams for Provider {
    async fn inline(
        &self,
        ctx: &CallCtx,
        plain: Option<bool>,
        omitted: Option<bool>,
        non_null: Option<bool>,
        required_nullable: Option<bool>,
        count: u32,
        name: String,
        encoded: u32,
        skipped: u32,
        extras: BTreeMap<String, Value>,
    ) -> Result<Value, JsonRpcError> {
        self.whole(
            ctx,
            Params {
                plain,
                omitted,
                non_null,
                required_nullable,
                count,
                name,
                encoded,
                skipped,
                extras,
            },
        )
        .await
    }

    async fn whole(&self, _ctx: &CallCtx, params: Params) -> Result<Value, JsonRpcError> {
        Ok(serde_json::to_value(params).unwrap())
    }
}

struct EchoCaller;

#[async_trait]
impl RpcCall for EchoCaller {
    async fn call(&self, _method: &str, params: Value) -> Result<Value, JsonRpcError> {
        Ok(params)
    }

    async fn notify(&self, _method: &str, _params: Value) -> Result<(), JsonRpcError> {
        unreachable!()
    }
}

#[link_rpc_interface(
    omit_optional_params = true,
    generate_server = false,
    schema_json = r##"{
        "id": "schema.omission", "hash": "",
        "methods": {
            "send": {"params": {"$ref": "#/components/schemas/Alias"}, "result": true},
            "whole": {"params": {"$ref": "#/components/schemas/Alias"}, "result": true}
        },
        "components": {"schemas": {
            "Alias": {"$ref": "#/components/schemas/Params"},
            "Params": {
                "type": "object",
                "properties": {
                    "optionalValue": {"type": "boolean"},
                    "required": {"type": ["boolean", "null"]},
                    "explicit": {"type": "boolean"},
                    "customName": {"type": "boolean"}
                },
                "required": ["required"],
                "additionalProperties": false
            }
        }}
    }"##
)]
trait SchemaOmission {
    async fn send(
        #[param(name = "optionalValue")] optional: Option<bool>,
        required: Option<bool>,
        #[serde(skip_serializing_if = "never_skip")] explicit: Option<bool>,
        #[serde(rename(serialize = "customName", deserialize = "readName"))] custom: Option<bool>,
    ) -> Result<Value, JsonRpcError>;

    async fn whole(#[params] params: Value) -> Result<Value, JsonRpcError>;
}

fn never_skip(_: &Option<bool>) -> bool {
    false
}

#[link_rpc_interface(
    generate_server = false,
    schema_json = r#"{
        "id": "schema.default", "hash": "",
        "methods": {"send": {"params": {
            "type": "object",
            "properties": {"value": {"type": "boolean"}},
            "additionalProperties": false
        }, "result": true}}
    }"#
)]
trait SchemaDefault {
    async fn send(value: Option<bool>) -> Result<Value, JsonRpcError>;
}

#[tokio::test]
async fn generated_omission_uses_requiredness_and_preserves_explicit_serde_and_defaults() {
    let client = SchemaOmissionClient::root(EchoCaller);
    assert_eq!(
        client.send(None, None, None, None).await.unwrap(),
        json!({"required": null, "explicit": null})
    );
    assert_eq!(
        client
            .send(Some(false), Some(true), Some(false), Some(true))
            .await
            .unwrap(),
        json!({"optionalValue": false, "required": true, "explicit": false, "customName": true})
    );
    assert_eq!(
        client.whole(json!({"optionalValue": null})).await.unwrap(),
        json!({"optionalValue": null})
    );
    assert_eq!(
        SchemaDefaultClient::root(EchoCaller)
            .send(None)
            .await
            .unwrap(),
        json!({"value": null})
    );
}

#[tokio::test]
async fn inline_serialization_matches_the_explicit_params_struct() {
    let client = SerdeParamsClient::root(EchoCaller);
    for value in [None, Some(false), Some(true)] {
        let params = Params {
            plain: value,
            omitted: value,
            non_null: value,
            required_nullable: value,
            count: 9,
            name: "source".into(),
            encoded: 42,
            skipped: 99,
            extras: [("extra".into(), json!([1, 2]))].into(),
        };
        let expected = serde_json::to_value(&params).unwrap();
        assert_eq!(client.whole(params.clone()).await.unwrap(), expected);
        assert_eq!(
            client
                .inline(
                    params.plain,
                    params.omitted,
                    params.non_null,
                    params.required_nullable,
                    params.count,
                    params.name,
                    params.encoded,
                    params.skipped,
                    params.extras,
                )
                .await
                .unwrap(),
            expected
        );
        if value.is_none() {
            assert_eq!(
                expected,
                json!({
                    "plain": null,
                    "required_nullable": null,
                    "count": 9,
                    "wireName": "source",
                    "encoded": "42",
                    "extra": [1, 2]
                })
            );
        }
    }
}

#[tokio::test]
async fn inline_deserialization_matches_the_explicit_params_struct() {
    let server = SerdeParamsServer::new(Arc::new(Provider));
    let base = json!({
        "required_nullable": null, "readName": "source", "encoded": "42", "extra": true
    });
    let mut inputs = vec![base.clone()];
    for (field, value) in [
        ("plain", Value::Null),
        ("omitted", Value::Null),
        ("non_null", Value::Null),
        ("non_null", json!(false)),
        ("required_nullable", json!(true)),
        ("plain", json!("not a boolean")),
        ("encoded", json!("not a number")),
        ("skipped", json!("ignored")),
    ] {
        let mut input = base.clone();
        input[field] = value;
        inputs.push(input);
    }
    let mut missing_required = base.clone();
    missing_required
        .as_object_mut()
        .unwrap()
        .remove("required_nullable");
    inputs.push(missing_required);
    let mut alias = base.clone();
    alias.as_object_mut().unwrap().remove("readName");
    alias["legacyName"] = json!("legacy");
    inputs.push(alias);

    for input in inputs {
        let expected = serde_json::from_value::<Params>(input.clone());
        for method in ["inline", "whole"] {
            let actual = server
                .handle_request(method, input.clone(), CallCtx::default())
                .await;
            match &expected {
                Ok(params) => assert_eq!(actual.unwrap(), serde_json::to_value(params).unwrap()),
                Err(_) => assert_eq!(actual.unwrap_err().code, error_codes::INVALID_PARAMS),
            }
        }
    }
    assert_eq!(
        server
            .handle_request("inline", base, CallCtx::default())
            .await
            .unwrap(),
        json!({
            "plain": null, "required_nullable": null, "count": 7,
            "wireName": "source", "encoded": "42", "extra": true
        })
    );
}

fn default_count() -> u32 {
    7
}

fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

mod string_number {
    use super::*;

    pub fn serialize<S: serde::Serializer>(value: &u32, serializer: S) -> Result<S::Ok, S::Error> {
        value.to_string().serialize(serializer)
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}
