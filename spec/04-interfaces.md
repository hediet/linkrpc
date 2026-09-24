# 04 — Interfaces

This chapter defines what a linkrpc **interface** is: a named set of typed members described by an *interface schema*, and a content **hash** that gives the schema a stable identity. It defines the schema format, the restricted JSON Schema subset, the normalization and hashing that derive the interface hash, the `$hubrpc.interfaceHash` caller assertion, and the validation obligations on calls and responses. This layer is a pure addressing/typing mechanism; it requires no identity or capabilities.

## 1. Interfaces and members

An **interface** is identified by an `interface-id` (a `.`-delimited string conforming to chapter 01 §2, e.g. `de.hediet.notification-target`) and declares a set of **members**. A member is one of:

- a **request** member — invoked by a request, answered by a response;
- a **notification** member — invoked by a notification, never answered.

A member is addressed on the wire by a `method` (chapter 01 §2) whose final segment is the member name. The user params of a call (chapter 01 §3) MUST match the member's parameter schema.

A **service** is a concrete provider of one or more interfaces, identified by a `service-id` (a `/`-delimited string conforming to chapter 01 §2). The empty service id denotes the **root service** of a connection, addressed by the two-segment `interface::member` form.

## 2. Interface schema format

An interface schema is a JSON object — a strict subset of OpenRPC 1.x describing one interface (members plus reusable JSON Schemas). Identity and addressing are linkrpc's concern and are absent from this format.

```
InterfaceSchema = {
  id:          string,             // interface id
  hash:        string,             // content hash (§4); id@hash is a diagnostic notation only
  description?: string,            // NORMATIVE markdown; part of the hash
  comment?:    string,             // non-normative notes; stripped from the hash
  tags?:       string[],           // non-normative discovery labels; stripped from the hash
  methods:     { [member: string]: MethodSchema },
  components?: { schemas?: { [name: string]: JsonSchema } }
}

MethodSchema = {
  params:        JsonSchema,       // schema for the user params object
  result?:       JsonSchema,       // omit ⇒ notification-only member
  clientStream?: JsonSchema,       // caller→provider stream payload schema (03)
  serverStream?: JsonSchema,       // provider→caller stream payload schema (03)
  errors?:       ErrorSchema[],    // handled error codes and their response schemas
  summary?:      string,
  description?:  string,           // NORMATIVE; part of the hash
  comment?:      string,           // non-normative; stripped
  deprecated?:   boolean,
  annotations?:  MemberAnnotations
}

ErrorSchema =
  | { code: number, schema: JsonSchema }
  | { type?: string, code: number, message: string, data?: JsonSchema }

MemberAnnotations = {             // every flag defaults to false; NORMATIVE
  readOnly?:   boolean,           // no observable state change; implies idempotent, reversible
  idempotent?: boolean,           // N calls ≡ one call
  reversible?: boolean,           // effects can be undone; implies not dangerous
  expensive?:  boolean,           // slow / costly / rate-limited
  dangerous?:  boolean            // irreversible or destructive
}
```

Each key of `methods` MUST conform to the `member` production in chapter 01 §2. The key is the member name; schemas for params, results, and stream payloads are values and therefore carry no redundant synthetic name.

`tags` labels the interface for discovery, not for identity, routing, authorization,
or structural compatibility. Producers SHOULD omit an empty array and SHOULD
deduplicate labels; consumers MUST treat absent tags as empty. The array is a
non-authoritative hint: membership does not establish a method, schema, or
capability. Only the **top-level interface** `tags` field is excluded from the
hash; a property named `tags` elsewhere remains part of its enclosing normative
contract unless another existing rule excludes it.

`JsonSchema` is the restricted JSON Schema subset defined in §3. Reusable definitions are referenced as `#/components/schemas/<name>`. A boolean `true` schema matches any value (used where a member declares no value, e.g. a void result); `false` matches nothing.

**Normative vs. non-normative schema fields.** `description` and `annotations` are part of the interface's identity (§4): changing them is a contract change. `comment`, `summary`, and `deprecated` are not part of identity. In addition, any field whose key begins with `x-` is a **specification extension** (§4.1): it is carried in the document but is non-normative and never affects identity.

