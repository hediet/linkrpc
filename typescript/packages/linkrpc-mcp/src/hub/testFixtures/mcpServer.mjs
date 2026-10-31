import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Test MCP server with two paginated tools; also used in-process for Streamable HTTP. */
export function createTestMcpServer(transport) {
    const tools = [
        {
            name: "inspect",
            description: "Returns the serving process, transport, and the validated input.",
            inputSchema: {
                type: "object",
                properties: {
                    value: { type: "string", minLength: 1 },
                    mode: { type: "string", enum: ["brief", "full"] },
                },
                required: ["value", "mode"],
                additionalProperties: false,
            },
            outputSchema: {
                type: "object",
                properties: { value: { type: "string" }, pid: { type: "number" }, transport: { type: "string" } },
                required: ["value", "pid", "transport"],
            },
            annotations: { readOnlyHint: true },
        },
        { name: "second-page", inputSchema: { type: "object", properties: {} } },
    ];
    const server = new Server({ name: `linkrpc-mcp-${transport}-fixture`, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
        const index = Number(request.params?.cursor ?? 0);
        return { tools: [tools[index]], ...(index + 1 < tools.length ? { nextCursor: String(index + 1) } : {}) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const structuredContent = { value: String(request.params.arguments?.value ?? ""), pid: process.pid, transport };
        return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
    });
    return server;
}

if (process.argv[2] === "--stdio") {
    await createTestMcpServer("stdio").connect(new StdioServerTransport());
}
