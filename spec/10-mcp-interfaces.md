# 10 — MCP interfaces

**Optional. Requires chapters 03, 04, 05.** This chapter specifies how a node publishes a [Model Context Protocol](https://modelcontextprotocol.io/specification) (MCP) server as a linkrpc service, so that consumers in any language can discover and use it. A published MCP server is one **upstream**: one MCP transport and its authentication. A **host** publishes an upstream under one service id in one or both modes:

- **typed**: every MCP tool is a member of a generated interface; all calls share one upstream MCP session unless a caller opens an exclusive one (§2–§4);
- **forwarded**: each `connect` call carries one complete MCP session verbatim (§1).

These are ordinary interfaces (chapter 04), specified here by member schema.

> **Note.** The two modes trade fidelity for granularity. A capability (chapter 07) names an interface member, so a typed host can be authorized per tool, while a forwarded host is authorized per server. Forwarding relays every MCP feature (resources, prompts, server-to-client requests); the typed mode covers tools.

## 1. `mcp.forward`

```
mcp.forward::connect
  params: { clientInfo?: { name: string, version: string } }
  result: { serverInfo?: { name: string, version: string } }
  stream (client → server): { frame: JsonRpcMessage }
  stream (server → client): { frame: JsonRpcMessage }
```

A `connect` request opens one **leg**. Each leg MUST be backed by its own upstream MCP session: a new process for an MCP stdio upstream, a new MCP session (`Mcp-Session-Id`) for an MCP Streamable HTTP upstream. A host MUST NOT share an upstream MCP session between legs.

A `frame` is one MCP JSON-RPC message. The host MUST deliver client frames to the upstream session, and upstream messages to the caller, unchanged and in order. A host MAY drop a client frame that is not a JSON-RPC message.

The leg ends when either side ends it. When the upstream session ends, the host MUST settle the `connect` request. When the caller cancels the request (chapter 03), the host MUST end the upstream session: terminate the process, or terminate the HTTP session.

A host forwarding to a Streamable HTTP upstream MUST send the protocol version negotiated by the leg's `initialize` exchange as the `MCP-Protocol-Version` header of subsequent upstream requests of that leg.

`vscode.mcp-forward` is a deprecated id for the same interface. A host SHOULD serve it in addition to `mcp.forward` under the same service id; a consumer SHOULD accept a service offering only `vscode.mcp-forward`.

> **Note.** The result carries no MCP data; the MCP session is the stream. `clientInfo` and `serverInfo` are informational; MCP's own `initialize` exchange inside the stream is authoritative.

## 2. Generated tool interfaces

A typed host serves a **generated interface** whose id MUST match:

```abnf
generated-id = "mcp.tools." name
name         = ( ALPHA-lower / DIGIT ) *( ALPHA-lower / DIGIT / "." / "-" )
ALPHA-lower  = %x61-7A
```

It has one request member per MCP tool. The member name is the tool name with `%` replaced by `%25` and `:` replaced by `%3A`. Two tools that map to the same member name MUST NOT be published together.

A member's params schema is the tool's `inputSchema`, with:

- an optional `sessionId: string` property added to every object branch (§4); a tool whose input schema already declares `sessionId`, or is not object-shaped, MUST NOT be published;
- `additionalProperties: true` on every object schema that does not specify `additionalProperties`.

A member's result is the complete MCP `CallToolResult`: an object with a required `content` array and optional `structuredContent`, `isError`, and `_meta`. When the tool declares an `outputSchema`, `structuredContent` MUST be typed by it.

Member annotations (chapter 04) are derived from MCP tool annotations with MCP's defaults: `readOnly` iff `readOnlyHint` is `true`; otherwise `dangerous` unless `destructiveHint` is `false`; `idempotent` iff `idempotentHint` is `true`.

A host MUST invoke the tool named by the member with the params minus `sessionId` and return the upstream `CallToolResult` unchanged. An MCP protocol error from the upstream MUST be returned as a linkrpc error, not as a result. Params that do not match the member's schema MUST be rejected with `invalidParams`.

When the upstream reports a changed tool list, the host MUST replace the generated interface, which changes its hash and is announced through the directory (chapter 09).

> **Note.** Callers address tools in fully-qualified form, e.g. `<serviceId>::mcp.tools.github::create_issue`. Capabilities for that member authorize exactly that tool.

## 3. `mcp.tools`

```
mcp.tools::listTools
  params: {}
  result: {
    interfaceId: string,        // the generated interface (§2)
    interfaceHash: string,      // its current hash
    tools: {
      name: string,
      method: string,           // member of interfaceId that invokes the tool
      title?: string,
      description?: string,
      inputSchema: JsonValue,   // the tool's MCP input schema, without sessionId
      outputSchema?: JsonValue,
      annotations?: object      // the tool's MCP annotations
    }[]
  }
```

`listTools` lists the tools of the current generated interface in MCP form. A consumer presenting the tools to an MCP client SHOULD invoke them through `method` of `interfaceId`, so that the host's capability checks apply per tool.

> **Rationale.** There is deliberately no generic `callTool` member: authorizing it would authorize every tool.

## 4. `mcp.server`

```
mcp.server::getState
  params: { sessionId?: string }
  result: McpServerState

mcp.server::watchState
  params: { sessionId?: string }
  result: {}
  stream (server → client): McpServerState

mcp.server::openSession
  params: {}
  result: { sessionId: string }

mcp.server::closeSession
  params: { sessionId?: string }
  result: { closed: boolean }

mcp.server::restartSession
  params: { sessionId?: string }
  result: {}
```

Tool calls without `sessionId` use the host's **shared session**. `openSession` opens an **exclusive session**, an upstream MCP session of its own, and returns its id. A host MUST generate exclusive session ids with at least 122 bits of randomness and MUST reject a `sessionId` it did not issue or has closed with `invalidParams`. `closeSession` ends the session; for an exclusive session it also invalidates the id. A host MAY end idle sessions and reopen them on the next call with the same id.

> **Note.** The session id is a bearer handle: any caller holding it can use and close the session. Capabilities still apply to every call.

`McpServerState`:

```
{
  revision: integer,                // increases with every change
  server:    { status: "starting" | "running" | "idle" | "stopping" | "stopped" | "error", error?: string },
  transport: { status: "disconnected" | "connecting" | "connected" | "error", error?: string },
  authentication:
      { status: "not-required" | "checking" }
    | { status: "authorization-required" | "authorizing", authorizationUri: string, expiresAt: string }
    | { status: "ready", identityId?: string, identityLabel?: string, tokenExpiresAt?: string }
    | { status: "error", error: string, authorizationUri?: string },
  tools:   { status: "unknown" | "loading" | "ready" | "error", interfaceId?: string, interfaceHash?: string, count?: integer, error?: string },
  session: { sessionId: string, status: "absent" | "opening" | "ready" | "closing" | "closed" | "error", error?: string }
}
```

`session` describes the session named by the request (the shared session, `""`, when omitted). `authentication` MUST NOT contain credentials.

## 5. Discovery

A consumer discovers published MCP servers through the directory (chapter 09): a service listing `mcp.tools` is typed; a service listing `mcp.forward` or `vscode.mcp-forward` is forwarded. A consumer that supports both SHOULD use a service offering both in typed mode.
