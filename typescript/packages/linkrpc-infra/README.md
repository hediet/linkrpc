# `@hediet/linkrpc-infra`

Reusable infrastructure protocols and adapters built on LinkRPC.

## Immutable graphs (experimental)

`@hediet/linkrpc-infra/graph` provides a generic, JSON-valued immutable graph
protocol and reference runtime. It is an **experimental infrastructure API**,
not a core LinkRPC module or an application data model. The stable protocol IDs
are `linkrpc.graph.objects.v1`, `linkrpc.graph.root.v1`, and
`linkrpc.graph.live.v1`.

```ts
import { defineInterface } from '@hediet/linkrpc';
import { GraphObjects, GraphRoot, graphRefSchema } from '@hediet/linkrpc-infra/graph';
import { z } from 'zod';

const graph = defineInterface({ id: 'example.graph' }, {
    objects: GraphObjects({ ref: graphRefSchema, value: z.json() }),
    root: GraphRoot({ params: z.object({ filter: z.string() }), ref: graphRefSchema }),
});
```

These callable templates retain the supplied Zod schema types. Register nested
handlers (`{ objects: { batchObjGet }, root: { watch } }`) and use nested clients
(`connection.get(graph).objects.batchObjGet(...)` and `.root.watch(...)`).
`mapMembers` can override wire member names without changing the nested API.
`validateGraphInterfaceSchema` checks reflected template contracts and enforces
at most one object store per containing interface, with every root using the
same reference schema as that store. Core template authoring remains generic.
Root templates contribute the first-class `linkrpc.graph` interface tag,
deduplicated across roots and advertised by directory reflection. View discovery
can match that tag without fetching schemas; opening a view still validates the
actual graph contract. Tags are optional hints and do not affect contract hashes.

`@hediet/linkrpc-infra/graph/source` adds observable, Node.js graph sources:
`LocalGraphSource` interns immutable values in a unique namespace,
`LazyGraphSource` materializes deferred objects only when fetched, and
`GraphComposition` references independent source graphs without re-projecting
their data. Compositions retain current roots and explicitly leased historical
roots, not every published revision. Local sources collect values unreachable
from their current root and outstanding closure leases after root publication
or lease release. Historical references must be leased before replacing their
root; a bare reference is not ownership. Interning metadata is collected with
values and monotonic IDs are never reassigned. `dispose()` releases a source's
current root; explicit leases still protect their objects until released.
Compositions do not dispose independently owned source adapters.
`registerGraphSource(connection, source, { serviceId })` exposes the
`linkrpc.graph.v1` interface with `objects` and `workspace` template groups;
omitting `serviceId` registers at the root. It also exposes
`linkrpc.graph.retained.v1`, with the same object store and a `root` watch
parameterized by an immutable reference. These independent leases protect
acquired objects and their closures when the workspace acknowledgement advances.
Both contracts, the client, and registration are exported from the browser-safe
`@hediet/linkrpc-infra/graph` entry. The source entry reexports the same canonical
`graphInterface` and registration for compatibility. Registration accepts a
source or an asynchronous source provider, so server initialization can be lazy.
Dispose both the registration and the owned composition when its server stops.

### Demand-driven shared client

```ts
import { GraphClient, registerGraphSource } from '@hediet/linkrpc-infra/graph';

const registration = registerGraphSource(serverConnection, source);
const client = new GraphClient(browserConnection);
// client.root is IObservable<LoadState<GraphRef>>.
// Acquire only an object needed by a currently rendered view:
const handle = client.acquire(ref);
// handle.state is IObservable<LoadState<JsonValue>>.
// Mount/unmount controls the lifetime; nested references are not prefetched.
handle.dispose();
client.dispose();
registration.dispose();
```

`GraphClient` owns exact-object (`paths: ['/']`) bounded batches, pending-reader
deduplication, immutable caching, partial-batch continuation, explicit retries,
root acknowledgements, and acquired-reference retention watches. It never
fetches a closure or traverses references found in an object. Consumers control
expansion and viewport demand through `acquire(ref)`/`dispose()`. Structural
ancestors can stay acquired while their children are displayed.

The `GraphReader` interface exposes `root`, `acquire`, and `retry(ref)`.
`LoadState<T>` is `{kind:'loading'}`, `{kind:'ready',value:T}`, or
`{kind:'error',message:string}`. Root retry and `setConnection(newConnection)`
preserve ready root and object values, including the stable per-reference
observable identity. A repeated offer of the same immutable root does not
invalidate the root observable. Transport/lease failures remain visible through
`rootError` and handle `error` observables without replacing cached ready values;
`refreshing` distinguishes pending root/lease refresh. Initial failures still
appear directly in `LoadState`. `reportConnectionError(error)` lets a transport
adapter report connection setup failures. There is no automatic reconnect or
retry loop: the owner supplies the next connection or calls `retryRoot()` /
`retry(ref)`. Connections remain caller-owned.

Client options include `serviceId`, `maxBatchObjects` (32), `maxBatchBytes`
(1 MiB), `maxCachedObjects` (256), and `maxCachedBytes` (16 MiB). Cache limits
evict least-recently-used unacquired entries; actively acquired entries and
bounded in-flight batches are exempt until released. An evicted object is
requested again only if acquired again. Missing, forbidden, expired,
oversized, failed, or non-progressing responses produce explicit errors rather
than retry storms. The client requires both canonical graph registrations;
it does not silently fall back to unretained reads on older servers.

