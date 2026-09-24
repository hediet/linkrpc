import { describe, expect, it, vi } from "vitest";
import { observableValue } from "@vscode/observables";
import type { CliChannel } from "@hediet/linkrpc-client";
import type { MethodKey, SchemaState } from "./UiModel";
import { ViewController } from "./ViewController";
import type { ViewOpenContext } from "../views/types";

const mocked = vi.hoisted(() => ({
    loads: [] as { resolve: (context: ViewOpenContext) => void }[],
    sessions: [] as { dispose: ReturnType<typeof vi.fn>; restoreState: ReturnType<typeof vi.fn> }[],
}));
vi.mock("../views/discovery", () => ({
    resolveViewTarget: () => new Promise<ViewOpenContext>(resolve => mocked.loads.push({ resolve })),
}));
vi.mock("../views/registry", () => ({
    views: [{
        id: "graph", title: "Graph",
        conditions: [{ kind: "interface", interface: { tag: "linkrpc.graph" } },
            { kind: "service", implements: { tag: "linkrpc.graph" } }],
        createSession() {
            const session = { element: null, dispose: vi.fn(), restoreState: vi.fn(),
                captureState: () => ({ root: "sessions" }), commands: observableValue("commands", []) };
            mocked.sessions.push(session);
            return session;
        },
    }],
}));

function fixture() {
    mocked.loads.length = 0; mocked.sessions.length = 0;
    const selection = observableValue<MethodKey | undefined>("selection", { serviceId: "worker", interfaceId: "test", methodName: undefined });
    const schema = observableValue<SchemaState>("schema", {
        kind: "loaded", schema: { id: "test", hash: "x", methods: {}, tags: ["linkrpc.graph"] }, method: undefined,
    });
    const controller = new ViewController({} as CliChannel, selection, schema, () => []);
    return { controller, selection };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

describe("contributed view lifetimes", () => {
    it("does no work in Methods/Schema; shows conditions; cancels when inactive", async () => {
        const { controller } = fixture();
        try {
            expect(mocked.loads).toHaveLength(0);
            expect(controller.tabs.get()[2]?.condition).toContain("interface:tag(linkrpc.graph)");
            controller.tab.set("schema", undefined);
            expect(mocked.loads).toHaveLength(0);
            controller.tab.set("graph", undefined);
            mocked.loads[0]!.resolve({} as ViewOpenContext);
            await settle();
            controller.tab.set("methods", undefined);
            expect(mocked.sessions[0]!.dispose).toHaveBeenCalledOnce();
        } finally { controller.dispose(); }
    });
    it("discards a late schema resolution after selection changes", async () => {
        const { controller, selection } = fixture();
        try {
            controller.tab.set("graph", undefined);
            selection.set({ serviceId: "next", interfaceId: "test", methodName: undefined }, undefined);
            mocked.loads[0]!.resolve({} as ViewOpenContext);
            await settle();
            expect(mocked.sessions).toHaveLength(0);
            mocked.loads[1]!.resolve({} as ViewOpenContext);
            await settle();
            expect(mocked.sessions).toHaveLength(1);
        } finally { controller.dispose(); }
    });
    it("disconnect cancels promptly and reconnect reloads only an active view", async () => {
        const { controller } = fixture();
        try {
            controller.tab.set("graph", undefined);
            mocked.loads[0]!.resolve({} as ViewOpenContext);
            await settle();
            controller.disconnect();
            expect(mocked.sessions[0]!.dispose).toHaveBeenCalledOnce();
            expect(mocked.loads).toHaveLength(1);
            controller.reconnect();
            mocked.loads[1]!.resolve({} as ViewOpenContext);
            await settle();
            expect(mocked.sessions[1]!.restoreState).toHaveBeenCalledWith({ root: "sessions" });
            controller.tab.set("methods", undefined);
            controller.reconnect();
            expect(mocked.loads).toHaveLength(2);
        } finally { controller.dispose(); }
    });
});
