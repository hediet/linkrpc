# LinkRPC interoperability

## Typed streaming over real stdio

The Rust `streaming_interop` example defines the contract once with
`#[link_rpc_interface]`. The actual LinkRPC CLI generates the TypeScript binding
from its exported schema; no independently maintained TypeScript schema is used.

From the repository root:

```sh
cd typescript
pnpm install --frozen-lockfile
pnpm turbo build --filter @hediet/linkrpc-cli
cd ..
node interop/generate-streaming.mjs --check
cd typescript
LINKRPC_STREAMING_INTEROP=1 pnpm --filter @hediet/linkrpc test src/connection/streamingInterop.test.ts
```

Omit `--check` to regenerate the fixture after changing the Rust contract.
The opt-in test starts real Rust processes and exercises both client/server
directions, bidirectional typed payloads (including JSON null), both directions
of ping/pong, final payload ordering, structured final errors, advisory
cancellation, disconnect, and exported schema/hash equality.

The ordinary TypeScript suite skips these process tests so it does not require
a Rust toolchain. The package CI runs them explicitly.
