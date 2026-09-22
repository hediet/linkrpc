use linkrpc::schema::{
    codegen::{GenerateRustBinding, GenerateRustOptions},
    compute_interface_hash, BareInterfaceContract, Components, InterfaceAddress, InterfaceRef,
    LinkRpcContract, LinkRpcInterfaceSchema, ServiceContract,
};
use serde_json::json;

pub fn components() -> Components {
    serde_json::from_value(json!({ "schemas": {
        "Runtime.RemoteObject": {
            "type": "object",
            "properties": { "value": { "type": "string" } },
            "required": ["value"],
            "additionalProperties": false
        },
        "Shared.Node": {
            "type": "object",
            "properties": { "next": { "$ref": "#/components/schemas/Shared.Node" } },
            "additionalProperties": false
        }
    }}))
    .unwrap()
}

pub fn schemas() -> Vec<LinkRpcInterfaceSchema> {
    [
        json!({
            "id": "cdp.runtime", "hash": "",
            "methods": {
                "changed": {
                    "params": { "$ref": "#/components/schemas/Runtime.RemoteObject" },
                    "x-linkrpc-codegen": { "kind": "serverNotification" }
                },
                "evaluate": {
                    "params": {
                        "type": "object",
                        "properties": { "expression": { "type": "string" } },
                        "required": ["expression"], "additionalProperties": false
                    },
                    "result": {
                        "type": "object",
                        "properties": { "object": { "$ref": "#/components/schemas/Runtime.RemoteObject" } },
                        "required": ["object"], "additionalProperties": false
                    }
                },
                "unsupported": { "params": true, "result": true },
                "fallible": {
                    "params": true, "result": true,
                    "errors": [{ "code": 41, "message": "failed" }]
                }
            }
        }),
        json!({
            "id": "cdp.debugger", "hash": "",
            "methods": {
                "inspect": {
                    "params": { "$ref": "#/components/schemas/Runtime.RemoteObject" },
                    "result": { "$ref": "#/components/schemas/Runtime.RemoteObject" }
                }
            }
        }),
    ].into_iter().map(|value| {
        let mut schema: LinkRpcInterfaceSchema = serde_json::from_value(value).unwrap();
        schema.components = Some(components());
        schema.hash = compute_interface_hash(&schema);
        schema
    }).collect()
}

pub fn options(domain: &str) -> GenerateRustOptions {
    GenerateRustOptions {
        client_name: Some(format!("{domain}Client")),
        generate_server: true,
        default_server_methods: true,
        method_type_prefix: Some(domain.to_string()),
        bindings: vec![
            GenerateRustBinding {
                name: "TARGET".into(),
                address: InterfaceAddress::Bare(format!("{domain}.")),
            },
            GenerateRustBinding {
                name: "ROOT".into(),
                address: InterfaceAddress::Root,
            },
            GenerateRustBinding {
                name: "SERVICE".into(),
                address: InterfaceAddress::Service("debug".into()),
            },
            GenerateRustBinding {
                name: "EMPTY_SERVICE".into(),
                address: InterfaceAddress::Service("".into()),
            },
            GenerateRustBinding {
                name: "DEFAULT".into(),
                address: InterfaceAddress::Default,
            },
            GenerateRustBinding {
                name: "BARE".into(),
                address: InterfaceAddress::Bare("".into()),
            },
        ],
        ..Default::default()
    }
}

pub fn contract() -> LinkRpcContract {
    let schemas = schemas();
    let runtime = InterfaceRef::from(&schemas[0]);
    let debugger = InterfaceRef::from(&schemas[1]);
    LinkRpcContract {
        interface_schemas: schemas,
        services: Some(vec![
            ServiceContract {
                service_id: "".into(),
                interfaces: vec![runtime.clone()],
            },
            ServiceContract {
                service_id: "debug".into(),
                interfaces: vec![runtime.clone(), debugger.clone()],
            },
        ]),
        default_interface: Some(runtime.clone()),
        bare_interfaces: Some(vec![
            BareInterfaceContract {
                interface: runtime,
                prefix: "Runtime.".into(),
            },
            BareInterfaceContract {
                interface: debugger,
                prefix: "Debugger.".into(),
            },
        ]),
    }
}

pub fn colliding_module_contract() -> LinkRpcContract {
    let interface_schemas = [
        ("mod", "index collision"),
        ("types", "common types collision"),
        ("type", "first version"),
        ("type", "second version"),
        ("type_2", "escaped suffix collision"),
        ("self", "non-raw keyword"),
        ("self_", "non-raw keyword suffix collision"),
    ]
    .into_iter()
    .map(|(id, description)| {
        let mut schema: LinkRpcInterfaceSchema = serde_json::from_value(json!({
            "id":id, "hash":"", "description":description,
            "methods":{"echo":{"params":{"type":"string"},"result":{"type":"string"}}}
        }))
        .unwrap();
        schema.hash = compute_interface_hash(&schema);
        schema
    })
    .collect();
    LinkRpcContract {
        interface_schemas,
        services: None,
        default_interface: None,
        bare_interfaces: None,
    }
}
