/**
 * Walkthrough of `@hediet/linkrpc-mcp/hub`, as a test against a real in-process
 * hub that checks capabilities. Read it top to bottom; every snapshot is what
 * the participant in that step actually sees.
 *
 * Cast:
 * - the hub admin, who issues capabilities;
 * - a host, which publishes the stateful stdio MCP server
 *   `testFixtures/notesServer.mjs` under service id `notes`, both as a service
 *   and forwarded;
 * - Alice and Bob, hub clients calling the tools as LinkRPC methods;
 * - an agent, an MCP client that sees the hub through `HubMcpAggregator` (what
 *   `linkrpc hub mcp` runs), through `mcp.forward`, and through the script tools;
 * - a second host publishing the same server under `journal` with two accounts
 *   (MCP identities), `work` and `home`.
 */
import { spawn } from "node:child_process";
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
import { serveMcpForwardInstance, streamInstanceTransport } from "./forward/instance";
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
    // `linkrpc hub mcp-publish --service --forward --group danger=clear -- node notesServer.mjs`
    // or an entry in personal-bot's mcp-participant config.
    hosted = await hostMcpServer({
        connection: world.hostConnection,
        serviceId: "notes",
        server: mcpServerConfigSchema.parse({
            id: "notes",
            description: "A notes MCP server",
            transport: { kind: "stdio", command: process.execPath, args: [notesServer] },
            // Tools whose name contains "clear" get their own interface, so a
            // capability can cover `mcp.tools.notes` without them.
            expose: { service: { groups: [{ name: "danger", keywords: ["clear"] }] }, forward: {} },
        }),
        log: () => {},
    });
});

afterAll(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    await hosted.dispose();
});

