# linkrpc Rust examples

The `#[link_rpc_interface]` macro turns a bare async trait into a server trait, server adapter,
typed client, and interface schema. Streaming directions are named from the caller's perspective:

| Attribute | Wire direction | Provider argument | Client handle |
|---|---|---|---|
| `#[input_stream(T)]` | caller → provider | `StreamReceiver<T>` | `StreamSender<T>` |
| `#[output_stream(T)]` | provider → caller | `StreamSender<T>` | `StreamReceiver<T>` |

For a duplex method, provider stream arguments are injected after ordinary parameters, receiver
first and sender second.

```rust
use linkrpc::prelude::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, JsonSchema)]
enum KitchenCommand {
    Add { quantity: u32 },
    Finish,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct KitchenEvent { completed: u32 }

#[link_rpc_interface(id = "com.acme.kitchen")]
trait Kitchen {
    #[input_stream(KitchenCommand)]
    #[output_stream(KitchenEvent)]
    async fn prepare(order_id: String) -> Result<u32, JsonRpcError>;
}

struct KitchenService;

#[async_trait]
impl Kitchen for KitchenService {
    async fn prepare(
        &self,
        ctx: &CallCtx,
        _order_id: String,
        mut commands: StreamReceiver<KitchenCommand>,
        events: StreamSender<KitchenEvent>,
    ) -> Result<u32, JsonRpcError> {
        let mut completed = 0;
        loop {
            let command = tokio::select! {
                reason = ctx.cancelled() => {
                    return Err(JsonRpcError::new(
                        error_codes::CANCELLED,
                        reason.unwrap_or_else(|| "cancelled".into()),
                    ));
                }
                command = commands.recv() => command,
            };
            let Some(command) = command else {
                return Err(JsonRpcError::new(error_codes::PEER_DISCONNECTED, "input ended"));
            };
            match command {
                KitchenCommand::Add { quantity } => {
                    completed += quantity;
                    events.send(KitchenEvent { completed }).await?;
                }
                KitchenCommand::Finish => return Ok(completed),
            }
        }
    }
}
```

The client method returns once the request has been sent. Split the call into its independently
usable result, streams, and control handle:

```rust
let call = KitchenClient::new(connection)
    .prepare("order-42".into())
    .await?;
let (result, commands, mut events, control) = call.into_parts();

commands.send(KitchenCommand::Add { quantity: 2 }).await?;
commands.send(KitchenCommand::Finish).await?;
while let Some(event) = events.recv().await {
    println!("completed: {}", event.completed);
}
let completed = result.await?;
```

Streams have no application-visible half-close or wire EOF. Do not wait for dropping a sender to
signal completion. Model completion explicitly in the payload protocol (such as the `Finish`
command above), then return the method result. `CallControl` provides call cancellation and ping;
`ctx.cancelled().await` lets a provider await cancellation and obtain its optional reason.

## Lifecycle and validation

- Cancellation is advisory: `control.cancel(Some(reason)).await?` notifies the provider, while
  the final result remains independently awaitable.
- `control.dispose(None)` stops local tracking without cancelling remote work. Dropping the
  last call handle has the same local-only effect. Keep the result or another split handle
  alive while the call is needed; dropping one sender does not half-close a stream.
- Settlement closes incoming delivery, but queued messages remain drainable before `recv()`
  returns `None`. The result future still reports the final value or JSON-RPC error.
- Payloads that fail the declared stream schema are dropped, matching TypeScript. A full
  buffer of 256 accepted, unread payloads fails the call explicitly instead of growing without
  bound or blocking unrelated requests. Before a schema is installed, raw arrivals share that
  bound.
- Streaming calls emit a keepalive ping every ten minutes while `Channel::run` is driven.
  Settlement, disposal, and disconnect clean up tracking and pending ping waiters.

Schema-imported Rust bindings use the same handle types and preserve the source interface
schema, including recursive component references. See the [cross-language tests](../../interop)
for Rust-trait export through the actual TypeScript CLI and real stdio exchange.

For non-streaming examples, the shared [calculator contract](../crates/linkrpc-examples/src/calc.rs)
is consumed by the [stdio server](../crates/linkrpc-examples/examples/calc_server.rs) and
[client](../crates/linkrpc-examples/examples/calc_client.rs).
