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

## Releases

See [package artifacts and releases](docs/releases.md) for stable/next version
reservations, the ArtifactGate contract, and safe rollout requirements.
