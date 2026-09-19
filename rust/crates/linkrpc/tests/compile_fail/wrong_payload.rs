use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, JsonSchema)]
struct MissingData {
    resource: String,
}

#[derive(linkrpc::ApplicationError)]
enum FixtureError {
    #[rpc_error(code = 1001, message = "Missing")]
    Missing(MissingData),
}

fn main() {
    let _ = FixtureError::Missing("not a MissingData".to_string());
}
