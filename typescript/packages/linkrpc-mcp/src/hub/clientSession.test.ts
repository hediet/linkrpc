import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { upstreamSessionFactory } from "./clientSession";

describe("upstreamSessionFactory", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("leaves tool call timeouts to the caller's signal", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const f = await slowToolSession();
        try {
            const pending = f.session.callTool("slow", undefined);
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            f.finish();
            expect(await pending).toEqual({ content: [{ type: "text", text: "done" }] });

            const controller = new AbortController();
            const cancelled = f.session.callTool("slow", undefined, controller.signal);
            controller.abort(new Error("caller gave up"));
            await expect(cancelled).rejects.toThrow("caller gave up");
        } finally {
            f.finish();
            await f.close();
        }
    });
});

async function slowToolSession() {
    const server = new Server({ name: "slow", version: "1" }, { capabilities: { tools: {} } });
    const waiting: (() => void)[] = [];
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "slow", inputSchema: { type: "object" } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
        await new Promise<void>((resolve) => waiting.push(resolve));
        return { content: [{ type: "text", text: "done" }] };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const session = await upstreamSessionFactory({ label: "slow", createTransport: () => clientTransport }).open({
        sessionId: "s", identityId: "default", signal: new AbortController().signal, onToolsChanged: () => {},
    });
    return {
        session,
        finish: () => { for (const resolve of waiting.splice(0)) resolve(); },
        close: async () => { await session.close(); await server.close(); },
    };
}
