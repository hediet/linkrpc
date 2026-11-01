import { describe, expect, it } from "vitest";
import {
    directoryInterface,
    type JsonValue,
    LinkRpcConnection,
    schemasInterface,
    TransportPair,
} from "@hediet/linkrpc";
import type {
    McpClientSession,
    McpSessionFactory,
    McpToolDefinition,
    OpenMcpSessionContext,
} from "../clientSession";
import { mcpServerInterface, mcpToolsInterface } from "../contracts";
import { registerMcpToolBridge } from "./bridge";

class FakeFactory implements McpSessionFactory {
    public tools: McpToolDefinition[] = [
        {
            name: "echo",
            description: "Echo text.",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
            },
            annotations: { readOnlyHint: true, idempotentHint: true },
        },
    ];
    public readonly calls: Array<{
        sessionId: string;
        name: string;
        args: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    public readonly closed: string[] = [];
    private readonly _contexts: OpenMcpSessionContext[] = [];

    public async open(context: OpenMcpSessionContext): Promise<McpClientSession> {
        this._contexts.push(context);
        return {
            listTools: async () => this.tools,
            callTool: async (name, args) => {
                this.calls.push({ sessionId: context.sessionId, name, args });
                return {
                    content: [{ type: "text", text: String(args?.text ?? "") }],
                    structuredContent: { echoed: args?.text },
                } as JsonValue;
            },
            close: async () => { this.closed.push(context.sessionId); },
        };
    }

    public notifyToolsChanged(): void {
        for (const context of this._contexts) context.onToolsChanged();
    }
}

function setup() {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    return { server, client };
}

