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
            interfaceId: "mcp.tools.demo",
            interfaceHash: toolEntry!.interfaceHash,
            tools: [{ name: "echo", method: "echo" }, { name: "write", method: "write" }],
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
        await until(() => bridge.currentInterface.toSchema().methods.sum !== undefined);
        await until(() => ticks > 0);

        expect(Object.keys(bridge.currentInterface.toSchema().methods)).toEqual(["echo", "sum"]);
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
        await until(() => bridge.currentInterface.toSchema().methods["after-retry"] !== undefined);

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
            tools: { status: "ready", interfaceId: "mcp.tools.demo", count: 1 },
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
            tools: { status: "error", interfaceId: "mcp.tools.offline" },
        });
        expect(bridge.currentInterface.toSchema().methods).toEqual({});
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
