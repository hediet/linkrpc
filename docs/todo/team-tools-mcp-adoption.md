# Adopting the LinkRPC MCP infrastructure in VS Code Team Tools

Team Tools (`vscode-team-tools` in
[microsoft/vscode-packages](https://github.com/microsoft/vscode-packages)) still
runs its own copies of the HubRPC packages under
`vscode-team-tools/packages/hubrpc/`. Three of them overlap with
`@hediet/linkrpc-mcp`:

| Team Tools copy | Status | Replacement |
| --- | --- | --- |
| `hubrpc-mcp` | Fork of the script server (`runLinkRpcScript`, `McpSocketHost`) | `@hediet/linkrpc-mcp`, `@hediet/linkrpc-mcp/node` |
| `hubrpc-mcp-bridge` | The original typed bridge (now the service mode); not used by the extension | `@hediet/linkrpc-mcp/hub` (`registerMcpToolBridge`, `hostMcpServer`) |
| `hubrpc-cli` `mcpForward*` | `hub mcp-forward` producer and the `vscode.mcp-forward` contract | `@hediet/linkrpc-mcp/hub` (`serveMcpForward`, `mcpForwardInterface`), `linkrpc hub mcp-forward`/`mcp-publish` |

This plan covers the MCP part only. Replacing the rest of the HubRPC copies
(hub, client, CLI) is a separate migration and a prerequisite for some steps.

## What Team Tools uses today

1. **"hubrpc Tools"** (`features/hubRpc/features/HubRpcMcpFeature.ts`): an
   `McpSocketHost` on loopback HTTP with a bearer token. Each MCP session gets a
   `LinkRpcMcpServer` whose `defaultConnection` is an in-process leg into the
   window's hub, signed by a persistent workspace-scoped managed identity.
2. **"hubrpcForwardedTools"**
   (`features/hubRpc/features/HubRpcMcpAggregator/`): its own HTTP server and
   aggregator. It attaches one **trusted** (ungated) in-process participant,
   discovers `vscode.mcp-forward` services through the hub feature's directory,
   and re-exports their tools as `<serviceId>__<toolName>`.
3. **Bundling** (`packages/extension/build.js`): QuickJS cannot be bundled, so
   the build copies the packages reachable from `quickjs-emscripten` and fails
   unless all seven QuickJS packages resolve.
4. **Producers**: `hub mcp-forward` from the HubRPC CLI copy.

## Support check

| Need | Supported by `@hediet/linkrpc-mcp` | Notes |
| --- | --- | --- |
| Script server per MCP session, in-process default connection, managed identity | Yes: `McpSocketHost` + `LinkRpcMcpServer({ defaultConnection })` | Unchanged API. Gains MCP cancellation. |
| Loopback HTTP / socket hosting with bearer token | Yes: `McpSocketHost` | |
| Aggregating forwarded servers | Yes: `HubMcpAggregator` over any signed channel | Also aggregates MCP services; accepts `mcp.forward` and `vscode.mcp-forward`. |
| Hosting an aggregator-only MCP server over HTTP | **Gap**: `McpSocketHost.createSession` can only create a `LinkRpcMcpServer` | See decision 1. |
| Trusted (ungated) aggregation | Possible: the aggregator uses whatever channel it gets | See decision 2. |
| Tool names `<serviceId>__<toolName>` | **Changes**: hashed names (`<prefix>__<sha256>`), unique and ≤ 64 characters | Saved tool references to forwarded tools break once. |
| Mixed versions during rollout | Yes | New producers serve both interface ids; the old Team Tools aggregator keeps finding them. |
| QuickJS packaging | Changed | Only `quickjs-emscripten-core`, `@jitl/quickjs-ffi-types`, and `@jitl/quickjs-wasmfile-release-sync` remain; the build walk must start from `@hediet/linkrpc-mcp`. |
| `claimHubServiceId` for configured participants (microsoft/vscode-packages#397) | **Missing in `linkrpc-hub`** | Hub migration prerequisite, not MCP. The other fixes from microsoft/vscode-packages#393 are in LinkRPC (#26, #37, #42). |

## Decisions needed

1. **One MCP provider or two.** Either merge both providers into one
   `LinkRpcMcpServer({ defaultConnection, hubTools: true })` per session (script
   tools plus aggregated tools, one VS Code MCP entry), or let
   `McpSocketHost.createSession` return any MCP server so an aggregator-only
   entry stays separate.
2. **Identity of the aggregator.** Keep the trusted ungated participant (no
   consent for forwarded tools, today's behavior), or aggregate as the
   workspace's managed identity so forwarded servers need a capability and service
   tools get per-tool consent.

## Steps

Each step is releasable on its own.

1. **Producers** (no Team Tools code change): run `linkrpc hub mcp-forward`
   (or `mcp-publish --service --forward`) from `@hediet/linkrpc-cli`.
   Acceptance: the existing Team Tools aggregator lists the new producers' tools.
2. **Script server**: replace `@vscode/hubrpc-mcp` with `@hediet/linkrpc-mcp`
   in `HubRpcMcpFeature.ts`; update `build.js` to walk the QuickJS packages from
   `@hediet/linkrpc-mcp` and require only the three remaining ones. Needs the
   in-process leg to speak LinkRPC (hub migration) or a compatible transport.
   Acceptance: `runLinkRpcScript` works in a VS Code agent session, the VSIX
   contains the release-sync WASM file, and cancelling a tool call stops the
   script.
3. **Aggregator**: replace `HubRpcMcpAggregator/` with `HubMcpAggregator` +
   `McpToolHost` (or with step 2's server, per decision 1), using the identity
   chosen in decision 2. Acceptance: forwarded servers and MCP services appear, a
   denied service tool returns a permission error, and dynamic add/remove updates
   the tool list.
4. **Cleanup**: delete `packages/hubrpc/hubrpc-mcp`,
   `packages/hubrpc/hubrpc-mcp-bridge`, and the `mcpForward*` files of
   `packages/hubrpc/hubrpc-cli`.
