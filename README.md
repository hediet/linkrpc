# LinkRPC

LinkRPC is typed, multiplexed, bidirectional JSON-RPC with optional reflection,
streaming, identity, capabilities, routing, and topology inspection.

This repository keeps the protocol and its implementations independent:

| Directory | Content |
| --- | --- |
| [`spec/`](./spec) | Language-neutral protocol specification |
| [`conformance/`](./conformance) | Shared fixtures, vectors, and behavioral scenarios |
| [`typescript/`](./typescript) | TypeScript implementation and tooling |
| [`rust/`](./rust) | Rust implementation workspace |
| [`interop/`](./interop) | Cross-language interoperability tests |

The TypeScript workspace contains the core runtime, client helpers, Hub, CLI,
and MCP bridge under [`typescript/packages/`](./typescript/packages). The Rust
workspace contains the core, procedural macros, Tokio transports, and examples
under [`rust/crates/`](./rust/crates).

The published Rust `linkrpc` crate also ships the generic
[`linkrpc-codegen` CLI](rust/docs/codegen-cli.md): LinkRPC definitions become
shared Rust types, interface clients/providers, named bindings, and optional
facades. Protocol adapters only produce definitions; Rust generation stays in
LinkRPC.

## Shared approval client

CLI and web adapters share the observable `ApprovalClient` and
`createApprovalClient` from the published `@hediet/linkrpc-infra/approval` entry
point. It also owns reusable manifest aggregation, directory discovery,
permission preparation, and consent types. These APIs are not re-exported by
the Hub or the private `@hediet/linkrpc-client-internal` package. The Node-only
`createTerminalConsentPrompt` adapter remains in `@hediet/linkrpc-hub`;
`ApprovalClient.runInteractive(signal, prompt)` requires an explicit prompt.
See the [approval client guide](typescript/packages/linkrpc-infra/src/approval/README.md)
for root/delegated authority, prepared decisions, and lifecycle guidance.

## Releases

See [package artifacts and releases](docs/releases.md) for stable/next version
reservations, the ArtifactGate contract, and safe rollout requirements.
