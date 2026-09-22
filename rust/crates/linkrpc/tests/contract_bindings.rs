use std::sync::{Arc, Mutex};

use linkrpc::prelude::*;
use linkrpc::schema::codegen::{generate_rust_components, generate_rust_contract};
use serde_json::json;

#[path = "codegen/generated_contract_collisions/mod.rs"]
mod collisions;
#[path = "codegen/generated_contract/mod.rs"]
mod contract;
#[path = "codegen/generated_debugger.rs"]
mod debugger;
#[path = "codegen/contract_fixture.rs"]
mod fixture;
#[path = "codegen/generated_runtime.rs"]
mod runtime;
#[path = "codegen/generated_shared.rs"]
mod shared;
#[path = "codegen/generated_streaming.rs"]
mod streaming;

struct Provider;

#[async_trait]
impl runtime::RuntimeService for Provider {
    async fn evaluate(
        &self,
        _ctx: &CallCtx,
        expression: String,
    ) -> Result<runtime::RuntimeEvaluateResult, JsonRpcError> {
        Ok(runtime::RuntimeEvaluateResult {
            object: shared::RuntimeRemoteObject {
                value: expression,
            },
        })
    }
}

#[async_trait]
impl debugger::DebuggerService for Provider {
    async fn inspect(
        &self,
        _ctx: &CallCtx,
        value: String,
    ) -> Result<shared::RuntimeRemoteObject, JsonRpcError> {
        Ok(shared::RuntimeRemoteObject { value })
    }
}

fn pair() -> (LinkRpcConnection, LinkRpcConnection) {
    let (a, b) = transport_pair();
    let caller = LinkRpcConnection::new(Box::new(a));
    let provider = LinkRpcConnection::new(Box::new(b));
    let c = caller.clone();
    let p = provider.clone();
    tokio::spawn(async move { c.run().await });
    tokio::spawn(async move { p.run().await });
    (caller, provider)
}

#[tokio::test]
async fn all_address_modes_register_call_and_dispose() {
    for (target, prefix, preset, bare_binding) in [
        (runtime::ROOT, "cdp.runtime::", false, false),
        (runtime::SERVICE, "debug::cdp.runtime::", false, false),
        (runtime::EMPTY_SERVICE, "cdp.runtime::", false, false),
        (runtime::DEFAULT, "", true, true),
        (runtime::BARE, "", true, true),
        (runtime::TARGET, "Runtime.", false, true),
    ] {
        let (caller, provider) = pair();
        let registration = target
            .register(
                &provider,
                Arc::new(runtime::RuntimeServer::new(Arc::new(Provider))),
            )
            .unwrap();
        assert_eq!(target.prefix(), prefix);
        assert_eq!(
            target.reference(),
            InterfaceRef::from(&fixture::schemas()[0])
        );
        assert_eq!(target.interface().to_schema(), fixture::schemas()[0]);
        assert_eq!(provider.list_registered().len(), 1);
        if matches!(
            target.address(),
            BindingAddress::Root
                | BindingAddress::Service("")
                | BindingAddress::Default
                | BindingAddress::Bare(_)
        ) {
            caller
                .call_member(
                    Some(""),
                    "cdp.runtime",
                    "evaluate",
                    json!({"expression":"root"}),
                )
                .await
                .unwrap();
        }
        let client = target.client(caller.clone());
        let result = client
            .evaluate("value".into())
            .await
            .unwrap();
        assert_eq!(result.object.value, "value");
        assert_eq!(
            client.unsupported(json!({})).await.unwrap_err().code,
            error_codes::METHOD_NOT_FOUND
        );
        assert!(
            matches!(client.fallible(json!({})).await, Err(CallError::Generic(RpcCallError::Remote(error))) if error.code == error_codes::METHOD_NOT_FOUND)
        );

        provider.enable_reflection();
        let defaults = caller
            .call("hubrpc.defaults::get", json!({}))
            .await
            .unwrap();
        assert_eq!(
            defaults.get("interfaceId").and_then(|v| v.as_str()),
            preset.then_some("cdp.runtime")
        );
        let bindings = caller
            .call("hubrpc.defaults::listBindings", json!({}))
            .await
            .unwrap();
        assert_eq!(
            bindings["bindings"].as_array().unwrap().len(),
            usize::from(bare_binding)
        );
        let directory = caller
            .call(
                "hubrpc.directory::list",
                json!({"interfaceId":"cdp.runtime"}),
            )
            .await
            .unwrap();
        assert_eq!(directory["items"].as_array().unwrap().len(), 1);
        let schema = caller
            .call("hubrpc.schemas::get", json!({"interfaceId":"cdp.runtime"}))
            .await;
        assert!(schema.is_ok());
        assert!(registration.dispose());
        assert!(!registration.dispose());
        assert_eq!(
            client
                .evaluate("x".into())
                .await
                .unwrap_err()
                .code,
            error_codes::METHOD_NOT_FOUND
        );
    }
}

