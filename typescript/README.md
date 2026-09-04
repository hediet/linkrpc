# LinkRPC for TypeScript

| Directory | Package |
| --- | --- |
| [`packages/linkrpc/`](./packages/linkrpc) | `@hediet/linkrpc` core runtime and client APIs |
| [`packages-private/linkrpc-client/`](./packages-private/linkrpc-client) | Shared first-party client helpers (private and inlined) |
| [`packages/linkrpc-hub/`](./packages/linkrpc-hub) | `@hediet/linkrpc-hub` routing Hub |
| [`packages/linkrpc-cli/`](./packages/linkrpc-cli) | `@hediet/linkrpc-cli` generic CLI and terminal UI |
| [`packages/linkrpc-mcp/`](./packages/linkrpc-mcp) | `@hediet/linkrpc-mcp` MCP bridge |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

## Publishing

The [package artifacts workflow](../.github/workflows/package-artifacts.yml)
builds npm tarballs for the public packages on pushes to `main` and on manual
runs. ArtifactGate picks up these workflow artifacts and publishes them after
the publication is approved.
