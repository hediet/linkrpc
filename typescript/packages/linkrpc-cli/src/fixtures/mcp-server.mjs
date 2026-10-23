import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'test-producer', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, request => ({
    content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }],
}));
await server.connect(new StdioServerTransport());
