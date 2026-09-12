# 01 — Messages

This chapter defines the linkrpc message envelope: a specialization of [JSON-RPC 2.0](https://www.jsonrpc.org/specification). It adds the `::` method-addressing grammar, the reserved `$hubrpc`-prefixed `params` namespace that carries every optional layer, the set of error codes, and the request/response correlation rule. It defines the *names* of the reserved members and the rule for stripping them before canonicalization; each member's *meaning* is defined in the chapter that owns its layer.

## 1. Relationship to JSON-RPC 2.0

linkrpc **is** JSON-RPC 2.0: every linkrpc message is a well-formed JSON-RPC 2.0 message ([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) JSON text, `"jsonrpc": "2.0"`), and everything JSON-RPC 2.0 specifies — the `jsonrpc` tag, the four message kinds, the `id` matching rule, the base error object — applies unchanged and is not restated here. linkrpc is a **specialization**: it narrows JSON-RPC's open choices rather than altering them.

linkrpc differs from plain JSON-RPC 2.0 in exactly the following ways, and in no others:

**Extensions** (linkrpc gives meaning to things JSON-RPC leaves open):

1. A `method` may be a flexible bare name or a structured `::` address (§2).
2. The `params` object gains a reserved `$hubrpc`-prefixed namespace carrying every optional layer's metadata (§3). User params are `params` minus those keys.
3. Additional error codes are defined in the JSON-RPC reserved range (§4).

**Constraints** (linkrpc narrows what JSON-RPC permits):

1. `method` MUST conform to the §2 grammar.
2. Every request and notification MUST carry `params`, and `params` MUST be a JSON object. JSON-RPC's omitted `params`, by-position (array) `params`, and primitive `params` are not supported; a node MUST reject such a request with `invalidParams`.
3. Batch arrays are not used; a node MAY reject a JSON-RPC batch with `invalidRequest`.

Everything else — message framing into the four kinds, id correlation, error semantics — is JSON-RPC 2.0 verbatim.

## 2. Method names

A `method` has one of two syntaxes:

- A **bare** method is a flexible printable-ASCII JSON-RPC method name. It has no linkrpc routing context.
- An **addressed** method uses `::` to identify an interface member, optionally on a named service. Its identifiers use a restricted printable-ASCII alphabet.

```abnf
method      = bare / addressed
bare        = 1*bare-char
addressed   = full / interface
full        = service-id "::" interface-id "::" member
interface   = interface-id "::" member
service-id  = segment *("/" segment)
interface-id= segment *("." segment)
member      = segment
segment     = 1*segment-char

bare-char   = %x20-7E
segment-char= ALPHA / DIGIT
			/ "!" / "#" / "$" / "%" / "&" / "'" / "(" / ")" / "*"
			/ "+" / "," / "-" / ";" / "=" / "?" / "@"
			/ "[" / "]" / "^" / "_" / "`" / "{" / "|" / "}" / "~"
```

`bare-char` is every printable ASCII character, including `/`, `:`, spaces, and punctuation. A bare method MUST NOT contain the sequence `::`; its presence selects the addressed syntax.

For an addressed method, split on the literal `"::"`:

- **2 parts** — `interface`: `interface-id :: member`. Addresses the **root service** (service id = the empty string).
- **3 parts** — `full`: `service-id :: interface-id :: member`.

Every addressed part MUST be non-empty and conform to its production above. A `service-id` uses `/` between non-empty segments; an `interface-id` uses `.` between non-empty segments; and a member is one segment. `/` and `.` are therefore structural in addressed methods, but remain ordinary characters in bare methods. Every segment is ASCII.

A node that receives a syntactically malformed method MUST respond with `methodNotFound` (for a request) or ignore it (for a notification).

> **Note.** The bare syntax preserves the freedom of ordinary JSON-RPC method names while keeping addressed names predictable for routing, matching, and display. A bare method has no interface context; an intermediary that routes on interface (a hub) does not accept it. See chapter 04 for the addressing model and chapter 08 for hub routing surfaces.

An endpoint MAY locally dispatch bare methods through prefix-to-interface bindings, including an empty-prefix default (chapter 05 §2.1). Such bindings do not change the method grammar or make bare calls routable by a hub.

## 3. The reserved `$hubrpc` namespace

On a call's `params` object, member keys beginning with `$hubrpc` are **reserved by linkrpc**; no other keys are reserved. Three are defined:

| Key | Carries | Defined in |
|---|---|---|
| `$hubrpc` | signed call metadata (and the interface-hash assertion) | §3.1 below; members in 04 §4, 06 §4 |
| `$hubrpcSignature` | the per-domain signature map | 06 §2 |
| `$hubrpcUnsigned` | extrinsic unsigned attachments (the capability bag) | 07 §2 |

**User params.** The *user params* of a call are its `params` object with every `$hubrpc`-prefixed key removed. Application interface schemas (chapter 04) describe the user params only.

**Strip rule.** Wherever this specification canonicalizes a call for hashing or signing, it canonicalizes the call object with `$hubrpcSignature` and `$hubrpcUnsigned` removed and `$hubrpc` retained. `$hubrpcSignature` cannot cover itself; `$hubrpcUnsigned` is authored by a party other than the signer. (The exact signing input is defined in 06 §2.)

> **Note.** `$hubrpc` lives inside `params` rather than as a sibling of `params` on the JSON-RPC object because JSON-RPC 2.0 fixes the top-level member set (`jsonrpc`, `id`, `method`, `params`); carrying metadata inside `params` keeps the message a valid JSON-RPC message and lets it travel with the call's arguments through a forwarder that treats `params` as opaque. The `$hubrpc` prefix — not the placement — is what reserves these keys from colliding with user param keys.

### 3.1 `$hubrpc` presence

`$hubrpc` is present on a call whenever any layer attaches metadata to it (an interface-hash assertion, a signature, or both). When present it MUST be a JSON object. Its individual members are defined where they gain meaning — `interfaceHash` in chapter 04, the signing members (`method`, `nonce`, `signedAtMs`, `principal`) in chapter 06. A node that does not implement those layers MUST ignore the corresponding members.

## 4. Error codes

JSON-RPC 2.0 already defines the codes in the first group; linkrpc reuses them unchanged and adds the second group from the JSON-RPC reserved range:

| Code | Name | Source | Meaning |
|---|---|---|---|
| -32700 | `parseError` | JSON-RPC 2.0 | invalid JSON was received |
| -32600 | `invalidRequest` | JSON-RPC 2.0 | not a valid request object |
| -32601 | `methodNotFound` | JSON-RPC 2.0 | the method does not exist / is not served |
| -32602 | `invalidParams` | JSON-RPC 2.0 | params are invalid for the method |
| -32603 | `internalError` | JSON-RPC 2.0 | internal error |
| -32401 | `permissionRequired` | linkrpc | caller is authenticated but lacks a capability covering the call (07) |
| -32402 | `peerDisconnected` | linkrpc | the peer a request was routed to detached before responding |
| -32403 | `requestTimeout` | linkrpc | the request exceeded the idle timeout with no stream activity (03) |
| -32800 | `cancelled` | linkrpc | the request was cancelled (03) |

A node MUST use the listed code for the listed condition. Application interfaces MAY define additional error codes outside the JSON-RPC reserved range (`-32768`..`-32000`); see chapter 04.
