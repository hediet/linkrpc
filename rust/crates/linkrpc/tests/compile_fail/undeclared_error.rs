use linkrpc::prelude::*;

#[derive(Debug)]
struct MissingContract;

#[link_rpc_interface(id = "test.undeclared")]
trait Invalid {
    async fn lookup() -> Result<String, MissingContract>;
}

fn main() {}
