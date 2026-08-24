// CLI-only surface. The reusable hub-client primitives live in
// `@hediet/linkrpc-client` and are an internal utility — they are deliberately
// NOT re-exported here (consumers that need them import from
// `@hediet/linkrpc` / `@hediet/linkrpc-client` directly).
export * from "./mcpForward.interface";
export * from "./methodRef";
export * from "./paramParsing";
export * from "./validation";
export * from "./completions/index";
