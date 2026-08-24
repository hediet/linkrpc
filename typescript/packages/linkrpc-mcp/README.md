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

## Resources

### `linkrpc-mcp://docs/connection.d.ts`

TypeScript declarations for the in-sandbox API (`con`, `console`, `lastResultVal`). Read this once before authoring `runLinkRpcScript` calls.

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
