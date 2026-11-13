import { describe, expect, it, vi } from "vitest";
import {
    LinkRpcConnection,
    TransportPair,
    createSeededMemoryPrincipal,
    directoryInterface,
    directoryWatchNever,
    issueCapability,
    type JsonValue,
} from "@hediet/linkrpc";
import { connectViaTransport } from "@hediet/linkrpc-client-internal";
import { withForwardedCallGate } from "@hediet/linkrpc-hub/hub/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ToolListChangedNotificationSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpSessionFactory, McpToolDefinition } from "../clientSession";
import { mcpForwardInterface, mcpToolsInterface } from "../contracts";
import { McpToolHost } from "../toolHost";
import { registerMcpToolBridge } from "../service/bridge";
import { HubMcpAggregator } from "./aggregator";

const tool = (name: string): Tool => ({ name, inputSchema: { type: "object" } });

describe("HubMcpAggregator", () => {
    it("fails explicitly when the root directory is inaccessible", async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.register(directoryInterface, {
            list: () => { throw new Error("Discovery denied"); },
            watch: directoryWatchNever,
        });
        const local = connectViaTransport(pair.b);
        const aggregator = new HubMcpAggregator(local.channel, { log: () => {} });
        try {
            await expect(aggregator.ready).rejects.toThrow("Hub directory inaccessible: Discovery denied");
        } finally { await aggregator.dispose(); local.close(); hub.close(); }
    });

    it("aggregates MCP services, routes images, watches changes, and ignores forwarded servers", async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        const firstFactory = typedFactory([tool("screenshot"), tool("other")]);
        const first = await registerMcpToolBridge({
            connection: hub, serviceId: "machine/very-long-service-path/" + "a".repeat(100),
            interfaceId: "mcp.tools.first", factory: firstFactory,
        });
        const secondFactory = typedFactory([tool("screenshot")]);
        const second = await registerMcpToolBridge({
            connection: hub, serviceId: "machine/second", interfaceId: "mcp.tools.second", factory: secondFactory,
        });
        const forwardOnly = forwarded(hub, "forward-only");
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        const changed = vi.fn();
        f.client.setNotificationHandler(ToolListChangedNotificationSchema, changed);
        const bridges = [first, second];
        try {
            const initial = await f.client.listTools();
            expect(initial.tools.map(t => t.description).sort()).toEqual([
                `[machine/second] screenshot`,
                `[machine/very-long-service-path/${"a".repeat(100)}] other`,
                `[machine/very-long-service-path/${"a".repeat(100)}] screenshot`,
            ]);
            expect(new Set(initial.tools.map(t => t.name)).size).toBe(3);
            for (const t of initial.tools) {
                expect(t.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
            }
            expect(forwardOnly.active).toBe(0);
            const screenshot = initial.tools.find(t => t.description?.startsWith("[machine/second]"))!;
            expect(await f.client.callTool({ name: screenshot.name, arguments: { example: 42 } })).toEqual({
                content: [
                    { type: "text", text: "screenshot:{\"example\":42}" },
                    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
                ],
            });
            secondFactory.tools = [tool("replacement")];
            await second.refreshTools();
            await vi.waitFor(async () => {
                expect((await f.client.listTools()).tools.some(t => t.name.startsWith("replacement__"))).toBe(true);
            });
            expect(changed).toHaveBeenCalled();
            await first.dispose();
            await vi.waitFor(async () => { expect((await f.client.listTools()).tools).toHaveLength(1); });
            bridges.push(await registerMcpToolBridge({
                connection: hub, serviceId: "machine/new-dynamic-id", interfaceId: "mcp.tools.third", factory: typedFactory([tool("screenshot")]),
            }));
            await vi.waitFor(async () => { expect((await f.client.listTools()).tools).toHaveLength(2); });
            expect(forwardOnly.active).toBe(0);
        } finally {
            await f.close();
            for (const bridge of bridges) await bridge.dispose();
            local.close();
            hub.close();
        }
    });

    it("reports failed services without hiding healthy ones", async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        const healthy = await registerMcpToolBridge({
            connection: hub, serviceId: "healthy", interfaceId: "mcp.tools.healthy", factory: typedFactory([tool("ok")]),
        });
        hub.register(mcpToolsInterface, {
            listTools: () => { throw new Error("Service unavailable"); },
            callTool: () => { throw new Error("Service unavailable"); },
        }, { serviceId: "broken" });
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        try {
            expect((await f.client.listTools()).tools.map(t => t.description)).toEqual(["[healthy] ok"]);
            expect(f.logs.join("\n")).toContain("Service unavailable");
        } finally {
            await f.close(); await healthy.dispose(); local.close(); hub.close();
        }
    });

    it("does not expose services whose tool list the channel may not read", async () => {
        const root = await createSeededMemoryPrincipal({ seed: 803 });
        const principal = await createSeededMemoryPrincipal({ seed: 804 });
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(withForwardedCallGate(pair.a, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
            exemptPrefixes: ["private::hubrpc."],
        }));
        hub.enableReflection();
        const bridge = await registerMcpToolBridge({
            connection: hub, serviceId: "private", interfaceId: "mcp.tools.private", factory: typedFactory([tool("secret")]),
        });
        const local = connectViaTransport(pair.b);
        local.signing.principal = principal;
        const f = await consumer(local.channel);
        try {
            expect(await f.client.listTools()).toEqual({ tools: [] });
            expect(f.logs.join("\n")).toContain("Cannot list tools from private");
        } finally {
            await f.close(); await bridge.dispose(); local.close(); hub.close();
        }
    });

    it("calls typed bridges through their generated methods, so capabilities apply per tool", async () => {
        const root = await createSeededMemoryPrincipal({ seed: 805 });
        const principal = await createSeededMemoryPrincipal({ seed: 806 });
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(withForwardedCallGate(pair.a, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
            exemptPrefixes: ["typed::hubrpc."],
        }));
        hub.enableReflection();
        const factory = typedFactory([
            { name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
            { name: "delete", inputSchema: { type: "object" } },
        ]);
        const bridge = await registerMcpToolBridge({
            connection: hub, serviceId: "typed", interfaceId: "mcp.tools.typed", factory,
        });
        const local = connectViaTransport(pair.b);
        local.signing.principal = principal;
        await principal.capBag.add(await grant(root, principal, "typed", mcpToolsInterface.info.id, ["listTools"]));
        await principal.capBag.add(await grant(root, principal, "typed", "mcp.tools.typed", ["read"]));
        const f = await consumer(local.channel);
        try {
            const tools = (await f.client.listTools()).tools;
            expect(tools.map(t => t.description)).toEqual(["[typed] read", "[typed] delete"]);
            expect(await f.client.callTool({ name: tools[0].name, arguments: { path: "a.txt" } })).toEqual({
                content: [{ type: "text", text: "read:{\"path\":\"a.txt\"}" }],
            });
            const denied = await f.client.callTool({ name: tools[1].name });
            expect(denied.isError).toBe(true);
            expect(factory.calls).toEqual(["read"]);
        } finally {
            await f.close(); await bridge.dispose(); local.close(); hub.close();
        }
    });
});

