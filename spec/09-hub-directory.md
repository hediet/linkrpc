# 09 — Directory

**Required. Requires chapter 04.** This chapter defines the
`hubrpc.directory` reflection interface and its observable behavior between two
nodes on one connection. It does not specify how a provider constructs its
listing, how an intermediary routes calls, or how several connections are
combined internally.

## 1. Interface definition

`hubrpc.directory` lists the services a provider exposes to its peer through the
current connection. A listing MAY identify another `hubrpc.directory` service,
allowing a consumer to explore the exposed contract transitively.

```
hubrpc.directory::list
  params: {
    interfaceId?:       string, // exact interface-id filter
    interfaceIdPrefix?: string, // interface-id prefix filter
    serviceId?:         string, // exact service-id filter
    serviceIdScopes?:   ServiceIdPattern[], // union filter used by a transitive walk
    cursor?:            string, // opaque continuation token
    limit?:             number, // positive integer; provider MAY return fewer
    timeoutMs?:         number  // non-negative soft gathering-time cap
  }
  result: {
    items:       ServiceListing[],
    nextCursor?: string, // omitted means no more pages
    truncated?:  boolean // true when timeoutMs cut the page short
  }

ServiceListing = {
  serviceId:           string,
  interfaceId:         string,
  interfaceHash:       string,
  serviceDescription?: string,
  rootPrincipalSets?:  RootPrincipalReq[][],
  reachableServiceIds?: ServiceIdPattern[] // directory referrals only
}

RootPrincipalReq = {
  principal:   string,
  transitive?: boolean
}

ServiceIdPattern =
  | { exact:  string }
  | { prefix: string }
```

A provider MUST list, for each `(serviceId, interfaceId)` pair it exposes to this
peer, the `interfaceHash` of the implementation defined by chapter 04.

When a filter is present, every returned item MUST satisfy it.
`serviceIdScopes` is a union: an item satisfies it when its `serviceId` matches at
least one pattern. An empty `serviceIdScopes` matches no items. A provider MAY
return fewer than `limit` items and MUST set `nextCursor` when more matching
items remain. A cursor is opaque to the caller.

For a service-id pattern, `{ exact: s }` matches only `s`. `{ prefix: s }`
matches `s` and every segment-descendant of `s`; the empty prefix matches every
service id. Prefix matching is segment-aware: `foo` matches `foo/bar` but not
`foobar`.

`rootPrincipalSets`, when present, states an access requirement in conjunctive
normal form: the caller must satisfy every inner set (AND), and one inner set is
satisfied by holding any one of its principals (OR). `transitive: true` causes
the requirement to be inherited by every entry discovered through this listing
when it identifies another directory. An omitted or empty
`rootPrincipalSets` means no root-principal requirement.

`serviceDescription` and `rootPrincipalSets` are descriptive metadata. They MUST
NOT grant invocation or routing authority.

`reachableServiceIds` is meaningful only when `interfaceId` is
`hubrpc.directory`; section 3 defines it. A consumer MUST ignore it on every
other listing.

### 1.1 `hubrpc.directory::watch`

`watch` is a long-lived streaming request (chapter 03) that emits an empty tick
whenever the optionally filtered directory might have changed.

```
hubrpc.directory::watch
  params: {
    interfaceId?:       string,
    interfaceIdPrefix?: string,
    serviceId?:         string,
    serviceIdScopes?:   ServiceIdPattern[]
  }
  result:       {}
  serverStream: {}
```

A tick means only that the caller SHOULD invoke `list` again and reconcile the
new snapshot. The provider MUST NOT treat a tick as a delta or an initial
snapshot.

Over-emission is allowed. Under-emission is not: a stable change to the filtered
`list` result MUST eventually produce a tick. Ticks MAY be coalesced. Filters are
relevance hints; a tick MAY be emitted when re-listing produces no matching
change.

The request MUST resolve when the caller cancels it. A static directory MAY open
the stream, emit no ticks, and wait for cancellation.

## 2. Root and addressed views

A **connection-root directory** is the `hubrpc.directory` provider selected by
the interface-form method `hubrpc.directory::list`.

An **addressed directory** is a `hubrpc.directory` provider selected by the
fully-qualified method
`<serviceId>::hubrpc.directory::list`.

The connection-root directory MUST describe the root service and every addressed
directory the provider exposes to this peer as a discovery entry point.

An addressed directory MUST describe the interfaces and further discovery entry
points exposed by that addressed service to this peer.

