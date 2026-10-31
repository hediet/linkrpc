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
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
    CallToolRequestSchema, JSONRPCMessageSchema, ListToolsRequestSchema,
    ToolListChangedNotificationSchema, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpSessionFactory, McpToolDefinition } from "../clientSession";
import { legacyMcpForwardInterface, mcpForwardInterface, mcpToolsInterface } from "../contracts";
import { McpToolHost } from "../toolHost";
import { registerMcpToolBridge } from "../typed/bridge";
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

    it("cancels an initializing producer when disposed", async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        let started = false;
        let cancelled = false;
        hub.register(mcpForwardInterface, {
            connect: async (_params, _ctx, stream) => {
                started = true;
                await new Promise<void>(resolve => stream.signal.addEventListener("abort", () => {
                    cancelled = true;
                    resolve();
                }, { once: true }));
                return {};
            },
        }, { serviceId: "slow" });
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        try {
            await vi.waitFor(() => expect(started).toBe(true));
            await f.close();
            await vi.waitFor(() => expect(cancelled).toBe(true));
        } finally { await f.close(); local.close(); hub.close(); }
    });

    it("aggregates paginated tools, routes images, watches changes, and closes only client sessions", async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        const first = forwarded(hub, "machine/very-long-service-path/" + "a".repeat(100), [tool("screenshot"), tool("other")]);
        const second = forwarded(hub, "machine/second", [tool("screenshot")]);
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        const changed = vi.fn();
        f.client.setNotificationHandler(ToolListChangedNotificationSchema, changed);
        try {
            const initial = await f.client.listTools();
            expect(initial.tools).toHaveLength(3);
            expect(new Set(initial.tools.map(t => t.name)).size).toBe(3);
            for (const t of initial.tools) {
                expect(t.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
            }
            const screenshot = initial.tools.find(t => t.description?.startsWith("[machine/second]"))!;
            expect(await f.client.callTool({ name: screenshot.name, arguments: { example: 42 } })).toEqual({
                content: [
                    { type: "text", text: "machine/second:{\"example\":42}" },
                    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
                ],
            });
            second.tools = [tool("replacement")];
            await second.servers[0].sendToolListChanged();
            await vi.waitFor(async () => {
                expect((await f.client.listTools()).tools.some(t => t.name.startsWith("replacement__"))).toBe(true);
            });
            expect(changed).toHaveBeenCalled();
            first.registration.dispose();
            await vi.waitFor(async () => { expect((await f.client.listTools()).tools).toHaveLength(1); });
            const third = forwarded(hub, "machine/new-dynamic-id", [tool("screenshot")]);
            await vi.waitFor(async () => { expect((await f.client.listTools()).tools).toHaveLength(2); });
            await f.close();
            await vi.waitFor(() => {
                expect([first.active, second.active, third.active]).toEqual([0, 0, 0]);
            });
            const next = await consumer(local.channel);
            try {
                expect((await next.client.listTools()).tools).toHaveLength(2);
            } finally { await next.close(); }
        } finally {
            await f.close();
            local.close();
            hub.close();
        }
    });

    it("discovers producers that only offer the legacy interface id", async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        forwarded(hub, "old-producer", [tool("legacy")], legacyMcpForwardInterface);
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        try {
            const tools = (await f.client.listTools()).tools;
            expect(tools.map(t => t.description)).toEqual(["[old-producer] legacy"]);
            expect((await f.client.callTool({ name: tools[0].name })).isError).not.toBe(true);
        } finally { await f.close(); local.close(); hub.close(); }
    });

    it("reports failed services without hiding healthy ones", async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        forwarded(hub, "healthy", [tool("ok")]);
        hub.register(mcpForwardInterface, { connect: () => { throw new Error("Producer unavailable"); } }, { serviceId: "broken" });
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        try {
            expect((await f.client.listTools()).tools.map(t => t.description)).toEqual(["[healthy] ok"]);
            expect(f.logs.join("\n")).toContain("Producer unavailable");
        } finally {
            await f.close(); local.close(); hub.close();
        }
    });

    it("uses the selected signed channel and its capabilities for forwarded sessions", async () => {
        const root = await createSeededMemoryPrincipal({ seed: 801 });
        const principal = await createSeededMemoryPrincipal({ seed: 802 });
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(withForwardedCallGate(pair.a, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
        }));
        hub.enableReflection();
        forwarded(hub, "private", [tool("signed")]);
        const local = connectViaTransport(pair.b);
        local.signing.principal = principal;
        await principal.capBag.add(await grant(root, principal, "private", mcpForwardInterface.info.id, ["connect"]));
        const f = await consumer(local.channel);
        try {
            const tools = (await f.client.listTools()).tools;
            expect(tools.map(t => t.description)).toEqual(["[private] signed"]);
            expect((await f.client.callTool({ name: tools[0].name })).isError).not.toBe(true);
        } finally {
            await f.close(); local.close(); hub.close();
        }
    });

    it("reconnects a stopped MCP session while the producer remains advertised", async () => {
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(pair.a);
        hub.enableReflection();
        const producer = forwarded(hub, "stable-producer", [tool("before")]);
        const local = connectViaTransport(pair.b);
        const f = await consumer(local.channel);
        try {
            await f.client.listTools();
            await producer.servers[0].close();
            await vi.waitFor(async () => { expect((await f.client.listTools()).tools).toHaveLength(0); });
            producer.tools = [tool("after")];
            await vi.waitFor(async () => {
                expect((await f.client.listTools()).tools.map(t => t.description)).toEqual(["[stable-producer] after"]);
            }, { timeout: 3_000 });
            expect(producer.servers).toHaveLength(2);
        } finally {
            await f.close(); local.close(); hub.close();
        }
    });

    it("does not expose unauthorized forwarded tools", async () => {
        const root = await createSeededMemoryPrincipal({ seed: 803 });
        const principal = await createSeededMemoryPrincipal({ seed: 804 });
        const pair = new TransportPair();
        const hub = LinkRpcConnection.fromTransport(withForwardedCallGate(pair.a, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
        }));
        hub.enableReflection();
        const producer = forwarded(hub, "private", [tool("secret")]);
        const local = connectViaTransport(pair.b);
        local.signing.principal = principal;
        const f = await consumer(local.channel);
        try {
            expect(await f.client.listTools()).toEqual({ tools: [] });
            expect(producer.active).toBe(0);
            expect(f.logs.join("\n")).toContain("Cannot connect to private");
        } finally {
            await f.close(); local.close(); hub.close();
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

function forwarded(
    hub: LinkRpcConnection,
    serviceId: string,
    tools: Tool[],
    iface: typeof mcpForwardInterface = mcpForwardInterface,
) {
    const state = { tools, servers: [] as Server[], active: 0 };
    const registration = hub.register(iface, {
        connect: async (_params, _ctx, stream) => {
            state.active++;
            const server = new Server({ name: serviceId, version: "1" }, { capabilities: { tools: { listChanged: true } } });
            state.servers.push(server);
            server.setRequestHandler(ListToolsRequestSchema, request => {
                const index = Number(request.params?.cursor ?? 0);
                return {
                    tools: state.tools.slice(index, index + 1),
                    ...(index + 1 < state.tools.length ? { nextCursor: String(index + 1) } : {}),
                };
            });
            server.setRequestHandler(CallToolRequestSchema, request => ({
                content: [
                    { type: "text", text: `${serviceId}:${JSON.stringify(request.params.arguments ?? {})}` },
                    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
                ],
            }));
            try {
                await new Promise<void>((resolve, reject) => {
                    const transport: Transport = {
                        start: async () => {},
                        send: async message => { stream.send({ frame: message }); },
                        close: async () => { transport.onclose?.(); resolve(); },
                    };
                    stream.onMessage(({ frame }) => transport.onmessage?.(JSONRPCMessageSchema.parse(frame)));
                    stream.signal.addEventListener("abort", () => { void server.close().catch(reject); }, { once: true });
                    void server.connect(transport).catch(reject);
                });
            } finally {
                state.active--;
            }
            return {};
        },
    }, { serviceId });
    return Object.assign(state, { registration });
}

function typedFactory(tools: McpToolDefinition[]): McpSessionFactory & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        open: async () => ({
            listTools: async () => tools,
            callTool: async (name, args) => {
                calls.push(name);
                return { content: [{ type: "text", text: `${name}:${JSON.stringify(args ?? {})}` }] } as JsonValue;
            },
            close: async () => {},
        }),
    };
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