#[tokio::test]
async fn shared_types_retain_identity_across_domain_clients_and_providers() {
    let (caller, provider) = pair();
    runtime::TARGET
        .register(
            &provider,
            Arc::new(runtime::RuntimeServer::new(Arc::new(Provider))),
        )
        .unwrap();
    debugger::TARGET
        .register(
            &provider,
            Arc::new(debugger::DebuggerServer::new(Arc::new(Provider))),
        )
        .unwrap();
    let value = runtime::TARGET
        .client(&caller)
        .evaluate("shared".into())
        .await
        .unwrap();
    // This is a Rust type-identity check: no serialization or conversions between domains.
    let shared::RuntimeRemoteObject { value } = value.object;
    let inspected = debugger::TARGET
        .client(&caller)
        .inspect(value)
        .await
        .unwrap();
    let _: shared::RuntimeRemoteObject = inspected;
    let _ = shared::SharedNode {
        next: Some(Box::new(shared::SharedNode { next: None })),
    };
}

#[derive(Clone, Default)]
struct RecordingCaller(Arc<Mutex<Vec<String>>>);

#[async_trait]
impl RpcCall for RecordingCaller {
    async fn call(&self, method: &str, _params: JsonValue) -> Result<JsonValue, JsonRpcError> {
        self.0.lock().unwrap().push(method.to_string());
        Ok(json!({"object":{"value":"ok"}}))
    }
    async fn notify(&self, method: &str, _params: JsonValue) -> Result<(), JsonRpcError> {
        self.0.lock().unwrap().push(method.to_string());
        Ok(())
    }
}

#[tokio::test]
async fn descriptors_reuse_generic_callers_and_exact_raw_prefixes() {
    let caller = RecordingCaller::default();
    for target in [
        runtime::ROOT,
        runtime::SERVICE,
        runtime::EMPTY_SERVICE,
        runtime::DEFAULT,
        runtime::BARE,
        runtime::TARGET,
    ] {
        target
            .client(&caller)
            .evaluate("".into())
            .await
            .unwrap();
    }
    let raw = InterfaceBinding::<runtime::RuntimeClient>::new(BindingAddress::Bare("raw/"));
    raw.client(caller.clone())
        .evaluate("".into())
        .await
        .unwrap();
    runtime::RuntimeClient::with_service(&caller, "")
        .evaluate("".into())
        .await
        .unwrap();
    assert_eq!(
        *caller.0.lock().unwrap(),
        [
            "cdp.runtime::evaluate",
            "debug::cdp.runtime::evaluate",
            "cdp.runtime::evaluate",
            "evaluate",
            "evaluate",
            "Runtime.evaluate",
            "raw/evaluate",
            "cdp.runtime::evaluate",
        ]
    );
}

#[tokio::test]
async fn bare_bindings_preserve_qualified_registration_and_atomic_prefix_conflicts() {
    let (caller, provider) = pair();
    let server = Arc::new(runtime::RuntimeServer::new(Arc::new(Provider)));
    runtime::TARGET.register(&provider, server.clone()).unwrap();
    let debugger = Arc::new(debugger::DebuggerServer::new(Arc::new(Provider)));
    let conflict =
        InterfaceBinding::<debugger::DebuggerClient>::new(BindingAddress::Bare("Runtime."));
    assert!(matches!(
        conflict.register(&provider, debugger.clone()),
        Err(ConnError::BarePrefixAlreadyBound(_))
    ));
    assert!(matches!(
        runtime::ROOT.register(&provider, server.clone()),
        Err(ConnError::AlreadyRegistered { .. })
    ));
    let second = InterfaceBinding::<debugger::DebuggerClient>::new(BindingAddress::Bare("Other."));
    second.register(&provider, debugger).unwrap();
    assert!(matches!(
        InterfaceBinding::<runtime::RuntimeClient>::new(BindingAddress::Bare("bad::"))
            .register(&provider, server.clone()),
        Err(ConnError::InvalidBarePrefix)
    ));
    assert!(matches!(
        InterfaceBinding::<runtime::RuntimeClient>::new(BindingAddress::Service("bad::"))
            .register(&provider, server),
        Err(ConnError::InvalidServiceId)
    ));
    let result = second
        .client(caller)
        .inspect("second".into())
        .await
        .unwrap();
    assert_eq!(result.value, "second");
    assert_eq!(provider.list_registered().len(), 2);
}