Every `ServiceListing` asserts that a fully-qualified call for its `serviceId`
is addressable through the directory provider. Addressability does not guarantee
that a particular interface member exists, that authorization succeeds, or that
the service remains available after the listing is produced.

For a transitive walk, that addressability assertion holds from the original
endpoint only for effective listings whose service ids match every accumulated
referral scope.

The same node MAY return different directory views on different connections.

> **Rationale.** Root and addressed calls already have precise meaning in the
> method grammar. No special forwarding prohibition is needed: whichever node
> accepts the call is responsible for the directory response it returns.
>
> The provider may compute that response from local registrations, another
> connection, cached state, policy, or any other source. Those implementation
> choices are unobservable and outside this specification.

## 3. Directory referrals

A **directory referral** is a `ServiceListing` whose `interfaceId` is
`hubrpc.directory`. Its `serviceId` is the target of a possible subsequent
addressed directory call.

Returning a directory referral asserts that the provider exposes that target to
this peer as a discovery entry point. It does not assert that every subsequent
call will be authorized or succeed.

`reachableServiceIds` on a referral is the union of service-id regions the
provider asserts are addressable through the same discovery path as that
referral. It constrains descendants, not the referral target itself.

When `reachableServiceIds` is omitted, it defaults to
`[{ prefix: <referral.serviceId> }]`. An empty array means that the directory may
be enumerated but contributes no transitively reachable descendants.

A consumer MUST derive each next discovery target from a directory referral, not
from a successful call, granted namespace, service-id prefix, or failed call.

The success of a call to an unlisted service does not make the preceding
directory response non-conformant. Absence from a directory means only that the
service is not discoverable through that directory.

> **Rationale.** This is the routing/discovery separation. An intermediary may
> use routing state while constructing a per-peer directory view, but the wire
> contract is only the resulting response. Routing does not create protocol-level
> directory entries.
>
> A scope is not a source route and reveals no internal hop identity. It is only
> a promise about service-id regions. A union is necessary because one referral
> may expose several disjoint regions.

## 4. Walking a directory graph

A directory walk SHOULD begin by listing the connection-root directory with the
initial accumulated scope `[{ prefix: "" }]`, unless the caller explicitly
selects an addressed starting directory and an initial scope.

The walker MUST discard every listing whose `serviceId` does not match its
current accumulated scope.

For every remaining directory referral, the walker MUST intersect its current
accumulated scope with the referral's effective `reachableServiceIds`. If the
intersection is non-empty, the walker SHOULD invoke
`<serviceId>::hubrpc.directory::list` with that intersection as
`serviceIdScopes` and recursively process its result. If the intersection is
empty, it MUST NOT follow the referral.

Scope intersection is pairwise over the two unions:

- equal exact patterns intersect to that exact pattern;
- an exact pattern and a prefix pattern intersect to the exact pattern when the
  exact id matches the prefix, otherwise to nothing;
- two prefix patterns intersect to the more specific prefix when one is equal to
  or nested beneath the other, otherwise to nothing.

Duplicate patterns and patterns contained by a broader pattern SHOULD be removed
after intersection.

A walker MUST track addressed directory targets it has already queried and MUST
NOT send the same target and scope set more than once in one walk. It MUST bound
recursion by a caller-selected or implementation-defined maximum depth. A walker
MAY cache one response per target and re-evaluate it when the target is reached
through another scope.

Failure to enumerate the initial directory MUST fail the walk or yield an empty
result according to the caller's API contract. Failure to enumerate a referred
directory MUST leave reachable sibling branches usable. A detailed walk SHOULD
report the failed target as inaccessible.

When the same `(serviceId, interfaceId, interfaceHash)` tuple is discovered
through several paths, a walker MUST return at most one copy. It SHOULD prefer an
entry reported by the addressed directory whose service id equals the entry's
service id over an indirect copy.

Transitive `rootPrincipalSets` requirements on a referral MUST be inherited by
entries discovered below that referral.

> **Example.**
>
> ```text
> connection root
>   -> de.hediet::hubrpc.directory
>        -> de.hediet/cloud::hubrpc.directory
>             -> de.hediet/cloud/ext/auth::hubrpc.directory
>                  -> auth interface leaves
> ```
>
> Each arrow is justified only by a directory referral in the preceding
> response. At every arrow the walker intersects the accumulated scope with the
> referral scope and passes the result to the next `list` call. Whether one node
> answered all calls or several intermediaries were composed is not observable
> and does not change the walk.

## 5. Watching a directory graph

A graph watcher SHOULD watch the initial directory and every addressed directory
reached during its latest walk.

