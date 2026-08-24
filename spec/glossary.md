# Glossary

A term index. Each entry is one short gloss plus a pointer to its defining section, which is authoritative. This is the only chapter that restates definitions.

| Term | Gloss | Defined |
|---|---|---|
| **Node** | One endpoint of one connection; the unit this spec constrains. | 00 §4 |
| **Connection** | Two nodes over one transport, each the other's environment. | 00 §4 |
| **Caller / Provider** | The two roles relative to a single call; obligations attach to roles, not identities. | 00 §4 |
| **Profile** | A node's advertised conformance level: Core, Signed, or Capability. | conformance §1 |
| **Message** | One JSON-RPC value carried by the transport: request, notification, or response. | 01 §1 |
| **Method** | A printable-ASCII bare name or a structured `::` address identifying an interface member. | 01 §2 |
| **User params** | A call's `params` with all `$linkrpc`-prefixed keys removed. | 01 §3 |
| **Reserved key** | A `$linkrpc`-prefixed `params` key owned by linkrpc (`$linkrpc`, `$linkrpcSignature`, `$linkrpcUnsigned`). | 01 §3 |
| **Transport** | A reliable, ordered, bidirectional, message-preserving channel. | 02 §1 |
| **Initialize handshake** | The first message `linkrpc::initialize` (request + reply) on a connection that authenticates or negotiates transport details. | 02 §2.1 |
| **Endpoint URI** | An RFC 3986 URI naming where a node lives and how to reach/start it. | 02 §5 |
| **Interface** | A named set of typed members described by an interface schema. | 04 §1 |
| **Service** | A concrete provider of interfaces, named by a `/`-delimited service id. | 04 §1 |
| **Root service** | The empty-service-id provider, addressed by the `interface::member` form. | 04 §1 |
| **Interface schema** | The JSON document describing one interface's members and schemas. | 04 §2 |
| **JSON Schema subset** | The decidable JSON Schema dialect interface schemas use. | 04 §3 |
| **Interface hash** | First 8 bytes of SHA-256 over the canonical schema, as 16 hex chars; written `id@hash` in diagnostics only. | 04 §4 |
| **JCS** | RFC 8785 canonical JSON, used for all hashing and signing. | 04 §4 |
| **Reflection** | The built-in `linkrpc.directory` / `.schemas` / `.defaults` interfaces. | 05, 09 §1 |
| **Connection-root directory** | The `linkrpc.directory` selected by an interface-form directory call on one connection. | 09 §2 |
| **Addressed directory** | A `linkrpc.directory` reached in fully-qualified form at a service id. | 09 §2 |
| **Directory referral** | A directory listing whose interface is `linkrpc.directory` and whose service id is the next walk target. | 09 §2 |
| **`$stream`** | The reserved interface carrying in-flight correlated stream messages. | 03 §1 |
| **Control verb** | `cancel` / `ping` / `pong`: runtime-interpreted stream messages. | 03 §4 |
| **PrincipalId** | A role-tagged stable identity name, `"id:" + <keyId>`; the signed-in trust anchor. | 06 §3 |
| **KeyId** | A role-tagged verifying-key name (`key:` inline, `keydoc:` by document); an unsigned hint. | 06 §1 |
| **Signed-object standard** | The one rule fixing the bytes a signature/hash commits to (JCS over a domain-keyed wrapper). | 06 §2 |
| **Signing domain value** | The wrapper key `linkrpc-sig/v1/<domain>`. | 06 §2 |
| **Signing input** | `jcs({ [domainValue(domain)]: obj without the two reserved keys })`. | 06 §2 |
| **SignatureEntry** | A `$linkrpcSignature` value: `{ keyId, sig }`. | 06 §2 |
| **CallMeta** | The `$linkrpc` object: `method`, `nonce`, `signedAtMs`, `principal?`, `interfaceHash?`. | 06 §4 |
| **Capability** | A signed grant from an issuer to an audience listing permitted calls. | 07 §1 |
| **Permission** | One grant clause: a target pattern plus invoke/delegate/param/callBind constraints. | 07 §1.1 |
| **TargetPattern** | The addressable set a permission talks about (service/interface/hash/members). | 07 §1.1 |
| **callBind** | A permission collapsed to one exact call by its content hash. | 07 §1.1 |
| **The gate** | A provider's verify → resolve-chain → permit authorization check. | 07 §4 |
| **Hub** | A routing node brokering calls between participants; routing engine out of scope. | 08 |
