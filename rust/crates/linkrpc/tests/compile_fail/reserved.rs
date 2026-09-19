#[derive(linkrpc::ApplicationError)]
enum Reserved {
    #[rpc_error(code = -32600, message = "Reserved")]
    InvalidRequest,
}

fn main() {}
