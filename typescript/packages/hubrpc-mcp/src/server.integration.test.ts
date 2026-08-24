import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { IConnectionPool, PooledConnection } from "./connectionPool";
import { HubRpcMcpServer } from "./server";

/**
 * Records every outbound request and lets the test resolve it on demand, so
 * `con.call` stays pending long enough for the sandbox to park.
 */
class FakeChannel {
    public readonly requests: {
        method: string;
        resolve: (v: unknown) => void;
        reject: (e: unknown) => void;
        stream: (value: unknown) => void;
        cancelled: boolean;
        disposed: boolean;
    }[] = [];
    public sendRequestWithStream(
        method: string,
        _params: unknown,
        opts?: { readonly onStreamMessage?: (value: unknown) => void },
    ) {
        let resolve!: (value: unknown) => void;
        let reject!: (error: unknown) => void;
        const result = new Promise<unknown>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const request = {
            method,
            resolve,
            reject,
            stream: (value: unknown) => opts?.onStreamMessage?.(value),
            cancelled: false,
            disposed: false,
        };
        this.requests.push(request);
        return {
            result,
            send: () => { /* no-op */ },
            cancel: () => {
                request.cancelled = true;
            },
            dispose: () => {
                request.disposed = true;
                reject(new Error("cancelled"));
            },
            ping: async () => { /* no-op */ },
        };
    }
    public async sendNotification(): Promise<void> { /* no-op */ }
}

interface Harness {
    client: Client;
    channel: FakeChannel;
    dispose(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
    const channel = new FakeChannel();
    const pooled = {
        channel: channel as unknown as PooledConnection["channel"],
        endpoint: "wss://test-hub",
        key: "wss://test-hub?token=secret",
        session: {} as PooledConnection["session"],
        lastResultVal: undefined,
        addTraceListener: () => () => { /* no-op */ },
        trace: () => { /* no-op */ },
        dispose: () => { /* no-op */ },
    } as unknown as PooledConnection;

    const pool: IConnectionPool = {
        resolve: async () => pooled,
        dispose: () => { /* no-op */ },
    };

    const server = new HubRpcMcpServer({ pool });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    return {
        client,
        channel,
        dispose: async () => {
            await client.close();
            server.dispose();
        },
    };
}

function parse(res: unknown): any {
    const content = (res as { content: { type: string; text: string }[] }).content;
    return JSON.parse(content[0].text);
}

async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !cond(); i++) {
        await new Promise((r) => setImmediate(r));
    }
}

let active: Harness | undefined;
afterEach(async () => {
    await active?.dispose();
    active = undefined;
});