`ImmutableGraphRuntime` traverses an `ImmutableGraphSource` deterministically,
ancestor-first, deduplicating shared references and cycles. Selectors use JSON
Pointer escaping (`~0`, `~1`), `/` for the object itself, `*` for JSON children,
`@` to dereference, and terminal `**` for transitive closure. For example,
`/children/0/@/**` fetches the root and the selected child's closure, not its
siblings. Empty `paths` means `/`.

`batchObjGet` is a normal request/response operation. Positive safe-integer
`maxObjects` and `maxBytes` bound returned object rows; bytes are the sum of each
`{ref,value}` row's UTF-8 JSON encoding, excluding envelope and missing reports.
These are output budgets, not limits on lookup/retention work. Budget exhaustion
returns `complete: false`; repeat the request with received rows in
`have: [{ref, coverage: 'object'}]` to progress. `coverage: 'closure'` suppresses a
closure only after the source validates it is complete. Lookups are cached within
one batch, not across requests. Missing, expired, forbidden, and individually
oversized rows are explicit terminal reports; `complete: true` means traversal
finished, not that every object was available. An unavailable/oversized object
stops traversal through that object.

`InMemoryImmutableGraphStore` clones/freezes JSON values, rejects replacement of
immutable identities even after expiry, and provides idempotent closure leases.
Leases share a ref-counted root entry instead of allocating a transitive set for
every lease. Their reachability is evaluated against currently materialized
objects, so children loaded after acquiring a lease are also protected.
`collectGarbage(currentRoots)` reclaims unowned values but preserves identity
tombstones. Owners that guarantee IDs are never reused may pass `true` as its
second argument to collect tombstones too; `LocalGraphSource` does so.
`diagnostics` reports object/identity/retained-root counts for store tests and
operational inspection; local sources and compositions expose corresponding
interning/routing/lease counts.

Producer caches must not publish an old, unleased reference after reclamation:
either own a lease while caching it, or regenerate the object/reference on reuse.
This applies to application caches outside the graph, including deferred-content
reference caches. Garbage collection does not itself dispose producer-specific
loader closures or caches.
The standard `{kind,id}` reference uses collision-free keys; applications must
namespace IDs across stores. Custom reference schemas use explicit `refKey` and
`isRef` callbacks. References must be unambiguous within JSON values.

`RootWatchCoordinator` publishes versioned root offers and retains each watcher's
accepted root plus one outstanding offer. `{accept: version}` releases the prior
accepted lease; later publications coalesce until that acknowledgement. Stale
acknowledgements are ignored. `watch.cancel()` (or transport closure) releases
watcher leases, including leases acquired after cancellation, without requiring
an acknowledgement. The publisher owns the availability of current/pending roots
outside those leases. The coordinator remembers current roots per `paramsKey`;
use a coordinator scoped to the owning service/resource lifetime. A source must
keep its immutable values and closure-retention contract consistent.

`defineLiveResourceWatchInterface` separately describes mutable live-resource
events; they are not immutable graph objects or part of closure synchronization.

Build core and infra before running `pnpm --filter @hediet/linkrpc-infra test:graph`.
The graph suite exercises source-condition exports, emitted generic declarations,
published JavaScript exports, and real paired LinkRPC connections with grouped
registration, nested clients, bounded requests, acknowledgements and cancellation.

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
- a generic adapter from parsed JSON-RPC frames to a LinkRPC message transport
- `jsonRpcConnectionFactoryInterface` (also exported as
  `jsonRpcManagedConnectionInterface`) and `registerJsonRpcConnectionFactory`
  for persistent/ephemeral connections, idle/TTL expiry, reverse requests,
  event polling, and optional initialization
- `createJsonRpcBridgeInterface` to expose typed LinkRPC application methods
  over JSON-RPC (including optional acknowledged notifications)

The original `jsonRpcConnectionInterface` retains its raw-only wire contract;
the managed interface has a separate ID so existing clients remain compatible.
The factory also registers the raw interface on the same service. Pass
`{ source, bridge }` in `profile.interfaces` to use an acknowledged-notification
bridge, or pass the source interface directly for ordinary methods. A method
without `jsonRpcConnectionId` opens an ephemeral connection. Applications remain
responsible for JSON-RPC method semantics and authorization.

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

Bundle an interface with its external prefix using the core
`bareInterfaceTarget` helper. The same target supplies incoming routing at
registration time and outgoing client addressing:

```ts
const cdpRuntime = bareInterfaceTarget(cdpRuntimeInterface, { prefix: 'Runtime.' });
const registration = connection.register(cdpRuntime, handlers);
const runtime = connection.get(cdpRuntime);
```

Registration installs the implementation and its bare route together;
`registration.dispose()` removes both. Native interface-qualified addressing
remains available. To mount the implementation under a named service, pass
`{ serviceId: 'browser-1' }` as the third registration argument, or use
`connection.service('browser-1').register(cdpRuntime, handlers)`. Prefixes
remain unique across the whole connection, not per service.

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