### 2.1 Code-first error handling

Only request members MAY declare `errors`. Error codes MUST be signed 32-bit
integers. Handledness is determined by the numeric code within the called method:

1. If the method has no declaration for the received code, retain the original
   error as a generic remote error.
2. Otherwise, decode the response using the declared decoder for that code.
3. A successfully decoded response is a typed handled error. A decoding failure
   is a generic **noncompliant-server** failure, not an unhandled remote error.

The decoder performs validation as part of decoding; implementations SHOULD NOT
run a separate schema-validation pass over the same payload first. Compliance
detection need not be exhaustive: native decoder semantics, such as Serde
coalescing missing and null optional fields, are permitted. A schema declaration
does not require a second, stricter validator alongside the decoder.

Compliance failures MUST retain the original error, including whether `data` was
absent or present, and actionable validation issues. Issue paths use JSON Pointers
relative to the JSON-RPC error object, such as `/data/retryAfter` or
`/data/data/resource`. This is a client-side diagnosis; it does not assign a new
wire error code. A remote numeric code can never establish local transport origin.

### 2.2 Plain JSON-RPC errors

The `{ code, schema }` form describes ordinary JSON-RPC errors without a LinkRPC
envelope. The schema describes the error **body** `{ message, data? }`, excluding
the numeric `code` already used for dispatch. `message` is always a JSON-RPC
string; its schema may be a general string or a more restrictive declared value.
The body schema controls whether `data` is required, optional, or forbidden and
whether explicit JSON `null` is allowed.
Protocol requirements apply independently of this schema: even a permissive
`true` schema cannot admit a non-string message or a non-JSON value. Body schemas
may otherwise use the same supported unions and component references as other
schema positions.

For example:

```json
{
  "code": -32001,
  "schema": {
    "type": "object",
    "properties": {
      "message": { "type": "string" },
      "data": {
        "type": "object",
        "properties": { "retryAfter": { "type": "number" } },
        "required": ["retryAfter"],
        "additionalProperties": false
      }
    },
    "required": ["message", "data"],
    "additionalProperties": false
  }
}
```

This handles `{"code":-32001,"message":"Try again later","data":{"retryAfter":5}}`.
It requires no `type` field. A string-valued `retryAfter` is a compliance failure.
Foreign protocol declarations MAY use documented JSON-RPC reserved codes,
including the implementation-defined server-error range `-32099` through `-32000`.
Declaring such a code does not change its protocol semantics.

A plain declaration MUST NOT also contain the named/legacy `type`, `message`, or
`data` schema fields, and its code MUST NOT occur in another declaration for the
same method. Multiple payload alternatives belong in its body schema as a union,
not in competing decoders. Consumers MUST NOT invent semantic distinctions when
the foreign wire representation is ambiguous. Unspecified data can be described
by an optional property with a `true` schema.

### 2.3 Named and legacy application errors

The `{ type?, code, message, data? }` form is shorthand for schemas of LinkRPC
application errors. Its codes MUST be outside the reserved JSON-RPC range
`-32768` through `-32000` (inclusive) and the LinkRPC cancellation code `-32800`.
LinkRPC defines `1` as its default application error code; JSON-RPC itself does not
assign a standard application error code. Authoring APIs SHOULD default to `1`
and MAY allow an explicit code. Exported schemas MUST include the resolved code.

A named error declares a nonempty `type`, unique among the method's named errors.
Named errors MAY share a code. They use an adjacent-tagged envelope in the
JSON-RPC error's `data`:

```json
{
  "code": 1,
  "message": "Resource not found",
  "data": {
    "type": "NotFound",
    "data": { "resource": "document:123" }
  }
}
```

The envelope MUST contain only `type` and, when declared, `data`.
The declaration's `data` schema describes the **inner** `data`, not the envelope.
Omitting this schema requires the inner `data` to be absent; the outer envelope
and its `type` remain required. When the schema is present, the inner `data` MUST
be present and match it. In particular, absent data and JSON `null` are distinct.
Data schemas support the same local component references and guarded recursion as
other schema positions.

