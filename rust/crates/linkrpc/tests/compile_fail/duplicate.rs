#[derive(linkrpc::ApplicationError)]
enum Duplicate {
    #[rpc_error(code = 1001, message = "First")]
    First,
    #[rpc_error(code = 1001, message = "Second")]
    Second,
}

fn main() {}