Each watch is associated with one directory target. After a tick, the graph
watcher SHOULD re-list only that directory with its current accumulated
`serviceIdScopes`.

The watcher SHOULD reconcile that directory's entries and outgoing referrals
against its previous snapshot:

- an added referral starts a walk of only the new branch;
- a removed referral removes only that path's contribution and stops descendant
  watches that have no other reachable parent;
- a changed referral scope recomputes only the affected descendant scopes; and
- unchanged sibling directories are neither re-listed nor re-watched.

When a directory is reachable through several parents, the watcher MUST retain
the union of those paths' accumulated scopes. It MUST remove the directory only
after its final reachable parent path disappears.

Ticks MAY be coalesced, but a stable change to any watched directory's filtered
listing MUST eventually become observable through a subsequent `list`.

If a referred directory becomes inaccessible, the watcher SHOULD retain the
remaining reachable graph and report that branch as inaccessible.

## 6. Security properties

A directory response is scoped to the peer and connection on which it is
returned. A consumer MUST NOT assume that another peer or another connection
receives the same view.

Directory metadata is descriptive and MUST NOT be interpreted as permission to
route or invoke a listed service.

`serviceIdScopes` and `reachableServiceIds` are correctness metadata, not access
control. A provider MUST NOT rely on them to keep service names confidential or
to authorize calls.

The connection-root directory SHOULD be usable as the reflection bootstrap for a
fresh connection. Addressed directory calls MAY require identity or capability
authorization under chapters 06 and 07.

A directory response MUST reflect the visibility applicable to the current peer
and connection.

## 7. Composition

> **Example: direct service.** A service registers an addressed reflection
> surface. Its connection-root directory returns a referral to that addressed
> directory. A peer follows the referral and discovers the service's leaves.

> **Example: intermediary.** An intermediary returns referrals selected from
> information supplied by other connections. To its peer, those referrals are
> ordinary entries in one directory response. The protocol does not expose
> whether they were aggregated, forwarded, cached, or synthesized from local
> registration state.

> **Example: nested intermediaries.** If an intermediary lists another
> intermediary's addressed directory, the same walking algorithm naturally
> intersects both referral scopes before reaching the second intermediary and
> its descendants. No federation-specific directory operation or result
> rewriting is required.

> **Example: routing independence.** A provider may successfully route a
> fully-qualified call while omitting that service from its directory. The
> service remains callable when already known but is not discoverable from that
> directory. Conversely, a listed referral may later fail because authorization,
> availability, or policy changed; the walker reports an inaccessible branch.

> **Example: native nested results.** An addressed directory may natively know
> more services than are reachable through the path by which a walker discovered
> it. The walker sends the accumulated intersection as `serviceIdScopes`, so that
> provider returns only relevant entries. An intermediary need not virtualize or
> rewrite the nested result.

## 8. Conformance scenarios

A Core provider of `hubrpc.directory` MUST satisfy all of the following
observable scenarios:

1. **Root listing.** A peer can invoke root-form `hubrpc.directory::list` and
   receive valid interface hashes for the contract exposed on that connection.
2. **Filters.** Exact interface, interface-prefix, and exact service filters
   exclude every non-matching item. A service-scope union excludes every item
   that matches none of its patterns.
3. **Paging.** A paged response can be continued until `nextCursor` is omitted.
4. **Referral.** When an addressed directory is exposed as a discovery entry
   point, the connection-root listing contains its directory referral.
5. **Watch.** A stable change to a watched filtered listing eventually emits a
   tick and becomes visible after re-listing.

A directory-walker implementation claiming chapter 09 conformance MUST satisfy
all of the following scenarios:

1. **Nested walk.** It follows at least two referral levels to a leaf interface
   without relying on routing metadata.
2. **Cycle.** A referral cycle terminates through target deduplication and the
   configured depth bound.
3. **Inaccessible branch.** Failure of one referred directory does not discard
   reachable sibling branches.
4. **Deduplication.** Duplicate interface tuples are returned once, preferring
   the addressed service's own report.
5. **Transitive requirements.** Transitive `rootPrincipalSets` are inherited by
   every descendant reached through the annotated referral.
6. **Transitive reachability.** At least two referral scopes are intersected,
   the intersection is sent as `serviceIdScopes`, and out-of-scope listings are
   neither returned nor followed.
7. **Disjoint regions.** A referral exposing two disjoint service-id regions
   preserves both regions through union/intersection processing.
8. **Incremental watch.** A tick re-lists only its source directory and walks
   only branches whose referrals or accumulated scopes changed.