Declarations sharing a code describe a union of possible error responses. After
code selection, the named envelope's `type`, data presence, and data schema select
and validate a variant. The wire `message` is diagnostic and MUST NOT be used to
select a named variant. The schema's `message` is the producer's default diagnostic
message or authoring-language format template. Templates are opaque metadata
to consumers: they MUST NOT be evaluated as code or treated as message equality
constraints. Producers may interpolate payload fields into the wire diagnostic;
consumers must accept that rendered string. An unknown or missing tag under a handled code is a compliance failure
unless another explicitly declared branch of that code's union accepts it.

For compatibility, declarations without `type` retain the legacy representation:
their codes MUST be unique among the method's legacy errors, their wire `message`
MUST exactly match the declaration, and their schema describes the outer wire
`data` directly (including presence or absence). Named branches are attempted before
legacy branches when both use the same code. A permissive legacy branch is an
explicit part of that union and may accept values a named branch rejects; avoid
such overlaps when reliable variant discrimination matters.

Failure of every branch for a handled code MUST yield a compliance failure.
Consumers MUST NOT reclassify that response as an unhandled remote error.
Local transport failures are never declared application errors.
Typed application-error producers MUST validate their error before encoding it;
invalid application values are local implementation failures, not valid instances
of the declared error.

The declarations, including their types, codes, messages, normalized data schemas,
and plain body schemas, are
normative and participate in the interface hash. Declaration order is preserved.
Clients MUST still support undeclared remote errors: the list is not a closed set of
all possible failures of a call. In languages without checked exceptions, typed
application failures SHOULD be exposed through an explicit discriminated result API
rather than an assertion about the type of an arbitrary caught exception.
Client APIs SHOULD separate declared application failures from generic RPC failures.
TypeScript clients may return application failures as nominally branded values while
throwing generic failures, with a separate result client returning both categories.
Rust clients may return `Result<T, E>` when the application enum has an opt-in
generic fallback variant, or `Result<T, CallError<E>>`, where `CallError`
distinguishes `Application(E)` from `Generic(...)`. The fallback is a local API
choice, not a schema declaration or wire variant, and does not affect the hash.
Methods without declared application errors may return `RpcCallError` directly.
The same error surface applies to streaming startup and final response; notification
failures are local or transport failures, not remote application responses.
Generic failures retain remote, local, and
transport provenance instead of interpreting a remote code as a local transport event.
The generic category also includes noncompliant-server failures. The normal
TypeScript client throws that diagnosis, rather than the original wire error;
its result client returns the same diagnosis as a generic failure value.

Adding a `type` to a legacy declaration changes both its wire representation and
interface hash. It is a contract change, not a wire-compatible optional annotation.

## 3. The JSON Schema subset

`JsonSchema` is a deliberately restricted subset of JSON Schema chosen to support language-independent structural *assignability* checks — does every value matching schema `X` also match schema `Y`? A `JsonSchema` is one of:

```
JsonSchema =
  | true | false                                   // top / bottom
  | { type: "null" }
  | { type: "boolean" }
  | { type: "number",  format?: string }           // format = opaque refinement tag
  | { type: "integer", format?: string }
  | { type: "string",  format?: string }
  | { const: <value> }                             // single literal
  | { enum: <value>[] }                            // finite literal set
  | { type: "array", items: JsonSchema }           // homogeneous array
  | { type: "array", prefixItems: JsonSchema[], items?: JsonSchema | false }  // tuple
  | { type: "object",
      properties: { [name: string]: JsonSchema },
      required?: string[],                         // each MUST be a key of properties
      additionalProperties: JsonSchema | false }   // false ⇒ closed
  | { anyOf: JsonSchema[] }                        // untagged union
  | { oneOf: JsonSchema[], discriminator?: { propertyName: string } }  // tagged union
  | { $ref: string }                               // "#/components/schemas/<name>" only
```