describe("MCP servers on a LinkRPC hub", () => {
    it("1. the host publishes the MCP server as a service and forwarded under one service id", async () => {
        const admin = await world.client("admin", [allOf("notes")]);

        const directory = await admin.call("notes::hubrpc.directory::list", {}) as {
            items: { interfaceId: string }[];
        };
        expect(directory.items.map((item) => item.interfaceId)).toMatchInlineSnapshot(`
          [
            "hubrpc.defaults",
            "hubrpc.directory",
            "hubrpc.schemas",
            "mcp.identities",
            "mcp.forward",
            "vscode.mcp-forward",
            "mcp.tools",
            "mcp.server",
            "mcp.tools.notes",
            "mcp.tools.notes.danger",
          ]
        `);

        // The generated interfaces have one method per MCP tool. A method's schema
        // is the tool's input schema plus `sessionId`; MCP hints become LinkRPC
        // annotations.
        const catalog = await admin.call("notes::mcp.tools::listTools", {}) as {
            interfaces: { interfaceId: string; interfaceHash: string; toolCount: number }[];
            tools: { name: string; interfaceId: string; method: string }[];
        };
        expect(catalog.tools.map((tool) => `${tool.name} -> ${tool.interfaceId}::${tool.method}`))
            .toMatchInlineSnapshot(`
              [
                "add_note -> mcp.tools.notes::add_note",
                "list_notes -> mcp.tools.notes::list_notes",
                "clear_notes -> mcp.tools.notes.danger::clear_notes",
              ]
            `);
        const notesInterface = catalog.interfaces.find((entry) => entry.interfaceId === "mcp.tools.notes")!;
        const schema = await admin.call("notes::hubrpc.schemas::get", {
            interfaceId: notesInterface.interfaceId,
            hash: notesInterface.interfaceHash,
        }) as { schema: { methods: Record<string, { params: unknown; annotations?: unknown }> } };
        expect(schema.schema.methods.add_note).toMatchInlineSnapshot(`
          {
            "description": "Add a note.",
            "params": {
              "additionalProperties": true,
              "properties": {
                "mcpIdentity": {
                  "description": "MCP identity (account) from mcp.identities::list. Omitted means the default identity.",
                  "type": "string",
                },
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
                "list_notes": {
                  "readOnly": true,
                },
              }
            `);
    });

    it("2. service: every hub client calls tools as LinkRPC methods on one shared MCP session", async () => {
        const noteTools = [allMembers("notes", "mcp.tools.notes")];
        const alice = await world.client("alice", noteTools);
        const bob = await world.client("bob", noteTools);

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

        // The grouped tool is not covered by a capability for `mcp.tools.notes`.
        expect(await errorOf(alice.call("notes::mcp.tools.notes.danger::clear_notes", {})))
            .toMatchInlineSnapshot(`
              {
                "code": -32401,
                "message": "permission does not address this call: interfaceId "mcp.tools.notes.danger" does not match exact "mcp.tools.notes"",
              }
            `);
    });

    it("3. service: generic `mcp.tools::callTool` calls any tool by name", async () => {
        // For clients that do not generate code from interfaces. One capability
        // for `callTool` covers every tool of the server, whatever its group.
        const generic = await world.client("generic", [members("notes", "mcp.tools", ["listTools", "callTool"])]);
        expect(text(await generic.call("notes::mcp.tools::callTool", { name: "list_notes" })))
            .toMatchInlineSnapshot(`"["from Alice","from Bob"]"`);
        expect(await errorOf(generic.call("notes::mcp.tools::callTool", { name: "no_such_tool" })))
            .toMatchInlineSnapshot(`
              {
                "code": -32602,
                "message": "Unknown MCP tool: no_such_tool",
              }
            `);

        // A parameter matcher narrows `callTool` to named tools. Matchers list
        // every parameter, so the call must pass `arguments`.
        const reader = await world.client("reader", [{
            ...members("notes", "mcp.tools", ["callTool"]),
            params: { name: { exact: "list_notes" }, arguments: { any: true } },
        }]);
        expect(text(await reader.call("notes::mcp.tools::callTool", { name: "list_notes", arguments: {} })))
            .toMatchInlineSnapshot(`"["from Alice","from Bob"]"`);
        expect(await errorOf(reader.call("notes::mcp.tools::callTool", { name: "clear_notes", arguments: {} })))
            .toMatchInlineSnapshot(`
              {
                "code": -32401,
                "message": "params: param "name" does not match",
              }
            `);
    });

    it("4. service: an exclusive session is a separate MCP session (here: a separate process)", async () => {
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

    it("5. service: capabilities apply per tool", async () => {
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
                "text": "permission does not address this call: interfaceId "mcp.tools.notes.danger" does not match exact "mcp.tools.notes"",
                "type": "text",
              },
            ],
            "isError": true,
          }
        `);
    });

    it("6. forward: verbatim MCP, one capability per server, own MCP session per connection", async () => {
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
        // the service mode does not carry, such as resources.
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
        // shared service session is unaffected.
        const alice = await world.client("alice", [allMembers("notes", "mcp.tools.notes")]);
        expect(text(await alice.call("notes::mcp.tools.notes::list_notes", {}))).toMatchInlineSnapshot(`"["from Alice","from Bob"]"`);
    });

    it("7. forward a running MCP server: one connection at a time, same process", async () => {
        // `linkrpc hub mcp-forward --stdio` attached to an MCP server that is
        // already running (here: a child process whose stdio we hold).
        const running = spawn(process.execPath, [notesServer], { stdio: ["pipe", "pipe", "inherit"] });
        const instance = serveMcpForwardInstance({
            connection: world.runningConnection,
            serviceId: "running",
            transport: streamInstanceTransport(running.stdout, running.stdin),
        });
        cleanup.push(() => { instance.dispose(); running.kill(); });
        const agent = await world.client("instance-agent", [members("running", "mcp.forward", ["connect"])]);

        const first = await connectForwarded(agent.sender, "running");
        await first.callTool({ name: "add_note", arguments: { text: "kept by the running server" } });
        // While one connection is open, the next is turned away ("in use"; the MCP
        // SDK client only reports the closed connection).
        expect(await errorOf(connectForwarded(agent.sender, "running"))).toMatchInlineSnapshot(`
          {
            "code": -32000,
            "message": "MCP error -32000: Connection closed",
          }
        `);
        await first.close();

        // A later connection reaches the same process, so the state is still there.
        const second = await connectForwarded(agent.sender, "running");
        expect(text(await second.callTool({ name: "list_notes" }))).toMatchInlineSnapshot(`"["kept by the running server"]"`);
    });

    it("8. identities: one server, several accounts; a capability can pin the account", async () => {
        // An MCP identity is one account: here an env var per stdio process, for
        // HTTP servers a token per account (`oauthMcpIdentities`). In production:
        // `linkrpc hub mcp-publish --config journal.json`.
        const journal = await hostMcpServer({
            connection: world.journalConnection,
            serviceId: "journal",
            server: mcpServerConfigSchema.parse({
                id: "journal",
                transport: { kind: "stdio", command: process.execPath, args: [notesServer] },
                identities: [
                    { id: "work", env: { NOTES_OWNER: "work" } },
                    { id: "home", default: true, env: { NOTES_OWNER: "home" } },
                ],
                expose: { service: {}, forward: {} },
            }),
            log: () => {},
        });
        cleanup.push(() => journal.dispose());

        const admin = await world.client("journal-admin", [allOf("journal")]);
        expect(await admin.call("journal::mcp.identities::list", {})).toMatchInlineSnapshot(`
          {
            "identities": [
              {
                "authentication": {
                  "status": "not-required",
                },
                "default": false,
                "id": "work",
              },
              {
                "authentication": {
                  "status": "not-required",
                },
                "default": true,
                "id": "home",
              },
            ],
          }
        `);
        // Calls select the account with `mcpIdentity`; omitted means the default.
        expect({
            work: text(await admin.call("journal::mcp.tools.journal::add_note", { text: "standup", mcpIdentity: "work" })),
            home: text(await admin.call("journal::mcp.tools.journal::add_note", { text: "groceries" })),
        }).toMatchInlineSnapshot(`
          {
            "home": "home: ["groceries"]",
            "work": "work: ["standup"]",
          }
        `);

        // A capability pins the account with a parameter matcher. Matchers list
        // every parameter of the call, the tool's own with `any`.
        const assistant = await world.client("work-assistant", [{
            ...members("journal", "mcp.tools.journal", ["add_note"]),
            params: { mcpIdentity: { exact: "work" }, text: { any: true } },
        }]);
        expect(text(await assistant.call("journal::mcp.tools.journal::add_note", { mcpIdentity: "work", text: "review" })))
            .toMatchInlineSnapshot(`"work: ["standup","review"]"`);
        expect({
            otherAccount: await errorOf(assistant.call("journal::mcp.tools.journal::add_note", { mcpIdentity: "home", text: "x" })),
            defaultAccount: await errorOf(assistant.call("journal::mcp.tools.journal::add_note", { text: "x" })),
        }).toMatchInlineSnapshot(`
          {
            "defaultAccount": {
              "code": -32401,
              "message": "params: param keys mismatch (declared=mcpIdentity,text, actual=text)",
            },
            "otherAccount": {
              "code": -32401,
              "message": "params: param "mcpIdentity" does not match",
            },
          }
        `);

        // `linkrpc hub mcp --mcp-identity journal=work` aggregates with that account.
        const agent = await world.client("journal-agent", [
            reflection("hub"),
            reflection("journal"),
            members("journal", "mcp.tools", ["listTools"]),
            {
                ...members("journal", "mcp.tools.journal", ["list_notes"]),
                params: { mcpIdentity: { exact: "work" } },
            },
        ]);
        const aggregator = new HubMcpAggregator(agent.sender, {
            log: () => {},
            mcpIdentityFor: (serviceId) => serviceId === "journal" ? "work" : undefined,
        });
        const server = new Server({ name: "hub-mcp", version: "1" }, { capabilities: { tools: { listChanged: true } } });
        new McpToolHost(server).addSource(aggregator);
        const mcp = await connectMcp(server, () => aggregator.dispose());
        await until(async () => (await mcp.listTools()).tools.length > 0);
        const listNotes = (await mcp.listTools()).tools.find((tool) => tool.description === "[journal] List all notes.")!;
        expect(text(await mcp.callTool({ name: listNotes.name }))).toMatchInlineSnapshot(`"work: ["standup","review"]"`);
    });

    it("9. scripts: one MCP server with the script tools and the hub's MCP tools", async () => {
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
    const runningHost = hubRegisterServiceId(hub, "running");
    const journalHost = hubRegisterServiceId(hub, "journal");
    cleanup.push(() => host.dispose(), () => runningHost.dispose(), () => journalHost.dispose());
    let seed = 10;

    return {
        hostConnection: host.connection,
        runningConnection: runningHost.connection,
        journalConnection: journalHost.connection,

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

async function connectForwarded(sender: HubSigningSender, serviceId = "notes"): Promise<Client> {
    const client = new Client({ name: "demo-agent", version: "1" });
    await client.connect(new McpForwardClientTransport(sender, serviceId));
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

async function until(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    while (!(await condition())) {
        if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}
