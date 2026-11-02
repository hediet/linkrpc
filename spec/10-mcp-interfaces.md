# 10 — MCP interfaces

**Optional. Requires chapters 03, 04, 05.** This chapter specifies how a node publishes a [Model Context Protocol](https://modelcontextprotocol.io/specification) (MCP) server as a linkrpc service, so that consumers in any language can discover and use it. A published MCP server has one or more **MCP identities** (accounts, §5); each identity is one **upstream**: one MCP transport and its authentication. A **host** publishes the server under one service id in one or both modes:

- **service**: every MCP tool is a member of a generated interface, and `mcp.tools` lists and calls tools by name; all calls of an MCP identity share one upstream MCP session unless a caller opens an exclusive one (§2–§5);
- **forwarded**: each `connect` call carries one complete MCP session verbatim (§1).

These are ordinary interfaces (chapter 04), specified here by member schema.

> **Note.** The two modes trade fidelity for granularity. A capability (chapter 07) names an interface member, so a service host can be authorized per tool (or per group of tools, §2), while a forwarded host is authorized per server. Forwarding relays every MCP feature (resources, prompts, server-to-client requests); the service mode covers tools.

## 1. `mcp.forward`

```
mcp.forward::connect
  params: { clientInfo?: { name: string, version: string }, mcpIdentity?: string }
  result: { serverInfo?: { name: string, version: string } }
  stream (client → server): { frame: JsonRpcMessage }
  stream (server → client): { frame: JsonRpcMessage }
```

A `connect` request opens one **leg** for the MCP identity named by `mcpIdentity`, or the default identity (§5). Each leg MUST be backed by its own upstream MCP session of that identity: a new process for an MCP stdio upstream, a new MCP session (`Mcp-Session-Id`) for an MCP Streamable HTTP upstream. A host MUST NOT share an upstream MCP session between legs.

A host attached to one running MCP server that it cannot restart (an **instance**, e.g. a server on the host's own stdio) MUST serve at most one leg at a time and MUST reject `connect` while a leg is open. An instance has no MCP identities; the host MUST reject `connect` with `mcpIdentity`. A later leg uses the same server, so it sees the state left by earlier legs and starts with its own `initialize` exchange.

A `frame` is one MCP JSON-RPC message. The host MUST deliver client frames to the upstream session, and upstream messages to the caller, unchanged and in order. A host MAY drop a client frame that is not a JSON-RPC message.

The leg ends when either side ends it. When the upstream session ends, the host MUST settle the `connect` request. When the caller cancels the request (chapter 03), the host MUST end the upstream session: terminate the process, or terminate the HTTP session.

A host forwarding to a Streamable HTTP upstream MUST send the protocol version negotiated by the leg's `initialize` exchange as the `MCP-Protocol-Version` header of subsequent upstream requests of that leg.

`vscode.mcp-forward` is a deprecated id for the same interface. A host SHOULD serve it in addition to `mcp.forward` under the same service id; a consumer SHOULD accept a service offering only `vscode.mcp-forward`.

> **Note.** The result carries no MCP data; the MCP session is the stream. `clientInfo` and `serverInfo` are informational; MCP's own `initialize` exchange inside the stream is authoritative.

## 2. Generated tool interfaces

A service host serves one or more **generated interfaces** whose ids MUST match:

```abnf
generated-id = "mcp.tools." name [ "." group ]
name         = ( ALPHA-lower / DIGIT ) *( ALPHA-lower / DIGIT / "." / "-" )
group        = ( ALPHA-lower / DIGIT ) *( ALPHA-lower / DIGIT / "-" )
ALPHA-lower  = %x61-7A
```

Every MCP tool is a request member of exactly one generated interface. A host MAY partition the tools into **groups** by configuration; a tool in group `g` belongs to `mcp.tools.<name>.<g>`, any other tool to `mcp.tools.<name>`. A host MUST NOT serve a generated interface without members. The member name is the tool name with `%` replaced by `%25` and `:` replaced by `%3A`. Two tools that map to the same member name MUST NOT be published together.

> **Note.** Groups set the granularity of capabilities without per-tool grants: a permission for `mcp.tools.github` (exact interface id) excludes `mcp.tools.github.admin`, while a permission with interface prefix `mcp.tools.github` covers all groups. Group membership is host configuration; MCP itself does not group tools.

A member's params schema is the tool's `inputSchema`, with:

- optional `sessionId: string` (§4) and `mcpIdentity: string` (§5) properties added to every object branch; a tool whose input schema already declares either, or is not object-shaped, MUST NOT be published;
- `additionalProperties: true` on every object schema that does not specify `additionalProperties`;
- definitions under the input schema's root `$defs` or `definitions` moved to component schemas (chapter 04) with references rewritten accordingly.

A host that cannot represent a tool's input schema (e.g. a `$ref` it cannot resolve) MAY publish the member with params schema `{ type: "object", additionalProperties: true }` and leave validation to the upstream.

A member's result is the complete MCP `CallToolResult`: an object with a required `content` array and optional `structuredContent`, `isError`, and `_meta`. When the tool declares an `outputSchema`, `structuredContent` MUST be typed by it.

Member annotations (chapter 04) are derived from MCP tool annotations with MCP's defaults: `readOnly` iff `readOnlyHint` is `true`; otherwise `dangerous` unless `destructiveHint` is `false`; `idempotent` iff `idempotentHint` is `true`.

A host MUST invoke the tool named by the member with the params minus `sessionId` and `mcpIdentity`, in the session they select (§4, §5), and return the upstream `CallToolResult` unchanged. An MCP protocol error from the upstream MUST be returned as a linkrpc error, not as a result. Params that do not match the member's schema MUST be rejected with `invalidParams`.

The generated interfaces contain the union of the tools of all MCP identities whose tool list the host could read; when two identities define a tool differently, the host uses one definition. A call of an identity whose tool list lacks the tool is passed to the upstream, which rejects it.

When an upstream reports a changed tool list, or identities appear or become usable, the host MUST replace each generated interface whose schema changed, which changes its hash and is announced through the directory (chapter 09).

> **Note.** Callers address tools in fully-qualified form, e.g. `<serviceId>::mcp.tools.github::create_issue`. Capabilities for that member authorize exactly that tool.

## 3. `mcp.tools`

```
mcp.tools::listTools
  params: {}
  result: {
    interfaces: {               // the current generated interfaces (§2)
      interfaceId: string,
      interfaceHash: string,
      toolCount: integer
    }[],
    tools: {
      name: string,
      interfaceId: string,      // generated interface containing the tool
      method: string,           // member of interfaceId that invokes the tool
      title?: string,
      description?: string,
      inputSchema: JsonValue,   // the tool's MCP input schema, without sessionId
      outputSchema?: JsonValue,
      annotations?: object,     // the tool's MCP annotations
      identities?: string[]     // MCP identities whose tool list contains the tool
    }[],
    defaultIdentity?: string    // the identity used when a call omits mcpIdentity (§5)
  }

mcp.tools::callTool
  params: { sessionId?: string, mcpIdentity?: string, name: string, arguments?: Record<string, JsonValue> }
  result: CallToolResult
```

`listTools` lists the tools of all identities in MCP form. `callTool` invokes the tool `name` with `arguments` exactly like its generated member (§2), in the session named by `sessionId` and `mcpIdentity` (§4, §5). The host MUST reject an unknown `name`, and `arguments` containing `sessionId` or `mcpIdentity`, with `invalidParams`.

A consumer presenting the tools to an MCP client SHOULD invoke them through `method` of `interfaceId`, so that consent and capabilities name the tool's interface and member.

> **Note.** A permission for `mcp.tools::callTool` authorizes every tool. Narrow it with parameter matchers (chapter 07), e.g. `params: { name: { enum: ["list_notes"] }, arguments: { any: true } }`.

## 4. `mcp.server`

```
mcp.server::getState
  params: { sessionId?: string, mcpIdentity?: string }
  result: McpServerState

mcp.server::watchState
  params: { sessionId?: string, mcpIdentity?: string }
  result: {}
  stream (server → client): McpServerState

mcp.server::openSession
  params: { mcpIdentity?: string }
  result: { sessionId: string }

mcp.server::closeSession
  params: { sessionId?: string, mcpIdentity?: string }
  result: { closed: boolean }

mcp.server::restartSession
  params: { sessionId?: string, mcpIdentity?: string }
  result: {}
```

Tool calls without `sessionId` use the **shared session** of the selected MCP identity (§5). `openSession` opens an **exclusive session** of the selected identity, an upstream MCP session of its own, and returns its id. A host MUST generate exclusive session ids with at least 122 bits of randomness and MUST reject a `sessionId` it did not issue or has closed with `invalidParams`. An exclusive session belongs to the identity it was opened for: a host MUST reject a call whose selected identity differs from the session's with `invalidParams`, so that a capability pinning `mcpIdentity` also covers calls with a session id. `closeSession` ends the session; for an exclusive session it also invalidates the id. A host MAY end idle sessions and reopen them on the next call with the same id.

> **Note.** The session id is a bearer handle: any caller holding it can use and close the session. Capabilities still apply to every call.

`McpServerState`:

```
{
  revision: integer,                // increases with every change
  identity?: { id: string, label?: string },   // the selected MCP identity (§5)
  server:    { status: "starting" | "running" | "idle" | "stopping" | "stopped" | "error", error?: string },
  transport: { status: "disconnected" | "connecting" | "connected" | "error", error?: string },
  authentication:
      { status: "not-required" | "checking" }
    | { status: "authorization-required" | "authorizing", authorizationUri: string, expiresAt?: string }
    | { status: "ready", identityId?: string, identityLabel?: string, tokenExpiresAt?: string }
    | { status: "error", error: string, authorizationUri?: string },
  tools:   { status: "unknown" | "loading" | "ready" | "error", interfaces?: { interfaceId: string, interfaceHash: string, toolCount: integer }[], count?: integer, error?: string },
  session: { sessionId: string, status: "absent" | "opening" | "ready" | "closing" | "closed" | "error", error?: string }
}
```

`identity` and `authentication` describe the selected MCP identity. `session` describes the session named by the request (the identity's shared session, `""`, when omitted). `authentication` MUST NOT contain credentials.

## 5. `mcp.identities`

```
mcp.identities::list
  params: {}
  result: {
    identities: {
      id: string,
      label?: string,
      default: boolean,
      authentication: McpAuthenticationState   // as in McpServerState (§4)
    }[]
  }

mcp.identities::authorize
  params: {}
  result: { authorizationUri: string, expiresAt?: string }
```

An **MCP identity** is one account of a published MCP server, i.e. one upstream: for example the access token of one user for a Streamable HTTP server, or environment variables for a stdio process. Identity ids MUST match `[A-Za-z0-9][A-Za-z0-9._@+-]*`. A host serves `mcp.identities` in both modes; a server without accounts has one identity.

Calls select an identity with the `mcpIdentity` parameter. A call without it uses the **default identity**: exactly one identity has `default: true` while any exist. A host MUST reject an unknown `mcpIdentity` with `invalidParams`. Upstream sessions MUST NOT be shared between identities.

`authorize` starts signing in a further identity and returns a URL to open in a browser; the identity appears in `list` once authorized. A host that cannot add identities MUST reject `authorize`.

> **Note.** Which caller may use which identity is decided by capabilities (chapter 07), not by the host: a permission with the parameter matcher `mcpIdentity: { exact: "work" }` allows only that account. Parameter matchers name every parameter of a call, so a permission for a generated tool member also lists the tool's own parameters, e.g. `{ mcpIdentity: { exact: "work" }, text: { any: true } }`. Such a permission rejects calls that omit `mcpIdentity`, so the default identity cannot be used to bypass it.

## 6. Discovery

A consumer discovers published MCP servers through the directory (chapter 09): a service listing `mcp.tools` is published as a service; a service listing `mcp.forward` or `vscode.mcp-forward` is forwarded. A consumer that supports both SHOULD use a service offering both in service mode.
