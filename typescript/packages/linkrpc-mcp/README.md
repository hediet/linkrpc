# @hediet/linkrpc-mcp

Stdio MCP server that lets an LLM drive a [linkrpc](../linkrpc) hub.

## Tools

### `runLinkRpcScript`

Evaluates a JS function inside a [QuickJS](https://github.com/justjake/quickjs-emscripten) sandbox (~5 s CPU, ~32 MB memory) with these globals in scope:

| Name                     | Description                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `con`                    | Live hub connection — see the `connection.d.ts` resource for the full signature. Covers `con.call`, `con.notify`, `con.callRaw`, `con.notifyRaw`, **and `con.explore(...)`** for service discovery. |
| `lastResultVal`          | The previous `runLinkRpcScript` result against the same hub. JSON round-tripped. `undefined` on the first call.                                                                                      |
| `mcp`                    | Optional result-presentation helpers: `raw`, `text`, `image`, `audio`, `resource`, `resourceLink`, `content`, and `result`.                                                                         |
| `console.log/warn/error` | Captured and returned alongside the result.                                                                                                                                                         |

`code` must evaluate to a function:

```js
({ con }) => con.call("vscode", "vscode.window",
                      "showInformationMessage",
                      { message: "hello world" })
```

Set `connection` to a hub endpoint URI (e.g. `unix:/path?token=…`, `npipe://./pipe/…?token=…`, or `wss://host?token=…`) to target a specific hub, or omit it to use the `LINKRPC_ENDPOINT` / `LINKRPC_TOKEN` env vars (set by the team-tools extension on every terminal). The token may be embedded in the URI or supplied via `LINKRPC_TOKEN`.

#### Result presentation

Return values remain unchanged while the script runs, when passed to another hub
service, and when stored in `lastResultVal`. At the final MCP boundary, the server
automatically recognizes:

- MCP text, image, audio, embedded-resource, and resource-link blocks;
- `data:` URLs;
- common image/audio/document base64 signatures;
- `{ data|base64|blob, mimeType }` and `{ text, mimeType }` objects.

Recognized values become native MCP content blocks. Their base64 is replaced in the
JSON text and `structuredContent` fallbacks by a small descriptor. Set
`presentation: "raw"` on `runLinkRpcScript`, `awaitLinkRpcTask`, or
`cancelLinkRpcTask` to expose the original JSON, or selectively return
`mcp.raw(value)`.

Explicit content needs little ceremony:

```js
({ mcp }) => mcp.result({
    value: { width: 800, height: 600 },
    content: [
        mcp.image(pngBase64, "image/png"),
        mcp.resourceLink({
            uri: "file:///report.pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
        }),
    ],
})
```

The `mcp.*` values are presentation markers intended to be returned from the
script. Keep using the original value for intermediate hub calls.

#### Cancellation

Cancelling a `runLinkRpcScript` request while it runs in the foreground soft-aborts
the script and cancels its in-flight hub calls. Cancelling `awaitLinkRpcTask` only
stops waiting; use `cancelLinkRpcTask` to stop a parked task.

### Embedding options

`LinkRpcMcpServer` also accepts:

- `hubTools`: additionally list the tools of MCP servers published on the default
  connection's hub (see below), next to the script tools.
- `maxHubResultBytes`: reject hub results above this size before they enter the
  sandbox.
- `pool`, `provider`, `defaultConnection`: choose how sessions reach the hub. Use
  `singleConnectionPool` with a `DelegatedHubSender` to bind a server instance to
  one delegated principal.

## Running locally

```jsonc
// .vscode/mcp.json
{
    "servers": {
        "linkrpc": {
            "command": "npx",
            "args": ["@hediet/linkrpc-mcp"]
        }
    }
}
```

## MCP servers on a hub (`@hediet/linkrpc-mcp/hub`)

This entry point does not load the sandbox. It implements
[spec chapter 10](../../../spec/10-mcp-interfaces.md).

An **upstream** is one MCP server transport plus its authentication:
`stdioUpstream({ command, args })` or `httpUpstream({ url, headers, fetch })`. A
custom `fetch` attaches and refreshes access tokens.

Publish an upstream with `hostMcpServer` in one or both modes:

| Mode | MCP sessions | On the hub | Capabilities | MCP features |
| --- | --- | --- | --- | --- |
| service | one shared session; exclusive sessions on request | one method per tool on `mcp.tools.<name>[.<group>]`, plus `mcp.tools` (`listTools`, `callTool`) and `mcp.server` | per tool or group | tools |
| forward | one upstream session per `connect` | `mcp.forward` (and the legacy `vscode.mcp-forward`) | per server | all, relayed verbatim |

```ts
const hosted = await hostMcpServer({
    connection,
    serviceId: "me/github",
    server: mcpServerConfigSchema.parse({
        id: "github",
        transport: { kind: "streamable-http", url: "https://api.example.com/mcp" },
        expose: {
            // Tools whose name contains "delete" or "merge" go to `mcp.tools.github.admin`.
            service: { groups: [{ name: "admin", keywords: ["delete", "merge"] }] },
            forward: {},
        },
    }),
    fetch: fetchWithAccessToken,
});
```

Groups are matched in order; a tool joins the first group listing its name
(`tools`), a prefix of it (`prefixes`), or a case-insensitive substring of it
(`keywords`). A capability for the exact interface `mcp.tools.github` then excludes
the `admin` tools. `mcp.tools::callTool` calls any tool by name; narrow a
capability for it with a `name` parameter matcher.

The building blocks are also exported individually: `registerMcpToolBridge`
(service), `serveMcpForward` (forward), `serveMcpForwardInstance` (forwards one
running MCP server, e.g. on this process's stdio via `streamInstanceTransport`,
to one connection at a time), and `McpForwardClientTransport`, an MCP SDK client
transport that opens one forwarded leg.

Service callers share one upstream session. A caller that needs its own (for a
stateful server) calls `mcp.server::openSession` and passes the returned
unguessable `sessionId` to tool methods.

`HubMcpAggregator` discovers every MCP service and forwarded server visible
through a signed channel and is an `McpToolSource`; `McpToolHost` serves tool
sources on an MCP SDK `Server`. Service tools are called through their generated
methods, so the
hub's per-tool capabilities and consent apply. `linkrpc hub mcp` and the
`hubTools` option are built from these.

`DelegatedHubSender` signs calls as a delegated principal over a channel it does
not own, for services that act for many users, chats, or OAuth grants over one
hub connection. Granted capabilities are persisted through `onGranted`.

Not yet supported: aggregation of resources and prompts, server-to-client
requests (sampling, elicitation, roots) through the aggregator, and shared
forwarding.
