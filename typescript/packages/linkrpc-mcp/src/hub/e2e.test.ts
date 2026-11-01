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
import { mcpIdentitiesInterface, mcpServerInterface, mcpToolsInterface } from "./contracts";
import { type McpAccessToken, oauthMcpIdentities } from "./oauthIdentities";
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

describe("MCP identities", () => {
    it("starts one stdio process per identity with its environment", async () => {
        const { server, client } = pair();
        const hosted = await hostMcpServer({
            connection: server,
            serviceId: "mcp/accounts",
            server: mcpServerConfigSchema.parse({
                id: "accounts",
                transport: stdioTransport,
                identities: [
                    { id: "work", env: { MCP_TEST_ACCOUNT: "work" } },
                    { id: "home", default: true, env: { MCP_TEST_ACCOUNT: { fromEnv: "LINKRPC_MCP_TEST_HOME" } } },
                ],
                expose: { service: {}, forward: {} },
            }),
        });
        process.env.LINKRPC_MCP_TEST_HOME = "home-from-env";
        try {
            const call = (params: Record<string, string>) => client.channel.sendRequest(
                "mcp/accounts::mcp.tools.accounts::inspect",
                { value: "x", mode: "full", ...params },
            );
            expect(accountOf(await call({}))).toBe("home-from-env");
            expect(accountOf(await call({ mcpIdentity: "work" }))).toBe("work");
            expect(pidOf(await call({ mcpIdentity: "work" }))).not.toBe(pidOf(await call({})));

            const forwarded = await forwardedClient(client, "mcp/accounts", "work");
            expect(accountOf(await forwarded.callTool({ name: "inspect", arguments: { value: "f", mode: "full" } })))
                .toBe("work");
            await forwarded.close();

            expect(await client.service("mcp/accounts").get(mcpIdentitiesInterface).list({})).toEqual({
                identities: [
                    { id: "work", default: false, authentication: { status: "not-required" } },
                    { id: "home", default: true, authentication: { status: "not-required" } },
                ],
            });
        } finally {
            delete process.env.LINKRPC_MCP_TEST_HOME;
            await hosted.dispose();
        }
    }, 20_000);

    it("sends each identity's OAuth token and retries once after a 401", async () => {
        const http = await startHttpMcpServer({ acceptedTokens: new Set(["alice-2", "bob-1"]) });
        const issued = new Map([["alice", 1], ["bob", 1]]);
        const tokens = {
            list: () => [{ id: "alice", label: "Alice" }, { id: "bob" }, { id: "carol" }],
            getAccessToken: async (identityId: string): Promise<McpAccessToken> => identityId === "carol"
                ? { status: "authorization-required", authorizationUri: "https://auth.example/carol" }
                : { status: "ready", accessToken: `${identityId}-${issued.get(identityId)}` },
            invalidate: async (identityId: string) => { issued.set(identityId, issued.get(identityId)! + 1); },
        };
        const { server, client } = pair();
        const hosted = await hostMcpServer({
            connection: server,
            serviceId: "mcp/oauth",
            server: mcpServerConfigSchema.parse({
                id: "oauth",
                transport: { kind: "streamable-http", url: http.url },
                expose: { service: {}, forward: {} },
            }),
            identities: oauthMcpIdentities({ url: http.url, tokens }),
            log: () => {},
        });
        try {
            const inspect = (params: Record<string, string>) => client.channel.sendRequest(
                "mcp/oauth::mcp.tools.oauth::inspect",
                { value: "x", mode: "full", ...params },
            );
            // Listing the tools at startup made alice's first token fail once.
            expect(http.authorizations().filter((value) => value.includes("alice")).slice(0, 2))
                .toEqual(["Bearer alice-1", "Bearer alice-2"]);
            await inspect({});
            await inspect({ mcpIdentity: "bob" });
            expect(new Set(http.authorizations())).toEqual(new Set(["Bearer alice-1", "Bearer alice-2", "Bearer bob-1"]));
            await expect(inspect({ mcpIdentity: "carol" })).rejects.toThrow(
                "MCP identity 'carol' requires authorization at https://auth.example/carol",
            );

            // Forwarding is refused up front for an identity that needs sign-in.
            await expect(client.channel.sendRequest("mcp/oauth::mcp.forward::connect", { mcpIdentity: "carol" }))
                .rejects.toThrow("MCP identity 'carol' requires authorization at https://auth.example/carol");

            const before = http.authorizations().length;
            const forwarded = await forwardedClient(client, "mcp/oauth", "bob");
            await forwarded.callTool({ name: "inspect", arguments: { value: "f", mode: "full" } });
            await forwarded.close();
            // Other requests in between belong to the open shared sessions (e.g. their SSE streams).
            expect(http.authorizations().slice(before).filter((value) => value === "Bearer bob-1").length)
                .toBeGreaterThanOrEqual(3);

            expect(await client.service("mcp/oauth").get(mcpIdentitiesInterface).list({})).toEqual({
                identities: [
                    {
                        id: "alice", label: "Alice", default: true,
                        authentication: { status: "ready", identityId: "alice", identityLabel: "Alice" },
                    },
                    { id: "bob", default: false, authentication: { status: "ready", identityId: "bob" } },
                    {
                        id: "carol", default: false,
                        authentication: { status: "authorization-required", authorizationUri: "https://auth.example/carol" },
                    },
                ],
            });
        } finally {
            await hosted.dispose();
            await http.dispose();
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

async function forwardedClient(connection: LinkRpcConnection, serviceId: string, mcpIdentity?: string): Promise<Client> {
    const client = new Client({ name: "forward-test", version: "1" });
    await client.connect(new McpForwardClientTransport(connection.channel, serviceId, {
        ...(mcpIdentity !== undefined ? { mcpIdentity } : {}),
    }));
    return client;
}

function accountOf(result: unknown): string | undefined {
    return (result as { structuredContent: { account?: string } }).structuredContent.account;
}

function pidOf(result: unknown): number {
    return (result as { structuredContent: { pid: number } }).structuredContent.pid;
}

async function startHttpMcpServer(options: { readonly acceptedTokens?: ReadonlySet<string> } = {}) {
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const servers = new Set<Server>();
    const versions: string[] = [];
    const headers = new Set<string>();
    const authorizations: string[] = [];
    let deleted = 0;
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (options.acceptedTokens !== undefined) {
            const authorization = req.headers.authorization ?? "";
            authorizations.push(authorization);
            if (!options.acceptedTokens.has(authorization.replace(/^Bearer /, ""))) {
                res.statusCode = 401;
                res.end();
                return;
            }
        }
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
        authorizations: () => authorizations,
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
