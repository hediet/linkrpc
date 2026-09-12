# 05 — Reflection

This chapter defines the built-in `hubrpc.schemas` (interface schemas) and
`hubrpc.defaults` (the connection's preset service/interface) reflection
interfaces. The `hubrpc.directory` interface and its per-connection semantics are
defined by chapter 09. Reflection makes a node's served contract observable from
the connection boundary — the property the conformance model (chapter 00 §4)
relies on. These interfaces are ordinary interfaces (chapter 04); they are
specified here by their member schemas.

## 1. `hubrpc.schemas`

Serves interface schemas by id (and optional hash). A node MUST serve, through this interface, the schema of every interface it advertises in its directory.

```
hubrpc.schemas::get
  params: {
    interfaceId: string,
    hash?:       string     // omit ⇒ provider returns the version it exposes
  }
  result: { schema: InterfaceSchema }   // a full interface schema (04 §2)
```

When `hash` is supplied, the provider MUST return a schema whose interface hash equals it, or respond with `invalidParams` if it serves no such version.

## 2. `hubrpc.defaults`

Reports the empty-prefix bare-method binding on this connection, if any. This is the legacy preset (default) service/interface. Explicitly addressed methods (chapter 01 §2) do not consult this default.

```
hubrpc.defaults::get
  params: {}
  result: {
    serviceId?:     string,
    interfaceId?:   string,
    interfaceHash?: string
  }
```

A node MAY leave any field absent when it presets no default at that level.

> **Rationale.** A caller that connects to a single-purpose endpoint can discover, in one call, which service/interface its bare-form calls dispatch to — without hard-coding the binding.

### 2.1 Bare-method bindings

A connection MAY expose several registered interfaces through **bare-method bindings**. A binding maps a literal wire-name prefix to an interface on a specific service. It is a property of the connection, not of the interface schema or its content hash.

```
hubrpc.defaults::listBindings
  params: {}
  result: {
    bindings: {
      prefix:        string,
      serviceId?:    string,       // omitted = root service
      interfaceId:   string,
      interfaceHash: string
    }[]
  }
```

The result MUST include every active binding, including the empty-prefix default when present, sorted in ascending ASCII order by `prefix`. An endpoint that does not support this method may respond with `methodNotFound`; callers MUST NOT interpret that response as proof that no default exists. The existing `get` response shape is unchanged and reports only the empty-prefix binding.

A prefix is a possibly empty sequence of printable ASCII characters and MUST NOT contain `::`. Each prefix MUST be unique within the receiving connection. The target interface MUST already be registered at the specified service; removing that registration removes its bindings. Registering a duplicate prefix MUST fail rather than silently replace a binding. The legacy operation that sets the preset retains its replacement behavior for the empty-prefix binding.

For an incoming bare method:

1. Select the binding with the **longest matching prefix**.
2. Remove that prefix, leaving the member name, and dispatch to that member of the selected interface.
3. If there is no binding, or the selected interface has no such member, fail with `methodNotFound` for a request (ignore a notification). In particular, a missing member MUST NOT fall through to a shorter-prefix binding.

The empty prefix matches every bare method and is therefore a fallback only when no longer prefix matches. Explicitly addressed methods containing `::` bypass these bindings entirely. Bindings do not grant authorization and do not give a bare call an interface-routing context at an intermediary hub.

For example, one endpoint can bind `DOM.` to `cdp.DOM` and `Runtime.` to `cdp.Runtime`. Another can bind `textDocument/` and `workspace/` to LSP interfaces, `$/` to protocol-control members, and the empty prefix to lifecycle members such as `initialize` and `shutdown`. Both endpoints can still expose the same contracts using explicit LinkRPC addresses.

Bindings are local to the receiving endpoint and direction. A bidirectional protocol can use different bindings for requests and notifications received by the client and by the provider. An external CDP or LSP peer is not required to implement LinkRPC reflection; a local adapter can supply known bindings without querying that peer.