#[test]
fn contract_validates_exact_id_hash_and_address_conflicts() {
    let contract = fixture::contract();
    contract.validate().unwrap();
    let wire = serde_json::to_value(&contract).unwrap();
    assert!(wire.get("interfaceSchemas").is_some());
    assert!(wire.get("bareInterfaces").is_some());
    assert_eq!(
        serde_json::from_value::<LinkRpcContract>(wire).unwrap(),
        contract
    );
    let mut sparse = contract.clone();
    sparse.services = None;
    sparse.default_interface = None;
    sparse.validate().unwrap();
    assert!(serde_json::to_value(&sparse)
        .unwrap()
        .get("services")
        .is_none());
    let bad: &[fn(&mut LinkRpcContract)] = &[
        |c| c.interface_schemas.push(c.interface_schemas[0].clone()),
        |c| c.interface_schemas[0].hash = "incorrect".into(),
        |c| c.default_interface.as_mut().unwrap().hash = "missing".into(),
        |c| c.services.as_mut().unwrap()[0].interfaces[0].hash = "missing".into(),
        |c| c.services.as_mut().unwrap()[1].service_id = "".into(),
        |c| {
            let r = c.services.as_ref().unwrap()[0].interfaces[0].clone();
            c.services.as_mut().unwrap()[0].interfaces.push(r);
        },
        |c| c.bare_interfaces.as_mut().unwrap()[1].prefix = "".into(),
        |c| c.bare_interfaces.as_mut().unwrap()[0].prefix = "bad::".into(),
        |c| c.bare_interfaces.as_mut().unwrap()[0].prefix = "\n".into(),
        |c| {
            let b = c.bare_interfaces.as_ref().unwrap()[0].clone();
            c.bare_interfaces.as_mut().unwrap().push(b);
        },
    ];
    for mutate in bad {
        let mut invalid = contract.clone();
        mutate(&mut invalid);
        assert!(invalid.validate().is_err(), "{invalid:?}");
    }
}

#[test]
fn generated_modules_are_stable_and_share_components() {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/codegen");
    let common = generate_rust_components(&fixture::components(), &Default::default());
    assert!(common.unsupported.is_empty());
    assert_eq!(
        common.code,
        std::fs::read_to_string(dir.join("generated_shared.rs"))
            .unwrap()
            .replace("\r\n", "\n")
    );
    for (schema, domain) in fixture::schemas().iter().zip(["Runtime", "Debugger"]) {
        let mut options = fixture::options(domain);
        options.external_components = common
            .names
            .iter()
            .map(|(name, ty)| (name.clone(), format!("super::shared::{ty}")))
            .collect();
        let source = generate_rust_interface(schema, &options).code;
        assert!(!source.contains("pub struct RuntimeRemoteObject"));
        assert_eq!(
            source,
            std::fs::read_to_string(dir.join(format!("generated_{}.rs", domain.to_lowercase())))
                .unwrap()
                .replace("\r\n", "\n")
        );
    }
    let generated = generate_rust_contract(
        &fixture::contract(),
        &GenerateRustOptions {
            generate_server: true,
            default_server_methods: true,
            ..Default::default()
        },
    )
    .unwrap();
    for (name, source) in generated.files {
        assert_eq!(
            source,
            std::fs::read_to_string(dir.join("generated_contract").join(name))
                .unwrap()
                .replace("\r\n", "\n")
        );
    }
    assert_eq!(contract::cdp_runtime::ROOT.prefix(), "cdp.runtime::");
    assert_eq!(contract::cdp_runtime::DEFAULT.prefix(), "");
    assert_eq!(contract::cdp_runtime::BARE_0.prefix(), "Runtime.");
    assert_eq!(
        contract::cdp_debugger::SERVICE_1.prefix(),
        "debug::cdp.debugger::"
    );
    // Both whole-contract clients likewise expose the same shared Rust type.
    let _: Option<contract::types::RuntimeRemoteObject> = None;
}

