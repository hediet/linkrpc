#!/usr/bin/env node
import { HubRpcMcpServer } from "./server";

async function main(): Promise<void> {
    const server = await HubRpcMcpServer.startStdio();
    const shutdown = () => {
        try { server.dispose(); } finally { process.exit(0); }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
    // stderr only — stdout is reserved for the MCP transport.
    process.stderr.write(`hubrpc-mcp: fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
});
