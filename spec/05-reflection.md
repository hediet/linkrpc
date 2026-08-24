# 05 — Reflection

This chapter defines the built-in `linkrpc.schemas` (interface schemas) and
`linkrpc.defaults` (the connection's preset service/interface) reflection
interfaces. The `linkrpc.directory` interface and its per-connection semantics are
defined by chapter 09. Reflection makes a node's served contract observable from
the connection boundary — the property the conformance model (chapter 00 §4)
relies on. These interfaces are ordinary interfaces (chapter 04); they are
specified here by their member schemas.

## 1. `linkrpc.schemas`

Serves interface schemas by id (and optional hash). A node MUST serve, through this interface, the schema of every interface it advertises in its directory.

```
linkrpc.schemas::get
  params: {
    interfaceId: string,
    hash?:       string     // omit ⇒ provider returns the version it exposes
  }
  result: { schema: InterfaceSchema }   // a full interface schema (04 §2)
```

When `hash` is supplied, the provider MUST return a schema whose interface hash equals it, or respond with `invalidParams` if it serves no such version.

## 2. `linkrpc.defaults`

Reports the preset (default) service/interface bound to this connection, if any — the binding that gives meaning to the bare and interface method forms (chapter 01 §2).

```
linkrpc.defaults::get
  params: {}
  result: {
    serviceId?:     string,
    interfaceId?:   string,
    interfaceHash?: string
  }
```

A node MAY leave any field absent when it presets no default at that level.

> **Rationale.** A caller that connects to a single-purpose endpoint can discover, in one call, which service/interface its bare-form calls dispatch to — without hard-coding the binding.