#[test]
fn contract_codegen_rejects_conflicting_component_definitions() {
    let mut contract = fixture::contract();
    contract.interface_schemas[1]
        .components
        .as_mut()
        .unwrap()
        .schemas
        .as_mut()
        .unwrap()
        .insert("Runtime.RemoteObject".into(), json!({"type":"string"}));
    contract.interface_schemas[1].hash = compute_interface_hash(&contract.interface_schemas[1]);
    let reference = InterfaceRef::from(&contract.interface_schemas[1]);
    contract.services.as_mut().unwrap()[1].interfaces[1] = reference.clone();
    contract.bare_interfaces.as_mut().unwrap()[1].interface = reference;
    assert!(generate_rust_contract(&contract, &Default::default())
        .unwrap_err()
        .to_string()
        .contains("conflicting shared component"));
}

#[test]
fn schema_validation_checks_shapes_and_dangling_refs() {
    for invalid in [
        json!(17),
        json!({"type":"not-a-type"}),
        json!({"$ref":"#/components/schemas/Missing"}),
    ] {
        let mut schema = fixture::schemas().remove(0);
        schema.methods.get_mut("evaluate").unwrap().params = invalid;
        schema.hash = compute_interface_hash(&schema);
        let contract = LinkRpcContract {
            interface_schemas: vec![schema],
            services: None,
            default_interface: None,
            bare_interfaces: None,
        };
        assert!(contract.validate().is_err(), "{contract:?}");
    }
    let mut schema = fixture::schemas().remove(0);
    schema.methods.clear();
    schema.components = None;
    schema.hash = compute_interface_hash(&schema);
    LinkRpcContract {
        interface_schemas: vec![schema],
        services: None,
        default_interface: None,
        bare_interfaces: None,
    }
    .validate()
    .unwrap();
}

#[test]
fn schema_versions_are_distinct_and_absent_services_create_no_root_binding() {
    let mut first = fixture::schemas().remove(0);
    let mut second = first.clone();
    second.description = Some("another version".into());
    second.hash = compute_interface_hash(&second);
    let first_ref = InterfaceRef::from(&first);
    let second_ref = InterfaceRef::from(&second);
    let mut contract = LinkRpcContract {
        interface_schemas: vec![first.clone(), second],
        services: None,
        default_interface: None,
        bare_interfaces: Some(vec![
            BareInterfaceContract {
                interface: first_ref.clone(),
                prefix: "Old.".into(),
            },
            BareInterfaceContract {
                interface: second_ref.clone(),
                prefix: "New.".into(),
            },
        ]),
    };
    let generated = generate_rust_contract(&contract, &Default::default()).unwrap();
    assert_ne!(
        generated.modules[&first_ref],
        generated.modules[&second_ref]
    );
    assert!(generated
        .files
        .values()
        .all(|code| !code.contains("pub const ROOT:")));
    contract.services = Some(vec![ServiceContract {
        service_id: "".into(),
        interfaces: vec![first_ref],
    }]);
    contract.default_interface = Some(second_ref);
    assert!(contract
        .validate()
        .unwrap_err()
        .to_string()
        .contains("conflicts with root"));

    // JSON Pointer escapes and literal `$ref` data are not schema-reference errors.
    first
        .components
        .as_mut()
        .unwrap()
        .schemas
        .as_mut()
        .unwrap()
        .insert("a/b".into(), json!({"type":"string"}));
    first.methods.get_mut("evaluate").unwrap().params = json!({"$ref":"#/components/schemas/a~1b"});
    first.methods.get_mut("evaluate").unwrap().result = Some(json!({"enum":[{"$ref":"literal"}]}));
    first.hash = compute_interface_hash(&first);
    LinkRpcContract {
        interface_schemas: vec![first],
        services: None,
        default_interface: None,
        bare_interfaces: None,
    }
    .validate()
    .unwrap();
}

#[test]
fn external_unqualified_names_are_reserved_before_local_names() {
    let schema: LinkRpcInterfaceSchema = serde_json::from_value(json!({
        "id":"reserved.names", "hash":"", "methods":{},
        "components":{"schemas":{
            "A":{"type":"object","properties":{"b":{"$ref":"#/components/schemas/B"}},"additionalProperties":false},
            "B":{"type":"string"}
        }}
    })).unwrap();
    let generated = generate_rust_interface(
        &schema,
        &GenerateRustOptions {
            external_components: [("B".into(), "A".into())].into(),
            ..Default::default()
        },
    );
    assert!(generated.code.contains("pub struct A2"));
    assert!(generated.code.contains("Option<A>"));
    assert!(!generated.code.contains("pub type A ="));
}

