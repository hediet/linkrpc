#[derive(linkrpc::ApplicationError)]
enum Cancelled {
    #[rpc_error(code = -32800, message = "Cancelled")]
    Cancelled,
}

fn main() {}
