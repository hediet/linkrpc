import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LinkRpcConnection, TransportPair } from "@hediet/linkrpc";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
// @ts-expect-error untyped test fixture
import { createTestMcpServer } from "./testFixtures/mcpServer.mjs";
import { mcpServerInterface, mcpToolsInterface } from "./contracts";
import { spawn } from "node:child_process";
import { McpForwardClientTransport } from "./forward/clientTransport";
import { serveMcpForwardInstance, streamInstanceTransport } from "./forward/instance";
import { hostMcpServer, mcpServerConfigSchema } from "./host";

const fixture = fileURLToPath(new URL("./testFixtures/mcpServer.mjs", import.meta.url));
const stdioTransport = { kind: "stdio" as const, command: process.execPath, args: [fixture, "--stdio"] };

describe("hosted MCP servers", () => {
    it("forwards a stdio server verbatim with one process per connection", async () => {
        const { server, client } = pair();
        const hosted = await hostMcpServer({
            connection: server,
            serviceId: "mcp/stdio",
            server: mcpServerConfigSchema.parse({ id: "stdio", transport: stdioTransport, expose: { forward: {} } }),
        });
        try {
            const first = await forwardedClient(client, "mcp/stdio");
            const second = await forwardedClient(client, "mcp/stdio");
            expect((await first.listTools()).tools.map((tool) => tool.name)).toEqual(["inspect"]);
            const pids = await Promise.all([first, second].map(async (c) => pidOf(await c.callTool({
                name: "inspect", arguments: { value: "x", mode: "brief" },
            }))));
            expect(pids[0]).not.toBe(pids[1]);
            await first.close();
            await until(() => !isProcessAlive(pids[0]));
            expect(isProcessAlive(pids[1])).toBe(true);
            await second.close();
            await until(() => !isProcessAlive(pids[1]));
        } finally {
            await hosted.dispose();
        }
    }, 20_000);

    it("exposes a stdio server as a service and forwarded at the same time", async () => {
        const { server, client } = pair();
        const hosted = await hostMcpServer({
            connection: server,
            serviceId: "mcp/both",
            server: mcpServerConfigSchema.parse({ id: "both", transport: stdioTransport, expose: { service: {}, forward: {} } }),
        });
        try {
            const catalog = await client.service("mcp/both").get(mcpToolsInterface).listTools({});
            expect(catalog.tools.map((tool) => tool.name)).toEqual(["inspect", "second-page"]);
            const typed = await client.channel.sendRequest(
                "mcp/both::mcp.tools.both::inspect",
                { value: "typed", mode: "full" },
            ) as { structuredContent: { pid: number; value: string } };
            expect(typed.structuredContent.value).toBe("typed");

            const lifecycle = client.service("mcp/both").get(mcpServerInterface);
            const { sessionId } = await lifecycle.openSession({});
            const exclusive = await client.channel.sendRequest(
                "mcp/both::mcp.tools.both::inspect",
                { sessionId, value: "own", mode: "brief" },
            ) as { structuredContent: { pid: number } };
            expect(exclusive.structuredContent.pid).not.toBe(typed.structuredContent.pid);

            const forwarded = await forwardedClient(client, "mcp/both");
            const viaForward = pidOf(await forwarded.callTool({ name: "inspect", arguments: { value: "f", mode: "brief" } }));
            expect(new Set([viaForward, typed.structuredContent.pid, exclusive.structuredContent.pid]).size).toBe(3);
            await forwarded.close();
            await lifecycle.closeSession({ sessionId });
            await until(() => !isProcessAlive(exclusive.structuredContent.pid));
            expect(isProcessAlive(typed.structuredContent.pid)).toBe(true);
        } finally {
            await hosted.dispose();
        }
    }, 20_000);

    it("forwards a Streamable HTTP server with its protocol version and terminates the session", async () => {
        const http = await startHttpMcpServer();
        const { server, client } = pair();
        const hosted = await hostMcpServer({
            connection: server,
            serviceId: "mcp/http",
            server: mcpServerConfigSchema.parse({
                id: "http",
                transport: { kind: "streamable-http", url: http.url, headers: { "x-test": "static" } },
                expose: { service: {}, forward: {} },
            }),
        });
        try {
            const forwarded = await forwardedClient(client, "mcp/http");
            const result = await forwarded.callTool({ name: "inspect", arguments: { value: "h", mode: "brief" } });
            expect(result.structuredContent).toMatchObject({ value: "h", transport: "streamable-http" });
            await forwarded.close();
            await until(() => http.deletedSessions() === 1);
            expect(new Set(http.protocolVersions())).toEqual(new Set([LATEST_PROTOCOL_VERSION]));
            expect(http.headerValues()).toEqual(["static"]);

            const typed = await client.channel.sendRequest(
                "mcp/http::mcp.tools.http::inspect",
                { value: "typed", mode: "brief" },
            );
            expect(typed).toMatchObject({ structuredContent: { value: "typed", transport: "streamable-http" } });
        } finally {
            await hosted.dispose();
            await http.dispose();
        }
    }, 20_000);

    it("forwards one running instance to one connection at a time", async () => {
        const { server, client } = pair();
        // A running MCP server whose stdio this process holds, as with `mcp-publish --forward --stdio`.
        const notes = spawn(process.execPath, [fileURLToPath(new URL("./testFixtures/notesServer.mjs", import.meta.url))], {
            stdio: ["pipe", "pipe", "inherit"],
        });
        const instance = serveMcpForwardInstance({
            connection: server,
            serviceId: "mcp/instance",
            transport: streamInstanceTransport(notes.stdout, notes.stdin),
            log: () => {},
        });
        try {
            const first = await forwardedClient(client, "mcp/instance");
            await first.callTool({ name: "add_note", arguments: { text: "kept" } });
            await expect(forwardedClient(client, "mcp/instance")).rejects.toThrow();

            await first.close();
            // The next connection gets the same process and its state.
            const second = await forwardedClient(client, "mcp/instance");
            expect(await second.callTool({ name: "list_notes" })).toMatchObject({ content: [{ text: "[\"kept\"]" }] });
            await second.close();

            notes.kill();
            await instance.closed;
            await expect(forwardedClient(client, "mcp/instance")).rejects.toThrow();
        } finally {
            instance.dispose();
            notes.kill();
        }
    }, 20_000);
});