#[test]
fn heterogeneous_descriptor_catalogue_contains_frozen_schemas_and_exact_prefixes() {
    let catalogue = [runtime::TARGET.descriptor(), debugger::TARGET.descriptor()];
    for (descriptor, schema) in catalogue.iter().zip(fixture::schemas()) {
        assert_eq!(descriptor.schema(), &schema);
        assert_eq!(descriptor.schema().hash, compute_interface_hash(&schema));
        assert!(
            matches!(descriptor.address(), BindingAddress::Bare(prefix) if prefix == descriptor.prefix())
        );
    }

    assert_eq!(catalogue[0].prefix(), "Runtime.");
    assert_eq!(catalogue[1].prefix(), "Debugger.");
    assert!(catalogue[0].schema().methods.contains_key("evaluate"));
    assert!(catalogue[1].schema().methods.contains_key("inspect"));
}

#[test]
fn rust_and_typescript_share_the_exact_static_contract_json_format() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../typescript/packages/linkrpc/src/schema/fixtures/static-contract.json");
    let wire: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let contract: LinkRpcContract = serde_json::from_value(wire.clone()).unwrap();
    contract.validate().unwrap();
    assert_eq!(serde_json::to_value(&contract).unwrap(), wire);
    let reference = InterfaceRef {
        id: "fixture.echo".into(),
        hash: "3f5ed133dd85203a".into(),
    };
    assert_eq!(contract.default_interface.as_ref(), Some(&reference));
    assert_eq!(
        serde_json::to_value(&reference).unwrap(),
        json!({"interfaceId":"fixture.echo","interfaceHash":"3f5ed133dd85203a"})
    );
    assert!(serde_json::from_value::<InterfaceRef>(
        json!({"id":"fixture.echo","hash":"3f5ed133dd85203a"})
    )
    .is_err());
    let generated = generate_rust_contract(&contract, &Default::default()).unwrap();
    let source = &generated.files["fixture_echo.rs"];
    for name in ["ROOT", "DEFAULT", "SERVICE_1", "BARE_0", "BARE_1"] {
        assert!(source.contains(&format!("pub const {name}:")));
    }
    let mut sparse = wire;
    let object = sparse.as_object_mut().unwrap();
    for key in ["services", "defaultInterface", "bareInterfaces"] {
        object.remove(key);
    }
    let contract: LinkRpcContract = serde_json::from_value(sparse.clone()).unwrap();
    contract.validate().unwrap();
    assert_eq!(serde_json::to_value(contract).unwrap(), sparse);
}

#[tokio::test]
async fn foreign_interface_and_member_names_keep_existing_runtime_grammar() {
    let mut schema: LinkRpcInterfaceSchema = serde_json::from_value(json!({
        "id":"foreign/schema", "hash":"",
        "methods":{
            "tools/list":{"params":true,"result":true},
            "Runtime.evaluate":{"params":true,"result":true},
            "textDocument/didOpen":{"params":true}
        }
    }))
    .unwrap();
    schema.hash = compute_interface_hash(&schema);
    let contract = LinkRpcContract {
        interface_schemas: vec![schema.clone()],
        services: Some(vec![ServiceContract {
            service_id: "group/with spaces".into(),
            interfaces: vec![InterfaceRef::from(&schema)],
        }]),
        default_interface: None,
        bare_interfaces: Some(vec![BareInterfaceContract {
            interface: InterfaceRef::from(&schema),
            prefix: "".into(),
        }]),
    };
    contract.validate().unwrap();
    let generated = generate_rust_contract(&contract, &Default::default()).unwrap();
    assert!(generated.files["foreign_schema.rs"].contains("#[name(\"tools/list\")]"));

    struct EchoMethod;
    #[async_trait]
    impl InterfaceHandler for EchoMethod {
        async fn handle_request(
            &self,
            member: &str,
            _params: JsonValue,
            _ctx: CallCtx,
        ) -> Result<JsonValue, JsonRpcError> {
            Ok(json!(member))
        }
    }
    let router = InterfaceRouter::new();
    router
        .register_binding(
            Arc::new(InterfaceDefinition::from_schema(schema)),
            Arc::new(EchoMethod),
            BindingAddress::Bare(""),
        )
        .unwrap();
    for method in [
        "tools/list",
        "Runtime.evaluate",
        "foreign/schema::tools/list",
    ] {
        let result =
            InterfaceHandler::handle_request(&router, method, json!({}), CallCtx::default())
                .await
                .unwrap();
        assert_eq!(
            result,
            json!(method.strip_prefix("foreign/schema::").unwrap_or(method))
        );
    }
    assert!(router
        .dispatch_notification("textDocument/didOpen", json!({}))
        .await
        .unwrap());
}

