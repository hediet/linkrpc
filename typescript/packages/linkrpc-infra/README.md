# `@hediet/linkrpc-infra`

Reusable infrastructure protocols and adapters built on LinkRPC.

## JSON-RPC

The `@hediet/linkrpc-infra/json-rpc` entry point provides:

- `jsonRpcConnectionInterface`, a transparent duplex JSON-RPC transport
- client and server adapters for the interface
- a message-oriented `JsonRpcTransport` abstraction
- an NDJSON stdio transport

The bridge treats JSON-RPC frames as opaque JSON values. Applications remain
responsible for JSON-RPC method semantics, initialization, and authorization.