Every node MAY additionally carry the annotation keys `title` and `description`.

**Reserved keys.** Object keys beginning with `x-` are reserved as specification extensions (§4.1) at every level of the interface schema, including inside a `JsonSchema` node. A property name in a `properties` map therefore MUST NOT begin with `x-`.

**Excluded keywords.** The following JSON Schema keywords are **not** part of the subset and MUST NOT appear in a `JsonSchema`: `not` (except the special form below), `if`/`then`/`else`, `allOf`, `pattern`, `patternProperties`, `propertyNames`, `dependentSchemas`, numeric bounds (`minimum`, `maximum`, `multipleOf`, …), and length/size bounds. A producer that lowers a richer schema into this subset MUST drop these.

**`format`** is an opaque refinement tag on `number`/`integer`/`string`. Two schemas with different `format`s are incomparable; adding a `format` narrows, dropping one widens.

**`oneOf` vs `anyOf`.** `oneOf` is structurally identical to `anyOf` for assignability; the distinction is preserved only to record that the source was a tagged (discriminated) union. `discriminator.propertyName` names the property branches dispatch on; it is a consumer hint and is not otherwise enforced.

This chapter does not prescribe a complete decision procedure for every semantic inclusion involving unions. A structural assignability implementation MAY be conservative: in particular, checking branches pairwise need not recognize cases where several branches together cover another schema.

### 3.1 Normalization

Before an interface schema is hashed (§4), every `JsonSchema` in it MUST be in the following canonical form, so that structurally-equal schemas produce byte-identical bytes:

1. Drop every key not listed above (annotation keys such as `examples`, `default`, `$comment`, `readOnly`, and every excluded keyword).
2. The empty schema `{}` (after dropping) becomes `true`.
3. `{ "not": {} }` becomes `false`; any other `not` is dropped.
4. A `{ type: "object" }` with no `additionalProperties` becomes closed — `additionalProperties: false`.
5. `required` is sorted ascending.
6. For a `oneOf` with no explicit `discriminator`, a `discriminator` MAY be synthesized when every branch is an object schema sharing exactly one property that is `const`-valued and pairwise-distinct across branches; a `discriminator` with no `oneOf` to attach to is dropped.

> **Rationale.** The subset trades JSON Schema's full expressivity for interoperable structural checks and a stable, language-independent canonical form — both prerequisites for the interface hash (§4) and for schema-compatibility checks across versions.

### 3.2 References and guarded recursion

A `$ref` is local to its containing `InterfaceSchema`. The only valid form is `#/components/schemas/<encoded-name>`, where `<encoded-name>` is one complete JSON Pointer reference-token encoded according to RFC 6901 (`~` as `~0` and `/` as `~1`). After decoding that final segment, it resolves to the value stored under the exact decoded key in that document's `components.schemas` map. The segment MUST NOT be interpreted as an arbitrary subpath. A `$ref` in a method schema, error schema, stream schema, or component uses that same map. External references, other JSON Pointer forms, and references to a missing entry are invalid.

The schema document and every JSON value being validated are finite. The component map may nevertheless form a recursive reference graph, including direct self-recursion and mutual recursion. Such a graph is valid only when **every cycle is guarded**: every cycle, after following both schema-containment edges and `$ref` resolution edges, MUST traverse at least one **child-instance edge**. The child-instance edges are precisely:

- an object schema to each schema in `properties`;
- an object schema to its schema-valued `additionalProperties`;
- an array schema to schema-valued `items`; and
- an array schema to each entry in `prefixItems`.

Edges into `anyOf` or `oneOf` branches and `$ref` resolution edges are not child-instance edges and do not guard recursion. Equivalently, deleting all child-instance edges from the schema/reference graph MUST leave an acyclic graph. A dangling `$ref` or an unguarded cycle makes the entire interface schema invalid.

For example, this finite `components` object validly describes a linked list:

```json
{
  "schemas": {
    "StringList": {
      "anyOf": [
        { "type": "null" },
        {
          "type": "object",
          "properties": {
            "value": { "type": "string" },
            "next": { "$ref": "#/components/schemas/StringList" }
          },
          "required": ["value", "next"],
          "additionalProperties": false
        }
      ]
    }
  }
}
```

