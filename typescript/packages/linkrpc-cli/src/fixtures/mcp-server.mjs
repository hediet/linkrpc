import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'test-producer', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, request => ({
    content: [{
        type: 'text',
        text: JSON.stringify({
            ...request.params.arguments,
            // The account this process was started for (MCP identity tests).
            ...(process.env.MCP_TEST_ACCOUNT !== undefined ? { account: process.env.MCP_TEST_ACCOUNT } : {}),
        }),
    }],
}));
await server.connect(new StdioServerTransport());
