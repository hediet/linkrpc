/**
 * `@hediet/linkrpc-client` — the reusable hub-client primitives shared by the
 * `linkrpc` CLI and the `linkrpc-mcp` server: endpoint resolution, connecting,
 * hub signing, principal/identity handling, and hub reflection. Deliberately
 * free of any command-line / terminal-UI concerns so non-CLI consumers can
 * depend on it without pulling in `commander`, `ink`, React, etc.
 */
export * from "./endpoint";
export * from "./connect";
export * from "./config";
export * from "./localHub";
export * from "./principal";
export * from "./identity";
export * from "./reflection";
export * from "./hubSigning";
