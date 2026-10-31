/**
 * Walkthrough of `@hediet/linkrpc-mcp/hub`, as a test against a real in-process
 * hub that checks capabilities. Read it top to bottom; every snapshot is what
 * the participant in that step actually sees.
 *
 * Cast:
 * - the hub admin, who issues capabilities;
 * - a host, which publishes the stateful stdio MCP server
 *   `testFixtures/notesServer.mjs` under service id `notes`, both typed and
 *   forwarded;
 * - Alice and Bob, hub clients calling the typed tools as LinkRPC methods;
 * - an agent, an MCP client that sees the hub through `HubMcpAggregator` (what
 *   `linkrpc hub mcp` runs), through `mcp.forward`, and through the script tools.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    createSeededMemoryPrincipal,
    createSeededSigningIdentity,
    issueCapability,
    type JsonValue,
    type Pattern,
    TransportPair,
} from "@hediet/linkrpc";
import { HubSigningSender } from "@hediet/linkrpc/hub/client";
import {
    createHubServiceInterfaces,
    Hub,
    hubRegisterServiceId,
    registerHubServices,
    RootOverlay,
    withForwardedCallGate,
    withVerifiedSignature,
} from "@hediet/linkrpc-hub/hub/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { LinkRpcMcpServer } from "../server";
import { HubMcpAggregator } from "./aggregate/aggregator";
import { McpForwardClientTransport } from "./forward/clientTransport";
import { type HostedMcpServer, hostMcpServer, mcpServerConfigSchema } from "./host";
import { singleConnectionPool } from "./identity";
import { McpToolHost } from "./toolHost";

const notesServer = fileURLToPath(new URL("./testFixtures/notesServer.mjs", import.meta.url));

let world: Awaited<ReturnType<typeof createWorld>>;
let hosted: HostedMcpServer;
const cleanup: Array<() => unknown> = [];

beforeAll(async () => {
    world = await createWorld();

    // The host publishes one MCP server in both modes. In production this is
    // `linkrpc hub mcp-publish --typed --forward -- node notesServer.mjs` or an
    // entry in personal-bot's mcp-participant config.
    hosted = await hostMcpServer({
        connection: world.hostConnection,
        serviceId: "notes",
        server: mcpServerConfigSchema.parse({
            id: "notes",
            description: "A notes MCP server",
            transport: { kind: "stdio", command: process.execPath, args: [notesServer] },
            expose: { typed: {}, forward: {} },
        }),
        log: () => {},
    });
});

afterAll(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    await hosted.dispose();
});

describe("MCP servers on a LinkRPC hub", () => {
    it("1. the host publishes a typed and a forwarded interface under one service id", async () => {
        const admin = await world.client("admin", [allOf("notes")]);

        const directory = await admin.call("notes::hubrpc.directory::list", {}) as {
            items: { interfaceId: string }[];
        };
        expect(directory.items.map((item) => item.interfaceId)).toMatchInlineSnapshot(`
          [
            "hubrpc.defaults",
            "hubrpc.directory",
            "hubrpc.schemas",
            "mcp.forward",
            "vscode.mcp-forward",
            "mcp.tools",
            "mcp.server",
            "mcp.tools.notes",
          ]
        `);

        // `mcp.tools.notes` has one method per MCP tool. Its schema is the tool's
        // input schema plus `sessionId`; MCP hints become LinkRPC annotations.
        const catalog = await admin.call("notes::mcp.tools::listTools", {}) as {
            interfaceId: string;
            interfaceHash: string;
            tools: { name: string; method: string }[];
        };
        expect(catalog.tools.map((tool) => `${tool.name} -> ${catalog.interfaceId}::${tool.method}`))
            .toMatchInlineSnapshot(`
              [
                "add_note -> mcp.tools.notes::add_note",
                "list_notes -> mcp.tools.notes::list_notes",
                "clear_notes -> mcp.tools.notes::clear_notes",
              ]
            `);
        const schema = await admin.call("notes::hubrpc.schemas::get", {
            interfaceId: catalog.interfaceId,
            hash: catalog.interfaceHash,
        }) as { schema: { methods: Record<string, { params: unknown; annotations?: unknown }> } };
        expect(schema.schema.methods.add_note).toMatchInlineSnapshot(`
          {
            "description": "Add a note.",
            "params": {
              "additionalProperties": true,
              "properties": {
                "sessionId": {
                  "description": "Exclusive bridge session from mcp.server::openSession. Omitted means the shared session.",
                  "type": "string",
                },
                "text": {
                  "type": "string",
                },
              },
              "required": [
                "text",
              ],
              "type": "object",
            },
            "result": {
              "additionalProperties": true,
              "properties": {
                "_meta": true,
                "content": {
                  "items": true,
                  "type": "array",
                },
                "isError": {
                  "type": "boolean",
                },
              },
              "required": [
                "content",
              ],
              "type": "object",
            },
          }
        `);
        expect(Object.fromEntries(Object.entries(schema.schema.methods)
            .map(([name, method]) => [name, method.annotations ?? {}]))).toMatchInlineSnapshot(`
              {
                "add_note": {},
                "clear_notes": {
                  "dangerous": true,
                },
                "list_notes": {
                  "readOnly": true,
                },
              }
            `);
    });

    it("2. typed: every hub client calls tools as LinkRPC methods on one shared MCP session", async () => {
        const typedTools = [allMembers("notes", "mcp.tools.notes")];
        const alice = await world.client("alice", typedTools);
        const bob = await world.client("bob", typedTools);

        await alice.call("notes::mcp.tools.notes::add_note", { text: "from Alice" });
        // The result is the complete MCP CallToolResult.
        expect(await bob.call("notes::mcp.tools.notes::add_note", { text: "from Bob" }))
            .toMatchInlineSnapshot(`
              {
                "content": [
                  {
                    "text": "["from Alice","from Bob"]",
                    "type": "text",
                  },
                ],
              }
            `);
    });

    it("3. typed: an exclusive session is a separate MCP session (here: a separate process)", async () => {
        const alice = await world.client("alice", [
            allMembers("notes", "mcp.tools.notes"),
            allMembers("notes", "mcp.server"),
        ]);

        const { sessionId } = await alice.call("notes::mcp.server::openSession", {}) as { sessionId: string };
        await alice.call("notes::mcp.tools.notes::add_note", { sessionId, text: "private" });

        expect({
            exclusive: text(await alice.call("notes::mcp.tools.notes::list_notes", { sessionId })),
            shared: text(await alice.call("notes::mcp.tools.notes::list_notes", {})),
        }).toMatchInlineSnapshot(`
          {
            "exclusive": "["private"]",
            "shared": "["from Alice","from Bob"]",
          }
        `);

        // Session ids are minted by the bridge, so they cannot be guessed or chosen.
        expect(await errorOf(alice.call("notes::mcp.tools.notes::list_notes", { sessionId: "bobs-session" })))
            .toMatchInlineSnapshot(`
              {
                "code": -32602,
                "message": "Unknown or closed MCP bridge session",
              }
            `);
        await alice.call("notes::mcp.server::closeSession", { sessionId });
    });

    it("4. typed: capabilities apply per tool", async () => {
        // The agent may discover services and read notes, but not add or clear
        // them. (On a real hub, `linkrpc hub mcp` requests directory access
        // through consent instead of holding it up front.)
        const agent = await world.client("agent", [
            reflection("hub"),
            reflection("notes"),
            members("notes", "mcp.tools", ["listTools"]),
            members("notes", "mcp.tools.notes", ["list_notes"]),
        ]);

        // `linkrpc hub mcp` = HubMcpAggregator + McpToolHost on stdio. Here it is
        // served over an in-memory MCP transport.
        const mcp = await aggregatedMcpClient(agent.sender);
        // All tools of the catalog are listed with their MCP annotations, including
        // tools the agent may not call yet: access can still be granted on demand.
        // Names are `<prefix>__<hash of service id and tool>`; the description
        // names the service.
        const { tools } = await mcp.listTools();
        expect(tools.map((tool) => ({ description: tool.description, annotations: tool.annotations })))
            .toMatchInlineSnapshot(`
              [
                {
                  "annotations": {
                    "destructiveHint": false,
                  },
                  "description": "[notes] Add a note.",
                },
                {
                  "annotations": {
                    "readOnlyHint": true,
                  },
                  "description": "[notes] List all notes.",
                },
                {
                  "annotations": undefined,
                  "description": "[notes] Delete all notes.",
                },
              ]
            `);

        const listNotes = tools.find((tool) => tool.description === "[notes] List all notes.")!;
        const clearNotes = tools.find((tool) => tool.description === "[notes] Delete all notes.")!;
        expect(await mcp.callTool({ name: listNotes.name })).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "text": "["from Alice","from Bob"]",
                "type": "text",
              },
            ],
          }
        `);
        expect(await mcp.callTool({ name: clearNotes.name })).toMatchInlineSnapshot(`
          {
            "content": [
              {
                "text": "permission does not address this call: member "clear_notes" does not match allowed patterns [exact "list_notes"]",
                "type": "text",
              },
            ],
            "isError": true,
          }
        `);
    });

    it("5. forward: verbatim MCP, one capability per server, own MCP session per connection", async () => {
        // Without `mcp.forward::connect`, the hub rejects the connection. An MCP SDK
        // client only reports the closed connection; the permission error goes to
        // the transport's `onerror`, which `linkrpc hub mcp` logs to stderr.
        const stranger = await world.client("stranger", []);
        expect(await errorOf(connectForwarded(stranger.sender))).toMatchInlineSnapshot(`
          {
            "code": -32000,
            "message": "MCP error -32000: Connection closed",
          }
        `);

        // With it, the agent gets the whole MCP server: every tool, and features
        // the typed mode does not carry, such as resources.
        const agent = await world.client("forwarding-agent", [members("notes", "mcp.forward", ["connect"])]);
        const mcp = await connectForwarded(agent.sender);
        expect((await mcp.listTools()).tools.map((tool) => tool.name)).toMatchInlineSnapshot(`
          [
            "add_note",
            "list_notes",
            "clear_notes",
          ]
        `);
        await mcp.callTool({ name: "add_note", arguments: { text: "via forward" } });
        expect(await mcp.readResource({ uri: "notes://all" })).toMatchInlineSnapshot(`
          {
            "contents": [
              {
                "mimeType": "text/plain",
                "text": "via forward",
                "uri": "notes://all",
              },
            ],
          }
        `);

        // That connection has its own process (closed with the connection): the
        // shared typed session is unaffected.
        const alice = await world.client("alice", [allMembers("notes", "mcp.tools.notes")]);
        expect(text(await alice.call("notes::mcp.tools.notes::list_notes", {}))).toMatchInlineSnapshot(`"["from Alice","from Bob"]"`);
    });

    it("6. scripts: one MCP server with the script tools and the hub's MCP tools", async () => {
        // `linkrpc hub mcp --scripts`: the three script tools, then the aggregated
        // MCP tools. Scripts can call any hub service the principal may call,
        // including the generated MCP tool methods.
        const agent = await world.client("script-agent", [
            reflection("hub"),
            reflection("notes"),
            members("notes", "mcp.tools", ["listTools"]),
            members("notes", "mcp.tools.notes", ["list_notes"]),
        ]);
        const server = new LinkRpcMcpServer({
            pool: singleConnectionPool(agent.sender, agent.sender, "demo"),
            hubTools: { log: () => {} },
        });
        const mcp = await connectMcp(server, () => server.dispose());

        expect((await mcp.listTools()).tools.map((tool) => tool.description?.split("\n")[0].slice(0, 60)))
            .toMatchInlineSnapshot(`
              [
                "Evaluate a JS function inside a QuickJS sandbox with \`con\` (",
                "Wait up to \`timeoutMs\` for a background task started by \`run",
                "Soft-abort a background task started by \`runLinkRpcScript\` a",
                "[notes] Add a note.",
                "[notes] List all notes.",
                "[notes] Delete all notes.",
              ]
            `);
        const result = await mcp.callTool({
            name: "runLinkRpcScript",
            arguments: {
                code: `async ({ con }) => {
                    const result = await con.call("notes", "mcp.tools.notes", "list_notes", {});
                    return JSON.parse(result.content[0].text).length + " notes";
                }`,
            },
        });
        expect(JSON.parse(text(result))).toMatchInlineSnapshot(`
          {
            "endpoint": "demo",
            "logs": [],
            "result": "2 notes",
            "status": "completed",
          }
        `);
    });
});

// ---------------------------------------------------------------------------
// Setup: a real hub whose client links require admin-rooted capabilities.

async function createWorld() {
    const issuer = await createSeededSigningIdentity({ seed: 1 });
    const hub = new Hub();
    createHubServiceInterfaces(hub);
    const host = hubRegisterServiceId(hub, "notes");
    cleanup.push(() => host.dispose());
    let seed = 10;

    return {
        hostConnection: host.connection,

        /** A hub client signing as a fresh principal holding `permissions`. */
        async client(_name: string, permissions: Permission[]) {
            const principal = await createSeededMemoryPrincipal({ seed: seed++ });
            if (permissions.length > 0) {
                await principal.capBag.add(await issueCapability(issuer, {
                    audience: principal.identity.publicSigningIdentity,
                    expiresAtMs: Date.now() + 60_000,
                    permissions,
                }));
            }
            const hubPair = new TransportPair();
            const upstream = hub.attach(withForwardedCallGate(hubPair.b, {
                requireCapability: true,
                acceptedRootIssuers: () => [{ principal: issuer.publicSigningIdentity.principal, isPublic: true }],
            }));
            const overlay = new RootOverlay({ uplink: hubPair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: "hub" });
            const appPair = new TransportPair();
            overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));
            const sender = HubSigningSender.create(appPair.b, principal);
            cleanup.push(() => sender.close());
            return {
                sender,
                call: (method: string, params: JsonValue) => sender.sendRequest(method, params),
            };
        },
    };
}

