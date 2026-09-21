use linkrpc::prelude::*;
use std::sync::Arc;

#[path = "../codegen/generated_debugger.rs"]
mod debugger;
#[path = "../codegen/generated_runtime.rs"]
mod runtime;
#[path = "../codegen/generated_shared.rs"]
mod shared;

struct Provider;

#[async_trait]
impl debugger::DebuggerService for Provider {}

fn main() {
    let (transport, _) = transport_pair();
    let connection = LinkRpcConnection::new(Box::new(transport));
    runtime::TARGET
        .register(
            &connection,
            Arc::new(debugger::DebuggerServer::new(Arc::new(Provider))),
        )
        .unwrap();
}
