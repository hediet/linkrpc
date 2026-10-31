import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@hediet/linkrpc";
import { McpSessionManager } from "./sessionManager";
import type { McpClientSession, McpSessionFactory } from "./clientSession";

function createFactory() {
    const opened: string[] = [];
    const closed: string[] = [];
    const factory: McpSessionFactory = {
        open: async ({ sessionId }) => {
            opened.push(sessionId);
            const session: McpClientSession = {
                listTools: async () => [],
                callTool: async () => ({ content: [] }) as JsonValue,
                close: async () => {
                    closed.push(sessionId);
                },
            };
            return session;
        },
    };
    return { factory, opened, closed };
}

describe("McpSessionManager", () => {
    it("uses the empty string as the default session and reuses keyed sessions", async () => {
        const { factory, opened } = createFactory();
        const manager = new McpSessionManager({ factory });

        expect(await manager.get(undefined)).toBe(await manager.get(""));
        expect(await manager.get("alpha")).toBe(await manager.get("alpha"));
        expect(opened).toEqual(["", "alpha"]);
        expect(manager.activeSessionCount).toBe(2);

        await manager.dispose();
    });

    it("closes sessions at idle and maximum-lifetime bounds", async () => {
        vi.useFakeTimers();
        try {
            const { factory, closed } = createFactory();
            const manager = new McpSessionManager({
                factory,
                idleTimeoutMs: 100,
                maxLifetimeMs: 250,
            });
            await manager.get("idle");
            await vi.advanceTimersByTimeAsync(100);
            expect(closed).toEqual(["idle"]);

            await manager.get("ttl");
            await vi.advanceTimersByTimeAsync(80);
            await manager.get("ttl");
            await vi.advanceTimersByTimeAsync(80);
            await manager.get("ttl");
            await vi.advanceTimersByTimeAsync(90);
            expect(closed).toEqual(["idle", "ttl"]);
            await manager.dispose();
        } finally {
            vi.useRealTimers();
        }
    });

    it("evicts the least recently used session at capacity", async () => {
        let now = 0;
        const { factory, closed } = createFactory();
        const manager = new McpSessionManager({ factory, maxSessions: 2, now: () => now });
        await manager.get("a");
        now = 1;
        await manager.get("b");
        now = 2;
        await manager.get("a");
        now = 3;
        await manager.get("c");

        expect(closed).toEqual(["b"]);
        expect(manager.activeSessionCount).toBe(2);
        await manager.dispose();
    });

    it("opens a new session only once under concurrent first use", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let openCount = 0;
        const session: McpClientSession = {
            listTools: async () => [],
            callTool: async () => ({ content: [] }) as JsonValue,
            close: async () => {},
        };
        const manager = new McpSessionManager({
            factory: {
                open: async () => {
                    openCount++;
                    await gate;
                    return session;
                },
            },
        });

        const first = manager.get("same");
        const second = manager.get("same");
        release();

        expect(await first).toBe(session);
        expect(await second).toBe(session);
        expect(openCount).toBe(1);
        await manager.dispose();
    });

    it("does not apply idle timeout while an operation is in flight", async () => {
        vi.useFakeTimers();
        try {
            const { factory, closed } = createFactory();
            const manager = new McpSessionManager({ factory, idleTimeoutMs: 100 });
            let release!: () => void;
            const operation = manager.use("busy", async () => new Promise<void>((resolve) => {
                release = resolve;
            }));

            await vi.advanceTimersByTimeAsync(200);
            expect(closed).toEqual([]);
            release();
            await operation;
            await vi.advanceTimersByTimeAsync(100);
            expect(closed).toEqual(["busy"]);
            await manager.dispose();
        } finally {
            vi.useRealTimers();
        }
    });
});