async function consumer(channel: ConstructorParameters<typeof HubMcpAggregator>[0]) {
    const logs: string[] = [];
    const aggregator = new HubMcpAggregator(channel, { log: line => logs.push(line), retryIntervalMs: 200 });
    const server = new Server({ name: "hub-mcp-test", version: "1" }, { capabilities: { tools: { listChanged: true } } });
    new McpToolHost(server).addSource(aggregator);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "agent-test", version: "1" });
    await client.connect(clientTransport);
    let closed = false;
    return {
        client, logs,
        close: async () => {
            if (closed) return;
            closed = true;
            await client.close();
            await aggregator.dispose();
            await server.close();
        },
    };
}

/** A forward-only MCP server; counts open `connect` legs. */
function forwarded(hub: LinkRpcConnection, serviceId: string) {
    const state = { active: 0 };
    hub.register(mcpForwardInterface, {
        connect: async (_params, _ctx, stream) => {
            state.active++;
            await new Promise<void>(resolve => stream.signal.addEventListener("abort", () => resolve(), { once: true }));
            state.active--;
            return {};
        },
    }, { serviceId });
    return state;
}

function typedFactory(tools: McpToolDefinition[]): McpSessionFactory & { calls: string[]; tools: McpToolDefinition[] } {
    const factory = {
        calls: [] as string[],
        tools,
        open: async () => ({
            listTools: async () => factory.tools,
            callTool: async (name: string, args: Readonly<Record<string, unknown>> | undefined) => {
                factory.calls.push(name);
                return {
                    content: [
                        { type: "text", text: `${name}:${JSON.stringify(args ?? {})}` },
                        ...(name === "screenshot" ? [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] : []),
                    ],
                } as JsonValue;
            },
            close: async () => {},
        }),
    };
    return factory;
}

async function grant(
    root: Awaited<ReturnType<typeof createSeededMemoryPrincipal>>,
    principal: Awaited<ReturnType<typeof createSeededMemoryPrincipal>>,
    serviceId: string,
    interfaceId: string,
    members: string[],
) {
    return issueCapability(root.identity, {
        audience: principal.identity.publicSigningIdentity,
        expiresAtMs: Date.now() + 60_000,
        permissions: [{
            target: {
                serviceId: { exact: serviceId },
                interfaceId: { exact: interfaceId },
                members: members.map(member => ({ exact: member })),
            },
            canInvoke: true,
        }],
    });
}
