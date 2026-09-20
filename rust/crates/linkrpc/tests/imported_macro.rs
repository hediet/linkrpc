use linkrpc::prelude::*;
use std::sync::{Arc, Mutex};

#[link_rpc_interface(schema_json = r##"{
        "id": "imported.echo", "hash": "preserved-source-hash",
        "description": "The imported description is normative.",
        "methods": {
            "echoValue": {
                "params": { "$ref": "#/components/schemas/Text" },
                "result": { "$ref": "#/components/schemas/Text" },
                "errors": [
                    { "code": 2001, "message": "Finite", "data": { "type": "number" } },
                    { "code": 2002, "message": "Unit" }
                ],
                "x-preserved": { "value": 42 }
            },
            "changed": { "params": { "type": "string" } }
        },
        "components": { "schemas": { "Text": { "type": "string" } } }
    }"##)]
trait ImportedEcho {
    #[name("echoValue")]
    async fn echo_value(#[params] params: String) -> Result<String, CallError<ImportedError>>;

    #[notification]
    async fn changed(#[params] params: String) -> Result<(), JsonRpcError> {
        let _ = ctx;
        if params == "fail" {
            Err(JsonRpcError::new(7000, "notification rejected"))
        } else {
            Ok(())
        }
    }
}

struct Provider;

#[derive(Debug, ApplicationError)]
#[rpc_error(schema = imported_echo::schema, method = "echoValue", display)]
enum ImportedError {
    #[rpc_error(code = 2001, message = "Finite")]
    Finite(f64),
    #[rpc_error(code = 2002, message = "Unit")]
    Unit,
    #[rpc_error(code = 2003, message = "Undeclared")]
    Undeclared,
}

#[async_trait]
impl ImportedEcho for Provider {
    async fn echo_value(
        &self,
        _ctx: &CallCtx,
        params: String,
    ) -> Result<String, CallError<ImportedError>> {
        Ok(params)
    }
}

#[test]
fn imported_error_derive_uses_wire_constraints_not_just_rust_deserialization() {
    assert_eq!(
        ImportedError::Finite(f64::NAN).into_rpc_error().code,
        error_codes::INTERNAL_ERROR
    );
    assert_eq!(
        ImportedError::Undeclared.into_rpc_error().code,
        error_codes::INTERNAL_ERROR
    );
    let unknown = JsonRpcError::new(2003, "Undeclared");
    assert_eq!(
        ImportedError::try_from_rpc_error(unknown.clone()).unwrap_err(),
        unknown
    );
    let unexpected_data = JsonRpcError {
        code: 2002,
        message: "Unit".into(),
        data: Some(JsonValue::Null),
    };
    assert_eq!(
        ImportedError::try_from_rpc_error(unexpected_data.clone()).unwrap_err(),
        unexpected_data
    );
    assert!(matches!(
        ImportedError::try_from_rpc_error(ImportedError::Finite(4.0).into_rpc_error()),
        Ok(ImportedError::Finite(4.0))
    ));
}
#[derive(Clone, Default)]
struct Caller {
    methods: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl RpcCall for Caller {
    async fn call(&self, method: &str, params: JsonValue) -> Result<JsonValue, JsonRpcError> {
        self.methods.lock().unwrap().push(method.to_string());
        Ok(params)
    }

    async fn notify(&self, method: &str, _params: JsonValue) -> Result<(), JsonRpcError> {
        self.methods.lock().unwrap().push(method.to_string());
        Ok(())
    }
}

#[test]
fn imported_schema_and_hash_are_not_rederived_from_rust() {
    let expected: LinkRpcInterfaceSchema =
        serde_json::from_str(imported_echo::SCHEMA_JSON).unwrap();
    let interface = ImportedEchoServer::<Provider>::interface();
    assert_eq!(interface.to_schema(), expected);
    assert_eq!(interface.schema_hash(), "preserved-source-hash");
}

#[tokio::test]
async fn shared_macro_supports_all_generated_client_addressing_modes() {
    let caller = Caller::default();
    let clients = [
        ImportedEchoClient::new(caller.clone()),
        ImportedEchoClient::root(caller.clone()),
        ImportedEchoClient::with_prefix(caller.clone(), "Page."),
        ImportedEchoClient::with_service(caller.clone(), "service"),
    ];
    for client in clients {
        assert_eq!(client.echo_value("hello".into()).await.unwrap(), "hello");
    }
    ImportedEchoClient::root(caller.clone())
        .changed("update".into())
        .await
        .unwrap();
    assert_eq!(
        *caller.methods.lock().unwrap(),
        [
            "imported.echo::echoValue",
            "echoValue",
            "Page.echoValue",
            "service::imported.echo::echoValue",
            "changed",
        ]
    );
}

#[tokio::test]
async fn shared_adapter_uses_wire_names_and_preserves_notification_failures() {
    let server = ImportedEchoServer::new(Arc::new(Provider));
    assert_eq!(
        server
            .handle_request("echoValue", "hello".into(), CallCtx::default())
            .await
            .unwrap(),
        serde_json::json!("hello")
    );
    assert_eq!(
        server
            .handle_request("echo_value", "hello".into(), CallCtx::default())
            .await
            .unwrap_err()
            .code,
        error_codes::METHOD_NOT_FOUND
    );
    assert_eq!(
        server
            .dispatch_notification("changed", 42.into())
            .await
            .unwrap_err()
            .code,
        error_codes::INVALID_PARAMS
    );
    assert_eq!(
        server
            .dispatch_notification("changed", "fail".into())
            .await
            .unwrap_err()
            .code,
        7000
    );
    assert!(server
        .dispatch_notification("changed", "ok".into())
        .await
        .unwrap());
    assert!(!server
        .dispatch_notification("unknown", JsonValue::Null)
        .await
        .unwrap());
}
