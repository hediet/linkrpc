#[derive(linkrpc::ApplicationError)]
enum EmptyName {
    #[rpc_error(message = "Empty", name = "")]
    Empty,
}

fn main() {}