#[test]
fn contract_codegen_reserves_filenames_before_escaping_module_identifiers() {
    let mut contract = fixture::colliding_module_contract();
    let options = GenerateRustOptions {
        generate_server: true,
        default_server_methods: true,
        ..Default::default()
    };
    let generated = generate_rust_contract(&contract, &options).unwrap();
    assert_eq!(generated.files.len(), contract.interface_schemas.len() + 2);
    assert_eq!(generated.modules.len(), contract.interface_schemas.len());
    assert_eq!(
        generated
            .files
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "mod.rs",
            "mod_2.rs",
            "self_.rs",
            "self_2.rs",
            "type.rs",
            "type_2.rs",
            "type_2_2.rs",
            "types.rs",
            "types_2.rs"
        ]
    );
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/codegen/generated_contract_collisions");
    for (file, source) in &generated.files {
        assert_eq!(
            source,
            &std::fs::read_to_string(dir.join(file))
                .unwrap()
                .replace("\r\n", "\n")
        );
    }
    let compiled = [
        collisions::mod_2::interface(),
        collisions::self_::interface(),
        collisions::self_2::interface(),
        collisions::r#type::interface(),
        collisions::type_2::interface(),
        collisions::type_2_2::interface(),
        collisions::types_2::interface(),
    ];
    let compiled_refs: std::collections::BTreeSet<_> = compiled
        .iter()
        .map(|interface| InterfaceRef::from(&interface.to_schema()))
        .collect();
    let expected_refs: std::collections::BTreeSet<_> = contract
        .interface_schemas
        .iter()
        .map(InterfaceRef::from)
        .collect();
    assert_eq!(compiled_refs, expected_refs);
    contract.interface_schemas.reverse();
    let reversed = generate_rust_contract(&contract, &options).unwrap();
    assert_eq!(generated.files, reversed.files);
    assert_eq!(generated.modules, reversed.modules);
}

#[derive(Default)]
struct Events(Mutex<Vec<String>>);

#[test]
fn bare_clients_reject_streaming_while_default_clients_keep_native_support() {
    type StreamClient = streaming::ComExampleGeneratedStreamingClient;
    let bare = InterfaceBinding::<StreamClient>::new(BindingAddress::Bare(""));
    assert!(matches!(
        bare.try_client(RecordingCaller::default()),
        Err(ConnError::BareStreamingUnsupported)
    ));
    for address in [
        BindingAddress::Default,
        BindingAddress::Root,
        BindingAddress::Service("worker"),
    ] {
        assert!(InterfaceBinding::<StreamClient>::new(address)
            .try_client(RecordingCaller::default())
            .is_ok());
    }
    assert!(runtime::TARGET
        .try_client(RecordingCaller::default())
        .is_ok());
    assert!(matches!(
        InterfaceBinding::<runtime::RuntimeClient>::new(BindingAddress::Bare("bad::"))
            .try_client(RecordingCaller::default()),
        Err(ConnError::InvalidBarePrefix)
    ));
    // Legacy constructors retain their established behavior.
    let _ = streaming::ComExampleGeneratedStreamingClient::root(RecordingCaller::default());
}

#[async_trait]
impl runtime::RuntimeService for Events {
    async fn changed(
        &self,
        _ctx: &CallCtx,
        value: String,
    ) -> Result<(), JsonRpcError> {
        self.0.lock().unwrap().push(value);
        Ok(())
    }
}