The recursive cycle passes through the `next` property, whose value is a strict child of the containing object. By contrast, both of these `components` objects are invalid:

```json
{ "schemas": { "Loop": { "$ref": "#/components/schemas/Loop" } } }
```

```json
{
  "schemas": {
    "A": { "anyOf": [{ "type": "string" }, { "$ref": "#/components/schemas/B" }] },
    "B": { "oneOf": [{ "$ref": "#/components/schemas/A" }] }
  }
}
```

The second cycle passes only through union branches and references; a union does not move validation to a child JSON value.

Guardedness is a well-formedness condition, not a non-emptiness or productivity guarantee. For example, an object component whose required `next` property refers to itself is guarded, but no finite JSON value can satisfy it unless some reachable alternative supplies a finite base case. Such an empty schema is still well-formed.

## 4. Interface hash

The **interface hash** is the content identity of an interface schema. It is computed as:

1. **Canonical document.** Take the finite schema document with each `JsonSchema` normalized (§3.1), recursively remove every `comment` field, every specification-extension field (any key beginning with `x-`, §4.1), and, at the top level, the `hash` field itself, and remove members whose value is `undefined`. (No other field is removed; `description` and `annotations` remain.) Hash the component definitions and their `$ref` strings as written; do not unfold references.
2. **Canonicalize.** Serialize the canonical document with [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS).
3. **Hash.** Compute SHA-256 ([FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final)) over the UTF-8 bytes of the JCS output.
4. **Truncate.** Take the first 8 bytes of the digest and render them as 16 lowercase hexadecimal characters. This string is the hash.

Byte-identical canonical documents necessarily have the same hash. Differing canonical documents are distinguished only subject to the deliberate 64-bit collision budget described below.

Component names and `$ref` strings are therefore part of the canonical document. Renaming a component and updating its references can change the hash even when the resulting reference graph accepts the same values; the interface hash does not claim rename-insensitive semantic identity.

> **Note.** `id@hash` is a human/diagnostic notation for "interface `id` at version `hash`". It is never sent as a single token on the wire: a method (chapter 01 §2) carries only the id, and a version assertion travels as the separate `$hubrpc.interfaceHash` field (§5).

> **Rationale.** 64 bits of hash is a deliberate collision budget per id, not a security boundary — identity is scoped by `id`, and the hash only distinguishes versions of that id.

> **Note.** Producers and consumers in different languages MUST agree byte-for-byte on the canonical document. The JCS encoding of numbers and strings, the normalization rules (§3.1), and the exact set of stripped fields are the interop-critical surface; the conformance corpus (conformance.md) pins them with vectors.

### 4.1 Specification extensions (`x-…`)

An interface schema is **one document** that may carry richer, non-normative material alongside its wire contract — code-generation directives, stronger validation/safety expressions, provenance, tooling hints. This material lives under **specification-extension keys**: any object key whose name begins with `x-`, at any level of the document (interface, method, error, or inside a `JsonSchema` node). This mirrors the specification-extension convention of OpenRPC/OpenAPI, of which this schema format is a subset.

Extension keys are **non-normative**: step 1 of §4 strips every `x-…` key before hashing, exactly as it strips `comment`. Consequently:

- The interface **identity is the simple-contract projection** — the document with all `x-…` (and `comment`) material removed and each `JsonSchema` normalized (§3.1). Two documents that differ only in their extensions have the same hash.
- Editing, adding, or removing an `x-…` value is never a contract change. Changing any wire field (member names, `params`, `result`, stream schemas, `type`, `required`, `description`, `annotations`, …) is.
- There is exactly **one** stored schema document; the "simple contract" is derived (by stripping), never stored separately.

This is a purely additive rule. No interface that avoids `x-…` keys is affected, so every hash computed before this rule existed is preserved. Because `x-…` keys are reserved (§3), they cannot collide with member names (which are alphanumeric per chapter 01 §2) or with subset property names.