function pair() {
    const transports = new TransportPair();
    return {
        server: LinkRpcConnection.fromTransport(transports.a),
        client: LinkRpcConnection.fromTransport(transports.b),
    };
}

async function forwardedClient(connection: LinkRpcConnection, serviceId: string): Promise<Client> {
    const client = new Client({ name: "forward-test", version: "1" });
    await client.connect(new McpForwardClientTransport(connection.channel, serviceId));
    return client;
}

function pidOf(result: unknown): number {
    return (result as { structuredContent: { pid: number } }).structuredContent.pid;
}

async function startHttpMcpServer() {
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const servers = new Set<Server>();
    const versions: string[] = [];
    const headers = new Set<string>();
    let deleted = 0;
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const version = req.headers["mcp-protocol-version"];
        if (typeof version === "string") versions.push(version);
        if (typeof req.headers["x-test"] === "string") headers.add(req.headers["x-test"]);
        if (req.method === "DELETE") deleted++;
        const header = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(header) ? header[0] : header;
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
            if (req.method !== "POST") {
                res.statusCode = 400;
                res.end();
                return;
            }
            const created = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => { transports.set(id, created); },
            });
            const server: Server = createTestMcpServer("streamable-http");
            servers.add(server);
            created.onclose = () => {
                if (created.sessionId) transports.delete(created.sessionId);
                servers.delete(server);
            };
            await server.connect(created);
            transport = created;
        }
        await transport.handleRequest(req, res);
    };
    const httpServer = createServer((req, res) => {
        void handle(req, res).catch((error: unknown) => {
            if (!res.headersSent) res.statusCode = 500;
            res.end(error instanceof Error ? error.message : String(error));
        });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("HTTP MCP server has no TCP address");
    return {
        url: `http://127.0.0.1:${address.port}/mcp`,
        protocolVersions: () => versions,
        headerValues: () => [...headers],
        deletedSessions: () => deleted,
        dispose: async () => {
            await Promise.allSettled([...servers].map((server) => server.close()));
            await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
        },
    };
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