#[tokio::test]
async fn standalone_router_retains_typed_notification_validation_for_every_address() {
    for target in [
        runtime::ROOT,
        runtime::SERVICE,
        runtime::EMPTY_SERVICE,
        runtime::DEFAULT,
        runtime::BARE,
        runtime::TARGET,
    ] {
        let router = InterfaceRouter::new();
        let events = Arc::new(Events::default());
        let registration = target
            .register(
                &router,
                Arc::new(runtime::RuntimeServer::new(events.clone())),
            )
            .unwrap();
        let method = format!("{}changed", target.prefix());
        assert!(router
            .dispatch_notification(&method, json!({"value":"event"}))
            .await
            .unwrap());
        assert_eq!(*events.0.lock().unwrap(), ["event"]);
        assert_eq!(
            router
                .dispatch_notification(&method, json!({"value":false}))
                .await
                .unwrap_err()
                .code,
            error_codes::INVALID_PARAMS
        );
        assert!(!router
            .dispatch_notification(&format!("{}missing", target.prefix()), json!({}))
            .await
            .unwrap());
        assert!(!router
            .dispatch_notification(&format!("{}evaluate", target.prefix()), json!({}))
            .await
            .unwrap());
        assert!(!router
            .dispatch_notification("malformed::::changed", json!({}))
            .await
            .unwrap());
        let as_handler: &dyn InterfaceHandler = &router;
        assert!(as_handler
            .dispatch_notification(&method, json!({"value":"dynamic"}), CallCtx::default())
            .await
            .unwrap());
        assert_eq!(*events.0.lock().unwrap(), ["event", "dynamic"]);
        assert_eq!(
            as_handler
                .handle_request(&method, json!({"value":"event"}), CallCtx::default())
                .await
                .unwrap_err()
                .code,
            error_codes::METHOD_NOT_FOUND
        );
        assert!(registration.dispose());
        assert!(!router
            .dispatch_notification(&method, json!({"value":"disposed"}))
            .await
            .unwrap());
    }
}

#[tokio::test]
async fn standalone_router_handles_requests_and_can_drive_an_existing_channel() {
    let router = InterfaceRouter::new();
    runtime::TARGET
        .register(
            &router,
            Arc::new(runtime::RuntimeServer::new(Arc::new(Provider))),
        )
        .unwrap();
    debugger::TARGET
        .register(
            &router,
            Arc::new(debugger::DebuggerServer::new(Arc::new(Provider))),
        )
        .unwrap();
    let as_handler: &dyn InterfaceHandler = &router;
    assert_eq!(
        as_handler
            .handle_request(
                "Runtime.evaluate",
                json!({"expression":"direct"}),
                CallCtx::default()
            )
            .await
            .unwrap(),
        json!({"object":{"value":"direct"}})
    );
    assert_eq!(
        as_handler
            .handle_request(
                "Debugger.inspect",
                json!({"value":"shared"}),
                CallCtx::default()
            )
            .await
            .unwrap(),
        json!({"value":"shared"})
    );
    assert_eq!(
        as_handler
            .handle_request("Missing.inspect", json!({}), CallCtx::default())
            .await
            .unwrap_err()
            .code,
        error_codes::METHOD_NOT_FOUND
    );

    let (a, b) = transport_pair();
    let client_channel = Channel::new(Box::new(a), Box::new(InterfaceRouter::new()));
    let server_channel = Channel::new(Box::new(b), Box::new(router));
    let client_run = client_channel.clone();
    tokio::spawn(async move { client_run.run().await });
    tokio::spawn(async move { server_channel.run().await });
    let result = runtime::TARGET
        .client(client_channel)
        .evaluate("channel".into())
        .await
        .unwrap();
    assert_eq!(result.object.value, "channel");
}

#[tokio::test]
async fn connection_router_shares_registration_and_disposal() {
    let (caller, provider) = pair();
    let router = provider.router();
    let registration = runtime::TARGET
        .register(
            &router,
            Arc::new(runtime::RuntimeServer::new(Arc::new(Provider))),
        )
        .unwrap();
    assert!(matches!(
        runtime::TARGET.register(
            &provider,
            Arc::new(runtime::RuntimeServer::new(Arc::new(Provider)))
        ),
        Err(ConnError::AlreadyRegistered { .. })
    ));
    assert_eq!(
        runtime::TARGET
            .client(&caller)
            .evaluate("shared registry".into())
            .await
            .unwrap()
            .object
            .value,
        "shared registry"
    );
    assert!(registration.dispose());
    assert_eq!(
        runtime::TARGET
            .client(caller)
            .evaluate("".into())
            .await
            .unwrap_err()
            .code,
        error_codes::METHOD_NOT_FOUND
    );
}