> **Note (normative vs. non-normative).** The stripping rule and the reservation of the `x-` prefix are **normative** (an implementation MUST strip these keys to interoperate on the hash). The *meaning* of any particular extension (e.g. `x-codegen`, `x-validation`) is **non-normative** and outside this specification — extensions are for producers and their tooling, and a conformant peer that does not understand an extension simply ignores it.

### 4.2 Non-normative JSON Schema specialization

A richer authoring document MAY attach an `x-json-schema` fragment to a schema node. In this specialization profile the fragment is an additional JSON Schema Draft 2020-12 constraint on the same JSON value, not a replacement for the structural schema and not a merge patch. For example:

```json
{
  "type": "integer",
  "x-json-schema": { "minimum": 1, "maximum": 65535 }
}
```

The normative projection describes an integer. A specialization-aware consumer additionally restricts it to the indicated range. The type and surrounding object structure need not be duplicated in the extension.

A specialization exporter derives a separate JSON Schema view by translating the structural schema, recursively specializing its child schemas, and conjoining each node with its fragment. It can represent conjunction using `allOf`; it must not implement it by overwriting conflicting keys. Component definitions remain shared and recursive references remain finite, for example by exporting components under `$defs` and rewriting references. Reference resolution does not imply permission to fetch external documents.

Specialization can narrow but cannot widen the structural contract. In particular, an extension cannot add allowed properties to a closed object by overriding `additionalProperties`. A producer lowering a richer protocol must ensure that its structural approximation includes every value permitted by the richer contract; simply dropping keywords and applying object-closure defaults is not, in general, sufficient.

This profile is non-normative for LinkRPC interoperability. Peers may ignore it; changing a fragment does not change the interface hash, and structural compatibility checks do not prove that a specialization-aware peer will accept a value. Consumers that need to detect specialization changes must separately version or hash the exported rich view. Implementations should preserve the rich source document and derive the normalized hash projection rather than replace the source with that projection.

### 4.3 Non-normative interface template instances

An interface MAY describe a reusable, parameterized decomposition under the
`x-interface-templates` extension while retaining ordinary concrete `methods` as its
only wire contract. A template declares named schema parameters, methods, and
optional local components and `tags?: string[]` discovery labels. A template's
tags contribute to the interface's effective tags **only when that template is
instantiated**, deduplicated with its explicit interface tags. An authoring
producer MUST materialize these effective labels into the first-class top-level
`tags` field when publishing the concrete interface schema. A consumer need
only read that top-level field; it MUST NOT be required to parse optional template
metadata for discovery. Template tags are not part of structural equivalence
and do not change the interface hash. A
schema parameter is written as
`{"$parameter":"name"}`; it is distinct from JSON Schema `$ref`, which continues
to refer only to a component. An instance names a template, supplies one
concrete schema argument for every parameter, and explicitly maps every template
member to a concrete member:

```json
{
  "x-interface-templates": {
    "templates": {
      "store": {
        "id": "store",
        "parameters": ["value"],
        "methods": {
          "get": { "params": true, "result": { "$parameter": "value" } }
        }
      }
    },
    "instances": [{
      "name": "users",
      "template": "store",
      "members": { "get": "fetchUser" },
      "arguments": { "value": { "schema": { "type": "string" } } }
    }]
  }
}
```

The example describes the already-present concrete member `fetchUser`.
Consumers that understand
this extension MUST reject unknown or missing parameters, unresolved template
or argument component references, missing or extra mapping keys, duplicate
instance names, and any instance whose instantiated methods do not exactly match
the corresponding concrete methods. A concrete member MUST be claimed at most
once globally, even across different template instances. Unclaimed ordinary
members are allowed. Prefix-based instances are not supported.
Template-local and argument-local component namespaces are independent, so
recursive schemas do not require globally unique component names.