describe("HubRpcMcpServer task names (integration)", () => {
    it("presents returned image base64 while preserving its raw lastResultVal", async () => {
        const h = (active = await makeHarness());
        const png = "iVBORw0KGgoAAAANSUhEUg==";

        const first = await h.client.callTool({
            name: "runHubRpcScript",
            arguments: { code: `() => ${JSON.stringify(png)}` },
        });
        const firstResult = first as {
            content: { type: string; data?: string; text?: string; mimeType?: string }[];
            structuredContent?: Record<string, unknown>;
        };
        expect(firstResult.content[1]).toEqual({
            type: "image",
            data: png,
            mimeType: "image/png",
        });
        expect(JSON.stringify(firstResult.structuredContent)).not.toContain(png);

        const second = parse(await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ lastResultVal }) => ({
                    unchanged: lastResultVal === ${JSON.stringify(png)},
                    raw: lastResultVal,
                })`,
                presentation: "raw",
            },
        }));
        expect(second.result).toEqual({ unchanged: true, raw: png });
    });

    it("returns literal base64 when raw presentation is requested", async () => {
        const h = (active = await makeHarness());
        const png = "iVBORw0KGgoAAAANSUhEUg==";

        const res = await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `() => ({ data: ${JSON.stringify(png)}, mimeType: "image/png" })`,
                presentation: "raw",
            },
        });
        const result = res as { content: { type: string; text?: string }[] };

        expect(result.content).toHaveLength(1);
        expect(parse(res).result).toEqual({ data: png, mimeType: "image/png" });
    });

    it("supports explicit MCP content and selective raw presentation helpers", async () => {
        const h = (active = await makeHarness());
        const png = "iVBORw0KGgoAAAANSUhEUg==";

        const explicit = await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ mcp }) => mcp.result({
                    value: { width: 1, height: 1 },
                    content: [mcp.image(${JSON.stringify(png)}, "image/png")],
                    isError: true,
                    _meta: { source: "integration" },
                })`,
            },
        }) as {
            content: { type: string; data?: string; mimeType?: string }[];
            isError?: boolean;
            _meta?: Record<string, unknown>;
        };
        expect(explicit.content[1]).toEqual({
            type: "image",
            data: png,
            mimeType: "image/png",
        });
        expect(explicit.isError).toBe(true);
        expect(explicit._meta).toEqual({ source: "integration" });
        expect(parse(explicit).result).toEqual({ width: 1, height: 1 });

        const raw = await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ mcp }) => mcp.raw({
                    data: ${JSON.stringify(png)},
                    mimeType: "image/png",
                })`,
            },
        });
        expect((raw as { content: unknown[] }).content).toHaveLength(1);
        expect(parse(raw).result).toEqual({ data: png, mimeType: "image/png" });
    });

    it("reports a debug name and inFlight that match the RPC actually sent", async () => {
        const h = (active = await makeHarness());

        const res = await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ con }) => con.call("github", "github.repos", "listForOrg", { org: "microsoft" })`,
                foregroundMs: 40,
            },
        });
        const out = parse(res);

        expect(out.status).toBe("running");
        expect(typeof out.taskId).toBe("string");
        // The reported debug name is inferred from the live in-flight RPC...
        expect(out.debugName).toBe(`con.call("github::github.repos::listForOrg")`);
        expect(out.inFlight).toEqual([`con.call("github::github.repos::listForOrg")`]);
        // ...and that matches the method that actually hit the wire.
        expect(h.channel.requests.map((r) => r.method)).toContain("github::github.repos::listForOrg");
    });

    it("uses an explicit label while still tracking the real in-flight RPC", async () => {
        const h = (active = await makeHarness());

        const res = await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ con }) => con.call("vscode", "vscode.window", "showInformationMessage", { message: "Deploy?" })`,
                label: "confirm deploy with user",
                foregroundMs: 40,
            },
        });
        const out = parse(res);

        expect(out.status).toBe("running");
        expect(out.debugName).toBe("confirm deploy with user");
        expect(out.inFlight).toEqual([`con.call("vscode::vscode.window::showInformationMessage")`]);
        expect(h.channel.requests.map((r) => r.method)).toContain("vscode::vscode.window::showInformationMessage");
    });

    it("awaitHubRpcTask returns the completed result once the RPC resolves", async () => {
        const h = (active = await makeHarness());

        const started = parse(await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ con }) => con.call("svc", "iface", "method", {})`,
                foregroundMs: 40,
            },
        }));
        expect(started.status).toBe("running");

        // Resolve the in-flight RPC, then await the task.
        await waitFor(() => h.channel.requests.length === 1);
        h.channel.requests[0].resolve({ ok: true });

        const done = parse(await h.client.callTool({
            name: "awaitHubRpcTask",
            arguments: { taskId: started.taskId, timeoutMs: 2000 },
        }));
        expect(done).toMatchObject({ status: "completed", taskId: started.taskId, result: { ok: true } });
    });

    it("delivers streaming RPC messages to a parked script", async () => {
        const h = (active = await makeHarness());

        const started = parse(await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `async ({ con }) => {
                    const progress = [];
                    const result = await con.call("svc", "jobs", "run", {}, {
                        onStreamMessage: message => {
                            progress.push(message);
                            console.log("stream", message);
                        },
                    });
                    return { progress, result };
                }`,
                foregroundMs: 40,
            },
        }));
        expect(started.status).toBe("running");
        await waitFor(() => h.channel.requests.length === 1);

        h.channel.requests[0].stream({ step: 1 });
        h.channel.requests[0].stream({ step: 2 });
        h.channel.requests[0].resolve({ ok: true });

        const done = parse(await h.client.callTool({
            name: "awaitHubRpcTask",
            arguments: { taskId: started.taskId, timeoutMs: 2000 },
        }));
        expect(done).toMatchObject({
            status: "completed",
            result: {
                progress: [{ step: 1 }, { step: 2 }],
                result: { ok: true },
            },
            logs: [
                { level: "log", text: `stream {"step":1}` },
                { level: "log", text: `stream {"step":2}` },
            ],
        });
    });

    it("returns default stream logs from a parked script", async () => {
        const h = (active = await makeHarness());

        const started = parse(await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ con }) => con.call("hub", "hubrpc.traffic", "watch", {})`,
                foregroundMs: 40,
            },
        }));
        await waitFor(() => h.channel.requests.length === 1);
        h.channel.requests[0].stream({ type: "transit", nodeId: "hub-a" });

        const running = parse(await h.client.callTool({
            name: "awaitHubRpcTask",
            arguments: { taskId: started.taskId, timeoutMs: 10 },
        }));
        expect(running).toMatchObject({
            status: "running",
            logs: [{
                level: "log",
                text: `stream hub::hubrpc.traffic::watch {"type":"transit","nodeId":"hub-a"}`,
            }],
        });

        h.channel.requests[0].resolve({ delivered: 1, dropped: 0 });
    });

    it("presents media returned by a parked task", async () => {
        const h = (active = await makeHarness());
        const png = "iVBORw0KGgoAAAANSUhEUg==";

        const started = parse(await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ con }) => con.call("svc", "iface", "image", {})`,
                foregroundMs: 40,
            },
        }));
        await waitFor(() => h.channel.requests.length === 1);
        h.channel.requests[0].resolve({ data: png, mimeType: "image/png" });

        const result = await h.client.callTool({
            name: "awaitHubRpcTask",
            arguments: { taskId: started.taskId, timeoutMs: 2000 },
        }) as { content: { type: string; data?: string; mimeType?: string }[] };

        expect(result.content[1]).toEqual({
            type: "image",
            data: png,
            mimeType: "image/png",
        });
    });

    it("supersedes a parked task when a new request arrives", async () => {
        const h = (active = await makeHarness());

        const first = parse(await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ con }) => con.call("svc", "iface", "first", {})`,
                label: "first task",
                foregroundMs: 40,
            },
        }));
        expect(first.status).toBe("running");

        const second = parse(await h.client.callTool({
            name: "runHubRpcScript",
            arguments: {
                code: `({ con }) => con.call("svc", "iface", "second", {})`,
                label: "second task",
                foregroundMs: 40,
            },
        }));
        expect(second.status).toBe("running");
        expect(second.supersededTask).toMatchObject({
            taskId: first.taskId,
            debugName: "first task",
            outcome: "cancelled",
        });
        expect(h.channel.requests[0].cancelled).toBe(true);
        expect(h.channel.requests[0].disposed).toBe(true);

        // The superseded task now reports as cancelled.
        const firstState = parse(await h.client.callTool({
            name: "awaitHubRpcTask",
            arguments: { taskId: first.taskId, timeoutMs: 1000 },
        }));
        expect(firstState.status).toBe("cancelled");
    });

});