describe("registerMcpToolBridge", () => {
    it("reflects tools as typed methods and publishes a catalog", async () => {
        const { server, client } = setup();
        const factory = new FakeFactory();
        factory.tools.push({ name: "write", inputSchema: { type: "object" } });
        const bridge = await registerMcpToolBridge({
            connection: server, serviceId: "mcp/demo", interfaceId: "mcp.tools.demo", factory,
        });

        const directory = await client.service("mcp/demo").get(directoryInterface).list({});
        const toolEntry = directory.items.find((item) => item.interfaceId === "mcp.tools.demo");
        expect(toolEntry).toBeDefined();
        const reflected = await client.service("mcp/demo").get(schemasInterface).get({
            interfaceId: "mcp.tools.demo",
            hash: toolEntry!.interfaceHash,
        });
        expect(reflected.schema).toMatchObject({
            methods: {
                echo: {
                    params: {
                        properties: { sessionId: { type: "string" }, text: { type: "string" } },
                        additionalProperties: true,
                    },
                    annotations: { readOnly: true, idempotent: true },
                },
                write: { annotations: { dangerous: true } },
            },
        });
        expect(await client.service("mcp/demo").get(mcpToolsInterface).listTools({})).toMatchObject({
            interfaces: [{ interfaceId: "mcp.tools.demo", interfaceHash: toolEntry!.interfaceHash, toolCount: 2 }],
            tools: [
                { name: "echo", interfaceId: "mcp.tools.demo", method: "echo" },
                { name: "write", interfaceId: "mcp.tools.demo", method: "write" },
            ],
        });
        await bridge.dispose();
    });

    it("shares one session by default and isolates minted exclusive sessions", async () => {
        const { server, client } = setup();
        const factory = new FakeFactory();
        const bridge = await registerMcpToolBridge({
            connection: server, serviceId: "mcp/demo", interfaceId: "mcp.tools.demo", factory,
        });
        const lifecycle = client.service("mcp/demo").get(mcpServerInterface);

        await client.channel.sendRequest("mcp/demo::mcp.tools.demo::echo", { text: "shared" });
        const { sessionId } = await lifecycle.openSession({});
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
        await client.channel.sendRequest("mcp/demo::mcp.tools.demo::echo", { sessionId, text: "own" });
        await expect(client.channel.sendRequest(
            "mcp/demo::mcp.tools.demo::echo",
            { sessionId: "guessed", text: "x" },
        )).rejects.toThrow("Unknown or closed MCP bridge session");
        expect(factory.calls).toEqual([
            { sessionId: "", name: "echo", args: { text: "shared" } },
            { sessionId, name: "echo", args: { text: "own" } },
        ]);

        expect(await lifecycle.closeSession({ sessionId })).toEqual({ closed: true });
        expect(factory.closed).toEqual([sessionId]);
        await expect(client.channel.sendRequest(
            "mcp/demo::mcp.tools.demo::echo",
            { sessionId, text: "again" },
        )).rejects.toThrow("Unknown or closed MCP bridge session");
        await bridge.dispose();
    });

    it("rejects invalid params with invalidParams", async () => {
        const { server, client } = setup();
        const bridge = await registerMcpToolBridge({
            connection: server, serviceId: "mcp/demo", interfaceId: "mcp.tools.demo", factory: new FakeFactory(),
        });
        await expect(client.channel.sendRequest("mcp/demo::mcp.tools.demo::echo", { text: 1 }))
            .rejects.toMatchObject({ code: -32602 });
        await bridge.dispose();
    });

    it("replaces the reflected interface and ticks directory watchers on tools/list_changed", async () => {
        const { server, client } = setup();
        const factory = new FakeFactory();
        const bridge = await registerMcpToolBridge({
            connection: server, serviceId: "mcp/demo", interfaceId: "mcp.tools.demo", factory,
        });
        let ticks = 0;
        const watch = client.service("mcp/demo").get(directoryInterface).watch(
            { interfaceId: "mcp.tools.demo" },
            { onMessage: () => ticks++ },
        );
        await client.service("mcp/demo").get(directoryInterface).list({});

        factory.tools = [
            ...factory.tools,
            {
                name: "sum",
                inputSchema: {
                    type: "object",
                    properties: { a: { type: "number" }, b: { type: "number" } },
                    required: ["a", "b"],
                },
            },
        ];
        factory.notifyToolsChanged();
        await until(() => bridge.currentInterfaces.get("mcp.tools.demo")!.toSchema().methods.sum !== undefined);
        await until(() => ticks > 0);

        expect(Object.keys(bridge.currentInterfaces.get("mcp.tools.demo")!.toSchema().methods)).toEqual(["echo", "sum"]);
        watch.cancel("done");
        await bridge.dispose();
    });

    it("continues refreshing after an error and disposes with a queued refresh", async () => {
        const { server } = setup();
        const factory = new FakeFactory();
        const errors: unknown[] = [];
        const bridge = await registerMcpToolBridge({
            connection: server,
            serviceId: "mcp/demo",
            interfaceId: "mcp.tools.demo",
            factory,
            onRefreshError: (error) => errors.push(error),
        });
        const defaultSession = await bridge.sessionManager.get("");
        const originalListTools = defaultSession.listTools;
        let fail = true;
        defaultSession.listTools = async (signal) => {
            if (fail) {
                fail = false;
                throw new Error("transient list failure");
            }
            return originalListTools(signal);
        };

        factory.notifyToolsChanged();
        await until(() => errors.length === 1);
        factory.tools = [...factory.tools, { name: "after-retry", inputSchema: { type: "object", properties: {} } }];
        factory.notifyToolsChanged();
        await until(() => bridge.currentInterfaces.get("mcp.tools.demo")!.toSchema().methods["after-retry"] !== undefined);

        factory.notifyToolsChanged();
        await bridge.dispose();
        expect(bridge.sessionManager.activeSessionCount).toBe(0);
    });

    it("serves observable lifecycle and authentication state", async () => {
        const { server, client } = setup();
        const bridge = await registerMcpToolBridge({
            connection: server, serviceId: "mcp/demo", interfaceId: "mcp.tools.demo", factory: new FakeFactory(),
        });
        const lifecycle = client.service("mcp/demo").get(mcpServerInterface);
        const states: Array<ReturnType<typeof bridge.getState>> = [];
        const watch = lifecycle.watchState({}, { onMessage: (state) => states.push(state) });
        bridge.updateAuthenticationState({
            status: "authorization-required",
            authorizationUri: "https://auth.example.com/authorize/request",
            expiresAt: "2030-01-01T00:00:00.000Z",
        });
        await until(() => states.some((state) => state.authentication.status === "authorization-required"));
        expect(await lifecycle.getState({})).toMatchObject({
            authentication: {
                status: "authorization-required",
                authorizationUri: "https://auth.example.com/authorize/request",
            },
            session: { sessionId: "", status: "ready" },
            tools: { status: "ready", interfaces: [{ interfaceId: "mcp.tools.demo", toolCount: 1 }], count: 1 },
        });
        watch.cancel("done");
        await bridge.dispose();
    });

    it("keeps static state available when the initial connection fails", async () => {
        const { server, client } = setup();
        const bridge = await registerMcpToolBridge({
            connection: server,
            serviceId: "mcp/offline",
            interfaceId: "mcp.tools.offline",
            factory: { open: async () => { throw new Error("server unavailable"); } },
            onRefreshError: () => {},
        });

        expect(await client.service("mcp/offline").get(mcpServerInterface).getState({})).toMatchObject({
            server: { status: "error", error: "server unavailable" },
            tools: { status: "error" },
        });
        expect([...bridge.currentInterfaces.keys()]).toEqual([]);
        await bridge.dispose();
    });

    it("splits tools into group interfaces by name, prefix, or keyword", async () => {
        const { server, client } = setup();
        const factory = new FakeFactory();
        factory.tools = ["issue_read", "list_issues", "pull_request_read", "get_me", "repo_tree", "fork"]
            .map((name) => ({ name, inputSchema: { type: "object" } }));
        const bridge = await registerMcpToolBridge({
            connection: server,
            serviceId: "gh",
            interfaceId: "mcp.tools.gh",
            groups: [
                { name: "issues", keywords: ["issue"] },
                { name: "pull-requests", keywords: ["pull_request"] },
                { name: "repos", prefixes: ["repo_"], tools: ["fork"] },
            ],
            factory,
        });
        expect(Object.fromEntries([...bridge.currentInterfaces].map(([id, iface]) =>
            [id, Object.keys(iface.toSchema().methods)]))).toMatchInlineSnapshot(`
          {
            "mcp.tools.gh": [
              "get_me",
            ],
            "mcp.tools.gh.issues": [
              "issue_read",
              "list_issues",
            ],
            "mcp.tools.gh.pull-requests": [
              "pull_request_read",
            ],
            "mcp.tools.gh.repos": [
              "repo_tree",
              "fork",
            ],
          }
        `);
        await client.channel.sendRequest("gh::mcp.tools.gh.repos::fork", {});
        expect(factory.calls.map((call) => call.name)).toEqual(["fork"]);
        await bridge.dispose();
    });

    it("calls tools generically by name with the same validation", async () => {
        const { server, client } = setup();
        const factory = new FakeFactory();
        const bridge = await registerMcpToolBridge({
            connection: server, serviceId: "mcp/demo", interfaceId: "mcp.tools.demo", factory,
        });
        const tools = client.service("mcp/demo").get(mcpToolsInterface);
        expect(await tools.callTool({ name: "echo", arguments: { text: "generic" } }))
            .toMatchObject({ structuredContent: { echoed: "generic" } });
        await expect(tools.callTool({ name: "echo", arguments: { text: 1 } })).rejects.toMatchObject({ code: -32602 });
        await expect(tools.callTool({ name: "missing" })).rejects.toThrow("Unknown MCP tool: missing");
        await expect(tools.callTool({ name: "echo", arguments: { text: "x", sessionId: "s" } }))
            .rejects.toThrow("Pass sessionId next to arguments");
        await bridge.dispose();
    });

    it("converts $defs into interface components", async () => {
        const { server, client } = setup();
        const factory = new FakeFactory();
        // The shape FastMCP/Pydantic emits for nested models.
        factory.tools = [{
            name: "create_item",
            inputSchema: {
                type: "object",
                properties: { item: { $ref: "#/$defs/Item" } },
                required: ["item"],
                $defs: { Item: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
            },
        }];
        const bridge = await registerMcpToolBridge({
            connection: server, serviceId: "mcp/demo", interfaceId: "mcp.tools.demo", factory,
        });
        expect(bridge.currentInterfaces.get("mcp.tools.demo")!.toSchema().components).toMatchInlineSnapshot(`
          {
            "schemas": {
              "create_item.input.Item": {
                "additionalProperties": true,
                "properties": {
                  "name": {
                    "type": "string",
                  },
                },
                "required": [
                  "name",
                ],
                "type": "object",
              },
            },
          }
        `);
        await client.channel.sendRequest("mcp/demo::mcp.tools.demo::create_item", { item: { name: "a" } });
        await expect(client.channel.sendRequest("mcp/demo::mcp.tools.demo::create_item", { item: {} }))
            .rejects.toMatchObject({ code: -32602 });
        expect(factory.calls).toHaveLength(1);
        await bridge.dispose();
    });

    it("publishes a tool with an unsupported schema with unchecked params instead of failing", async () => {
        const { server, client } = setup();
        const factory = new FakeFactory();
        factory.tools = [
            ...factory.tools,
            { name: "odd", inputSchema: { type: "object", properties: { a: { $ref: "#/properties/b" } } } },
        ];
        const warnings: string[] = [];
        const bridge = await registerMcpToolBridge({
            connection: server, serviceId: "mcp/demo", interfaceId: "mcp.tools.demo", factory,
            log: (line) => warnings.push(line),
        });
        expect(warnings).toEqual(["MCP tool 'odd' is published with unchecked params: unsupported $ref '#/properties/b'"]);
        await client.channel.sendRequest("mcp/demo::mcp.tools.demo::odd", { anything: true });
        await expect(client.channel.sendRequest("mcp/demo::mcp.tools.demo::echo", { text: 1 }))
            .rejects.toMatchObject({ code: -32602 });
        await bridge.dispose();
    });
});

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
