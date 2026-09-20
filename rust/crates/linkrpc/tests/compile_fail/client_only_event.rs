use linkrpc::prelude::*;

#[link_rpc_interface(
    schema_json = r#"{
        "id": "events", "hash": "",
        "methods": { "changed": {
            "params": { "type": "string" },
            "x-linkrpc-codegen": { "kind": "serverNotification" }
        } }
    }"#,
    generate_server = false
)]
trait ServerOnly {
    #[server_notification]
    async fn changed(#[params] params: String) -> Result<(), JsonRpcError>;
}

fn invalid(client: ServerOnlyClient) {
    let _ = client.changed("must not be sent".into());
}

fn main() {}
