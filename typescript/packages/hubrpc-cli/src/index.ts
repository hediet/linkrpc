// CLI-only surface. The reusable hub-client primitives live in
// `@vscode/hubrpc-client` and are an internal utility — they are deliberately
// NOT re-exported here (consumers that need them import from
// `@vscode/hubrpc` / `@vscode/hubrpc-client` directly).
export * from "./mcpForward.interface";
export * from "./methodRef";
export * from "./paramParsing";
export * from "./validation";
export * from "./completions/index";
