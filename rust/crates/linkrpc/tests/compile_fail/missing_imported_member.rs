use linkrpc::prelude::*;

#[link_rpc_interface(schema_json = r#"{
    "id": "missing", "hash": "",
    "methods": { "ping": { "params": true, "result": true } }
}"#)]
trait Missing {}

fn main() {}