type Permission = Parameters<typeof issueCapability>[1]["permissions"][number];

function members(serviceId: string, interfaceId: string, names: string[]): Permission {
    return target(serviceId, { exact: interfaceId }, names.map((exact) => ({ exact })));
}

function allMembers(serviceId: string, interfaceId: string): Permission {
    return target(serviceId, { exact: interfaceId }, [{ prefix: "" }]);
}

function reflection(serviceId: string): Permission {
    return target(serviceId, { prefix: "hubrpc" }, [{ prefix: "" }]);
}

function allOf(serviceId: string): Permission {
    return target(serviceId, { prefix: "" }, [{ prefix: "" }]);
}

function target(serviceId: string, interfaceId: Pattern, memberPatterns: Pattern[]): Permission {
    return {
        target: { serviceId: { exact: serviceId }, interfaceId, members: memberPatterns },
        canInvoke: true,
    };
}

async function aggregatedMcpClient(sender: HubSigningSender): Promise<Client> {
    const aggregator = new HubMcpAggregator(sender, { log: () => {} });
    const server = new Server({ name: "hub-mcp", version: "1" }, { capabilities: { tools: { listChanged: true } } });
    new McpToolHost(server).addSource(aggregator);
    return connectMcp(server, () => aggregator.dispose());
}

async function connectMcp(server: Pick<Server, "connect">, dispose: () => unknown): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "demo-agent", version: "1" });
    await client.connect(clientTransport);
    cleanup.push(dispose, () => client.close());
    return client;
}

async function connectForwarded(sender: HubSigningSender): Promise<Client> {
    const client = new Client({ name: "demo-agent", version: "1" });
    await client.connect(new McpForwardClientTransport(sender, "notes"));
    cleanup.push(() => client.close());
    return client;
}

function text(result: unknown): string {
    return (result as { content: { text: string }[] }).content[0].text;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
        return "no error";
    } catch (error) {
        const { code, message } = error as { code?: number; message: string };
        return code === undefined ? message : { code, message };
    }
}
