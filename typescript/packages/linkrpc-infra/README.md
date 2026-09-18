# `@hediet/linkrpc-infra`

Reusable infrastructure protocols and adapters built on LinkRPC.

## JSON documents

The `@hediet/linkrpc-infra/json-document` entry point provides revisioned
document events and atomic `set`, `remove`, `append`, `splice`, and `insert`
operations addressed by RFC 6901 JSON Pointers.

## JSON-RPC

The `@hediet/linkrpc-infra/json-rpc` entry point provides:

- `jsonRpcConnectionInterface`, a transparent duplex JSON-RPC transport
- client and server adapters for the interface
- a message-oriented `JsonRpcTransport` abstraction
- an NDJSON stdio transport
- a generic adapter from parsed JSON-RPC frames to a LinkRPC message transport

The bridge treats JSON-RPC frames as opaque JSON values. Applications remain
responsible for JSON-RPC method semantics, initialization, and authorization.

### CDP/LSP proof of concept (test-only)

The CDP and LSP importers, adapters, and integration harnesses live under
[`test/protocols`](./test/protocols/). They are **not production APIs**, are not
exported by this package, and are not included in published JavaScript,
declarations, or source maps. They exercise the generic library primitives
against real external protocols.

The test helpers `importCdpProtocol(browserProtocol, jsProtocol)` and
`importLspProtocol(metaModel)` return `{ interfaces, bindings, diagnostics,
metadata }`. Interfaces have local member names; bindings separately record the
exact wire method, interface/member, request or notification kind, and message
direction. CDP domains and LSP method prefixes therefore need not become part of
each member's name.

Use `createProtocolInterfaceDefinition(schema)` to construct recursive Zod
validators from an imported interface. Unlike the generic reflection fallback
`interfaceFromSchema`, this validates the imported structural contract.
Non-normative specialization constraints are exported separately through the
core `materializeJsonSchema` helper; they are not automatically enforced by
these structural validators. Review importer diagnostics before treating an
approximation as an exact protocol model.

An endpoint can register several interfaces and bind each to an external prefix
with `connection.bindBare(definition, { prefix })`. Bundle client addressing
once with the core `bareInterfaceTarget` helper:

```ts
const cdpRuntime = bareInterfaceTarget(cdpRuntimeInterface, { prefix: 'Runtime.' });
const runtime = connection.get(cdpRuntime);
```

The immutable target contains the interface, bare-addressing mode, and prefix;
it does not change the interface schema or hash. The existing
`connection.getBare(definition, { prefix })` API remains available. A CDP
Runtime contract uses `Runtime.`, while an LSP text-document contract uses
`textDocument/`. The empty prefix covers lifecycle methods such as `initialize`.
Protocol-specific targets stay in the POC; they are not package exports.
Some LSP methods have nested suffixes, such as `semanticTokens/full`, which
the importer flattens to local names containing `__`. Those methods need
explicit wire-name mapping in addition to a prefix; the live tests cover
prefix-compatible members, not universal LSP name routing.

The longest matching binding wins. Duplicate prefixes are rejected, and an
unknown member in the selected interface never falls through to another
binding. Bindings are reflected by `hubrpc.defaults::listBindings` on the
LinkRPC endpoint; external CDP and LSP peers need not support reflection.
Bare clients do not send LinkRPC hashes, handshake messages, or native stream
controls. External cancellation and progress use the external protocol's own
notifications.

### POC transports and live verification

`createLspChildProcessTransport(child)` adapts the child's stdout/stdin using
LSP framing; the caller still owns process startup, protocol initialization,
shutdown, and termination. `createCdpWebSocketTransport(openSocket)` exposes
`.root` and `.session(sessionId)` transports, remaps outgoing request IDs to
isolate sessions, and translates CDP envelopes without adding a LinkRPC
handshake. Closing one session does not terminate other sessions.

The pinned CDP and LSP schema corpora, provenance, and licenses live under
[`conformance/protocols`](../../../conformance/protocols/). Deterministic tests
read these local snapshots rather than downloading schemas. Update the pins
explicitly when updating a protocol version.

Run the live integration tests from the TypeScript workspace:

```sh
pnpm --filter @hediet/linkrpc-infra test:interop
```

These tests execute the generated TypeScript interfaces and their validators against
an unmodified Node inspector and the pinned `vscode-json-languageserver`.
They exercise evaluation and CDP events, LSP initialization, document symbols,
diagnostics, and graceful shutdown. The tests spawn only local processes and
clean them up; schema or server downloads are not performed during the tests.
CI runs these tests through `pnpm check`. Core and infra tests are uncached:
their conformance fixtures live outside the TypeScript workspace's cache root,
and live interoperability must run even when package builds are cached.

### Generated client/server cross-language checks

```sh
pnpm --filter @hediet/linkrpc-infra test:generated-interop
```

This requires a Rust toolchain in addition to Node. It regenerates all CDP/LSP
interfaces from the pinned source documents, compiles all 74 TypeScript
interfaces and Rust clients/provider traits/server adapters, and runs both
TypeScript-client/Rust-server and Rust-client/TypeScript-server combinations.
Rust generation uses `GenerateRustOptions { generate_server: true,
..Default::default() }`, producing a typed `Service` trait and `Server` adapter
alongside the client. The adapters retain the imported schema and hash rather
than reconstructing them through the Rust trait macro.
The cross-language cases use selected real CDP DOM and LSP text-document
methods, including recursive results, notifications, application errors, and
schema-hash reflection. They are not substitutes for implementing every
protocol method.

The Rust peer and its Cargo crate live under `test/protocols/rust`; generated
Rust and build artifacts stay under the repository's `rust/target` directory.
Code-generation approximation diagnostics are reported and snapshot-tested so
new fallbacks require explicit review. Some LSP numeric enums and standalone
constants still lower to `serde_json::Value`; successful compilation does not
imply that every source constraint has an exact native Rust type. The
cross-language transport is native JSON-RPC NDJSON over child-process stdio,
with `DOM.` and `textDocument/` bindings, not CDP WebSocket or LSP
Content-Length framing. The separate external-server smoke tests cover those
external transports from TypeScript.

## Logging

The `@hediet/linkrpc-infra/logging` entry point defines the protocol-only
`linkrpc.logging` interface and its revisioned structured-log schemas.
Implementations remain responsible for storage, retention, and sinks.
