import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// A stateful stdio MCP server: notes live in this process, so every MCP session
// that gets its own process also gets its own notes.
const notes = [];

const tools = [
    {
        name: "add_note",
        description: "Add a note.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        annotations: { destructiveHint: false },
    },
    {
        name: "list_notes",
        description: "List all notes.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
    },
    {
        name: "clear_notes",
        description: "Delete all notes.",
        inputSchema: { type: "object", properties: {} },
    },
];

const server = new Server(
    { name: "notes", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === "add_note") notes.push(String(params.arguments?.text));
    if (params.name === "clear_notes") notes.length = 0;
    // NOTES_OWNER is set per account by the demo's MCP identities.
    const owner = process.env.NOTES_OWNER;
    const text = JSON.stringify(notes);
    return { content: [{ type: "text", text: owner === undefined ? text : `${owner}: ${text}` }] };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "notes://all", name: "All notes", mimeType: "text/plain" }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({
    contents: [{ uri: "notes://all", mimeType: "text/plain", text: notes.join("\n") }],
}));

await server.connect(new StdioServerTransport());
