# TODO: Content-addressed context synchronization

## Goal

Define a reusable LinkRPC protocol for synchronizing immutable JSON object
graphs by content hash. The first consumer will be AI conversation context, but
the protocol must not encode chat-specific roles, messages, tools, or provider
metadata.

The intended interaction is Git-like:

1. A caller names one or more root object IDs.
2. The receiver walks every locally available object.
3. The receiver requests missing objects.
4. The caller provides those objects over the same duplex request.
5. Steps 2-4 repeat until the receiver has the complete reachable closure.

## Existing prototype

The personal-bot LLM service currently demonstrates:

- SHA-256 IDs over canonical JSON
- immutable message and ordered-group nodes
- references to previously transferred nodes
- recursive missing-closure discovery
- multi-round `need` / `provide` synchronization
- returning a new history root containing the generated assistant message

The prototype is useful design input, not the final generic wire contract.

## Proposed layers

### Content identity

An object ID must identify:

- hash algorithm
- object codec and codec version
- digest

For example:

```text
sha256:linkrpc-json-v1:BASE64URL_DIGEST
```

Hash canonical JSON with LinkRPC's existing RFC 8785 JCS implementation and
isomorphic SHA-256 implementation.

### Object graph

The generic layer should define:

```ts
interface ContentObject {
    readonly id: ContentId;
    readonly value: JsonValue;
    readonly refs: readonly ContentId[];
}
```

Whether references are stored in a separate field or extracted according to
the codec remains an open design decision. Explicit references make closure
walking codec-independent; embedded references produce more natural documents.

### Duplex synchronization

A streaming request should carry messages equivalent to:

```ts
type ReceiverMessage =
    | { type: "need"; ids: ContentId[] }
    | { type: "complete" };

type SenderMessage =
    | { type: "provide"; objects: ContentObject[] };
```

The final result identifies accepted roots and may report transfer statistics.

## Required limits

Every implementation must bound:

- bytes per object
- objects per `provide`
- total objects and bytes per synchronization
- graph depth
- synchronization rounds
- outstanding requested IDs

Receivers must reject:

- hash mismatches
- unsupported algorithms/codecs
- cycles when the selected codec requires a DAG
- unsolicited objects beyond a small permitted optimization window
- duplicate IDs with different content

## AI context codec

Build the AI-specific layer separately. It may define:

- text/tool/thinking content parts
- message objects
- ordered groups
- tool-call/result relationships
- generated-message and history-root result IDs

Provider configuration, token usage, pricing, profiles, and budgets remain
outside the content-sync protocol.

## Migration

1. Specify content IDs and canonical hashing with conformance vectors.
2. Implement an in-memory store and closure walker in LinkRPC.
3. Add transport-neutral synchronization helpers.
4. Define the AI context codec in the LLM package.
5. Migrate personal-bot's `need` / `provide` protocol.
6. Add persistent storage and eviction only after the protocol is stable.
