//! Cross-runtime fixture for `typescript/packages/linkrpc/src/node/endpointInterop.test.ts`.
//!
//! - `endpoint_interop <all|root|granted>` hosts the calculator with `host_participant` on the
//!   endpoint in `LINKRPC_ENDPOINT` (`stdio`, a dial address, or `listen:…`) using that
//!   registration mode. Listeners print their bound endpoint as the first stdout line.
//! - `endpoint_interop call <endpoint>` connects with `connect_to_hub` (for example to a `cmd:`
//!   child), calls `endpoint.echo::ping("rust")`, and prints the JSON result.

use std::io::Write;
use std::sync::Arc;

use async_trait::async_trait;
use linkrpc::prelude::*;
use linkrpc_examples::calc::{Calculator, CalculatorServer, DivResult};
use linkrpc_tokio::{
    connect_to_hub, host_participant, BoxError, ConnectOptions, ParticipantOptions,
    RegistrationMode,
};

struct CalcService;

#[async_trait]
impl Calculator for CalcService {
    async fn add(&self, _ctx: &CallCtx, a: i64, b: i64) -> Result<i64, JsonRpcError> {
        Ok(a + b)
    }

    async fn divide(&self, _ctx: &CallCtx, a: i64, b: i64) -> Result<DivResult, JsonRpcError> {
        if b == 0 {
            return Err(JsonRpcError::new(
                error_codes::INVALID_PARAMS,
                "division by zero",
            ));
        }
        Ok(DivResult {
            quotient: a / b,
            remainder: a % b,
        })
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [mode, endpoint] if mode == "call" => call(endpoint).await,
        [mode] => {
            serve(match mode.as_str() {
                "all" => RegistrationMode::All,
                "root" => RegistrationMode::Root,
                "granted" => RegistrationMode::GrantedServiceId,
                other => panic!("unknown registration mode {other}"),
            })
            .await
        }
        _ => panic!("usage: endpoint_interop <all|root|granted> | call <endpoint>"),
    }
}

async fn serve(mode: RegistrationMode) {
    let host = host_participant(ParticipantOptions::new(mode), |context| async move {
        let registration = context.services.register_service(
            Arc::new(CalculatorServer::new(Arc::new(CalcService))),
            RegisterOptions::default(),
        )?;
        Ok::<_, BoxError>(registration)
    })
    .await
    .unwrap_or_else(|error| {
        eprintln!("endpoint_interop: {error}");
        std::process::exit(1);
    });
    if host.endpoint() != "stdio:" {
        let mut stdout = std::io::stdout();
        writeln!(stdout, "{}", host.endpoint()).expect("print endpoint");
        stdout.flush().expect("flush endpoint");
    }
    host.closed().await;
}

async fn call(endpoint: &str) {
    let connection = connect_to_hub(ConnectOptions {
        endpoint: Some(endpoint.to_owned()),
        ..Default::default()
    })
    .await
    .unwrap_or_else(|error| {
        eprintln!("endpoint_interop: {error}");
        std::process::exit(1);
    });
    let driver = connection.clone();
    tokio::spawn(async move { driver.run().await });
    let result = connection
        .call_member(None, "endpoint.echo", "ping", serde_json::json!("rust"))
        .await
        .expect("ping the cmd child");
    println!("{result}");
}
