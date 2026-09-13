# `@hediet/linkrpc-infra`

Reusable infrastructure protocols and adapters built on LinkRPC.

## Inspection

The `@hediet/linkrpc-infra/inspection` entry point provides node identity,
topology, and traffic clients, graph merging, and multi-service query/watch
orchestration. `TopologyNetworkClient` can discover topology providers through
the directory; `NetworkInspectionClient` combines explicitly selected sources
and their traffic watches.

The wire contracts and endpoint-side filtering/buffering stay in
`@hediet/linkrpc/inspection`. A `LinkRpcConnection` can still enable inspection
without depending on this package. The low-level channel only exposes raw
inbound/outbound message observation.

Inspection clients previously exported by `@hediet/linkrpc/hub/client` are now
exported here. Inspection contracts and subscription helpers previously in
`@hediet/linkrpc/hub/common` are now in `@hediet/linkrpc/inspection`.

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

The bridge treats JSON-RPC frames as opaque JSON values. Applications remain
responsible for JSON-RPC method semantics, initialization, and authorization.

## Logging

The `@hediet/linkrpc-infra/logging` entry point defines the protocol-only
`linkrpc.logging` interface and its revisioned structured-log schemas.
Implementations remain responsible for storage, retention, and sinks.
