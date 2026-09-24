import { stdin, stdout } from "node:process";
import { describe, expect, it, vi } from "vitest";
import { runGraphTui } from "./session";
import type { GraphTarget, InspectGraphOptions } from "./inspectGraph";
import type { ViewOpenContext } from "../../views/types";

const state = vi.hoisted(() => ({
    exit: undefined as (() => void) | undefined,
    exitPromise: undefined as Promise<void> | undefined,
    cleanupStarted: false,
    cleanup: undefined as Promise<void> | undefined,
}));
vi.mock("node:readline", () => ({ emitKeypressEvents: vi.fn() }));
vi.mock("node:process", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        stdin: Object.assign(new EventEmitter(), {
            isTTY: true, isRaw: false, readableFlowing: false,
            setRawMode: vi.fn(), resume: vi.fn(), pause: vi.fn(),
        }),
        stdout: Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24 }),
    };
});
vi.mock("ink", () => ({
    Box: () => null, Text: () => null,
    render: () => ({ waitUntilExit: () => state.exitPromise, unmount: () => state.exit?.() }),
}));
vi.mock("./inspectGraph", () => ({
    inspectGraphCommand: async (_channel: unknown, options: InspectGraphOptions) => {
        await options.stop;
        state.cleanupStarted = true;
        await state.cleanup;
        return "";
    },
}));

describe("standalone Ink graph teardown", () => {
    it("drains cancelled graph work before returning ownership of the connection", async () => {
        state.exitPromise = new Promise<void>(resolve => { state.exit = resolve; });
        let finishCleanup!: () => void;
        state.cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
        state.cleanupStarted = false;
        const root = { root: "workspace", interfaceId: "test", paramsArgument: { schema: true } } as GraphTarget;
        const context = { channel: {}, target: { id: "service::" }, interfaces: [] } as unknown as ViewOpenContext;
        let returned = false;
        const running = runGraphTui(context, [root], {}).then(() => { returned = true; });
        try {
            stdin.emit("keypress", "q", { name: "q" });
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(state.cleanupStarted).toBe(true);
            expect(returned).toBe(false);
            expect(stdin.listenerCount("keypress")).toBe(0);
            expect(stdout.listenerCount("resize")).toBe(0);
            expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
        } finally {
            finishCleanup();
            await running;
        }
        expect(returned).toBe(true);
    });
});