Template instances are structural metadata, not handler implementations.
The TypeScript `defineInterfaceTemplate(info, genericFactory)` authoring helper
returns a generic callable: `Store({ Value: z.number() })`. The factory uses an
explicitly generic schema argument (for example `<V>({ Value }: { Value: Schema<V> })`).
It MUST be declarative and side-effect free: it is called once with symbolic
schemas to export the template and again with concrete schemas for each instance.
Concrete methods and checked error descriptors retain their original validators;
instantiation does not clone or substitute a Zod AST. Parameter references are
exported and substituted in checked error data/body schemas just as in params,
results and streams. Concrete instances MUST match the instantiated reflected
contract. Arbitrary refinements are not compared; unsupported JSON Schema
representations fail explicitly. Metadata is available on bound instances, not
as properties on the generic callable.
A peer may ignore them, and adding,
removing, or reorganizing it does not affect the interface hash. Schema import,
reflection, and source generation SHOULD preserve the extension verbatim.

The TypeScript authoring API can declare a bound template directly under a group
key. It expands members to `group$member` (or to an explicit `mapMembers` target),
emits the same explicit metadata, and requires a complete nested implementation
at registration. Clients built from that directly authored definition expose the
same nested groups, with no flat aliases: `connection.get(api).numbers.get({})`.
This applies equally to result-returning clients. Group access reuses the concrete
call functions, preserving checked errors and streaming handles; it does not change
method dispatch, addressing, hashes, or reflection.

This is a local authoring constraint, not a wire-level feature. Imported schemas
and generated interfaces remain flat. The optional metadata-only authoring form
for independently defined concrete methods changes neither their flat registration
nor their flat client shape. Non-normative reflected metadata MUST NOT silently
reshape a client's API. Local grouping is snapshotted from the authored declaration.
`InterfaceTemplateClient<typeof bound>` (or its `InterfaceTemplateResultClient`
counterpart) allows consumers to depend on a group's specialized methods without
depending on its instance name, containing interface, or concrete wire mapping.

### Optional explanation selection

This bounded v1 profile does not introduce generic wire calls or require generic
factory authoring in other languages. Concrete imported/generated APIs remain
flat. Explanations may be absent or lost; they are not authority for dispatch,
permissions, or interface compatibility.

Implementations with multiple documents for a validated identical `id@hash` MAY
prefer valid `x-interface-templates` over none, or a compatible superset retaining
the existing templates and instances. Otherwise selection SHOULD remain stable.
This is a best-effort heuristic, not a metadata version or completeness protocol.
Select one existing document in its entirety; do not union fragments. Malformed
optional metadata MUST NOT gain preference or make otherwise valid RPC dispatch
fail merely because a selection heuristic inspected it. Template-aware consumers
may still reject invalid explanations using the profile's validation rules.

## 5. `$hubrpc.interfaceHash`

A caller MAY assert the interface hash it believes the target implements by setting `interfaceHash` (a hash string, §4) inside the call's `$hubrpc` object (chapter 01 §3.1):

```
params.$hubrpc.interfaceHash = "<16 hex>"
```

When present, this is a fail-fast contract check: a provider MAY reject a call whose asserted `interfaceHash` does not equal the hash of the interface it actually serves, responding with `invalidParams`. When absent, the caller has not pinned a version and the provider MUST NOT reject on this basis.

> **Note.** `interfaceHash` is meaningful with no identity layer present — it is a plain assertion in the call, verifiable by the provider against its own schema. Chapter 07 additionally allows a capability to *require* a particular `interfaceHash` (`TargetPattern.interfaceHash`).

## 6. Validation

For a request whose method names a member it serves, a provider MUST validate the user params against the member's parameter schema. If validation fails, the provider MUST respond with `invalidParams`. On success it MUST emit either a result valid against the member's result schema, or an error whose `code` is one of the protocol codes (chapter 01 §4) or an application code declared in the member's `errors`.

A caller SHOULD validate a received result against the member's result schema and MAY treat a schema-invalid result as a protocol fault.

> **Note.** This is the *contract obligation* of chapter 00 §4 made concrete: linkrpc fixes the shape of the reaction (schema-valid result | enumerated error); the interface schema supplies the schemas; the application supplies the values.
