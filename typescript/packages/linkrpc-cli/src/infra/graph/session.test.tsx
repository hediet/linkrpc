import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { GraphSession } from "./session";
import type { InspectGraphOptions, GraphTarget } from "./inspectGraph";
import { GraphExplorerModel } from "./inspectGraphView";
import { GraphLoader, GraphObjectCache } from "./inspectGraphModel";
import type { ViewOpenContext } from "../../views/types";
import { dispatchViewKey, formatCommandLegend } from "../../views/commands";
import { renderGraphScreen } from "./inspectGraphTerminal";
import { ViewFrame } from "../../views/ViewFrame";

const calls = vi.hoisted(() => [] as {
    options: InspectGraphOptions; reject: (error: unknown) => void;
}[]);
vi.mock("./inspectGraph", () => ({
    inspectGraphCommand: vi.fn((_channel: unknown, options: InspectGraphOptions) => new Promise<string>((resolve, reject) => {
        calls.push({ options, reject });
        void options.stop?.then(() => resolve(""));
    })),
}));

const roots = ["main", "other"].map(root => ({
    serviceId: "", interfaceId: "test", hash: "hash", graphInterfaceId: "test", root,
    watchMethod: "watch", batchMethod: "get",
    paramsArgument: { schema: { type: "object", properties: {} } },
    refArgument: { schema: true }, valueArgument: { schema: true },
})) as GraphTarget[];
const context = { channel: {}, target: { id: "service::" }, interfaces: [] } as unknown as ViewOpenContext;
const sessions: GraphSession[] = [];
function fixture(): GraphSession {
    const session = new GraphSession(context, roots);
    sessions.push(session);
    return session;
}
async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 10)); }

afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); calls.length = 0; });

describe("Ink graph view session", () => {
    it("starts with a root/parameter picker and no live call", () => {
        const session = fixture();
        expect(calls).toHaveLength(0);
        expect(session.state.get().active).toBe(false);
        dispatchViewKey(session, { input: "", name: "down" });
        session.update({ params: '{"workspace":"demo"}' });
        dispatchViewKey(session, { input: "", name: "return" });
        expect(calls[0]!.options.root).toBe("other");
        expect(calls[0]!.options.params).toEqual({ workspace: "demo" });
    });

    it("cancels an inactive session and ignores late models", async () => {
        const session = fixture();
        session.start();
        const call = calls[0]!;
        session.dispose();
        await call.options.stop;
        await call.options.onModel?.({} as GraphExplorerModel, 9);
        expect(session.state.get().model).toBeUndefined();
    });

    it("cancels a previous root before restarting and rejects stale results", async () => {
        const session = fixture();
        session.start();
        const previous = calls[0]!;
        dispatchViewKey(session, { input: "r" });
        await previous.options.stop;
        dispatchViewKey(session, { input: "", name: "down" });
        dispatchViewKey(session, { input: "", name: "return" });
        await previous.options.onModel?.({} as GraphExplorerModel, 1);
        expect(session.state.get().model).toBeUndefined();
        expect(calls[1]!.options.root).toBe("other");
    });

    it("edits JSON without intercepting ordinary view hotkeys", () => {
        const session = fixture();
        dispatchViewKey(session, { input: "p" });
        expect(session.capturesInput).toBe(true);
        session.update({ params: "" });
        dispatchViewKey(session, { input: '{"query":"qvr"}' });
        dispatchViewKey(session, { input: "", name: "return" });
        expect(session.capturesInput).toBe(false);
        dispatchViewKey(session, { input: "", name: "return" });
        expect(calls[0]!.options.params).toEqual({ query: "qvr" });
    });

    it("retains root and params across reconnect without accepting old results", () => {
        const session = fixture();
        session.update({ cursor: 1, params: '{"scope":1}' });
        session.start();
        const state = session.captureState();
        session.dispose();
        const next = fixture();
        next.restoreState(state);
        expect(calls[1]!.options.root).toBe("other");
        expect(calls[1]!.options.params).toEqual({ scope: 1 });
    });

    it("navigates a graph with Ink rather than a raw stdout terminal", async () => {
        const session = fixture();
        session.start();
        const cache = new GraphObjectCache();
        const ref = { kind: "node", id: "root" };
        cache.put([{ ref, value: { title: "hello" } }]);
        const model = new GraphExplorerModel(ref, new GraphLoader(async () => { throw new Error("Unexpected load"); }, cache));
        await calls[0]!.options.onModel?.(model, 4);
        dispatchViewKey(session, { input: "", name: "down" });
        await settle();
        expect(model.selectedIndex).toBe(1);
        const output = new PassThrough();
        let text = "";
        output.on("data", chunk => { text += String(chunk); });
        const instance = render(session.element, {
            stdout: output as never, stderr: output as never, stdin: new PassThrough() as never,
            debug: true, exitOnCtrlC: false, patchConsole: false,
        });
        try {
            await settle();
            expect(text).toContain("GRAPH EXPLORER    LIVE  v4");
            expect(text).toContain("hello");
            expect(text).not.toContain("\x1b[?1049h");
        } finally { instance.unmount(); output.destroy(); }
    });

    it("publishes only currently available root and editing commands", () => {
        const session = fixture();
        const legend = () => formatCommandLegend(session.commands.get());
        expect(legend()).toContain("Open root");
        expect(legend()).toContain("Next");
        expect(legend()).not.toContain("Previous");
        expect(legend()).not.toContain("Expand");
        expect(dispatchViewKey(session, { input: "", name: "up" })).toBe(false);
        dispatchViewKey(session, { input: "p" });
        expect(legend()).toContain("Finish parameters");
        expect(legend()).not.toContain("Open root");
        expect(legend()).not.toContain("Roots");
        dispatchViewKey(session, { input: "", name: "escape" });
        expect(legend()).toContain("Open root");
        session.dispose();
        expect(session.commands.get()).toEqual([]);
        expect(dispatchViewKey(session, { input: "", name: "return" })).toBe(false);
    });

    it("supports paging, endpoints, parent navigation and dynamic ID toggle", async () => {
        const session = fixture();
        session.start();
        session.setViewport(10);
        const cache = new GraphObjectCache();
        const ref = { kind: "node", id: "root" };
        cache.put([{ ref, value: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, i])) }]);
        const model = new GraphExplorerModel(ref, new GraphLoader(async () => { throw new Error("Unexpected load"); }, cache));
        await calls[0]!.options.onModel?.(model, 1);
        dispatchViewKey(session, { input: "", name: "pagedown" });
        await settle();
        expect(model.selectedIndex).toBe(4);
        dispatchViewKey(session, { input: "", name: "end" });
        await settle();
        expect(model.selectedIndex).toBe(20);
        dispatchViewKey(session, { input: "", name: "pageup" });
        await settle();
        expect(model.selectedIndex).toBe(16);
        dispatchViewKey(session, { input: "", name: "home" });
        await settle();
        expect(model.selectedIndex).toBe(0);
        dispatchViewKey(session, { input: "j" });
        await settle();
        dispatchViewKey(session, { input: "", name: "backspace" });
        await settle();
        expect(model.selectedIndex).toBe(0);
        expect(formatCommandLegend(session.commands.get())).toContain("Show object IDs");
        dispatchViewKey(session, { input: "i" });
        expect(formatCommandLegend(session.commands.get())).toContain("Hide object IDs");
        expect(session.state.get().showObjectIds).toBe(true);
    });

    it("renders the POC tree hierarchy in Ink with full-width selected rows", async () => {
        const session = fixture();
        session.start();
        session.setViewport(18, 88);
        const root = { kind: "workspace", id: "root-v1" }, child = { kind: "session", id: "alpha" };
        const missing = { kind: "message", id: "unloaded" };
        const cache = new GraphObjectCache();
        cache.put([
            { ref: root, value: { title: "Workspace", sessions: [child], unloaded: missing, count: 1 } },
            { ref: child, value: { title: "Alpha", status: "active", parent: root } },
            { ref: missing, value: { text: "Collapsed message" } },
        ]);
        const model = new GraphExplorerModel(root, new GraphLoader(async () => { throw new Error("Unexpected load"); }, cache));
        model.select(2);
        await model.expandSelected();
        await calls[0]!.options.onModel?.(model, 3);
        const output = await capturePanel(session, 88);
        const rows = stripVTControlCharacters(output).trimEnd().split("\n");
        expect(rows).toHaveLength(18);
        expect(rows[0]).toBe(" GRAPH EXPLORER    LIVE  v3");
        expect(rows[1]).toBe(" local / test / main  params: {}");
        expect(rows[3]).toBe(" ▾ root  workspace  Workspace");
        expect(rows[4]).toBe(' ├─   title  "Workspace"');
        expect(rows[5]!.trimEnd()).toBe(" ├─ ▾ sessions[0]  session  Alpha");
        if (process.env.FORCE_COLOR) expect(rows[5]).toHaveLength(88);
        expect(rows[6]).toBe(' │  ├─   title  "Alpha"');
        expect(rows[7]).toBe(' │  ├─   status  "active"');
        expect(rows[8]).toBe(" │  └─ ↪ parent  workspace  Workspace  [link to $]");
        expect(rows[9]).toBe(" ├─ ▸ unloaded  message");
        expect(rows[10]).toBe(" └─   count  1");
        expect(rows[16]).toBe(" $.sessions[0]");
        expect(rows[17]).toContain("3/8  3 cached objects  IDs:off");
        expect(rows.slice(3, 15).join("\n")).not.toContain("$.sessions");
        const old = stripVTControlCharacters(renderGraphScreen(model, {
            title: "local / test / main", params: "{}", version: 3, columns: 89, rows: 19, scrollTop: 0,
        }).text.replace(/\x1b\[\d+;1H/g, "\n"));
        for (const row of rows.slice(3, 11)) expect(old).toContain(row.trimEnd());
        if (process.env.FORCE_COLOR) expect(output).toContain("\x1b[46m");
        dispatchViewKey(session, { input: "i" });
        expect(stripVTControlCharacters(await capturePanel(session, 88))).toContain("session:alpha");
    });

    it("keeps the old viewport anchored by path across immutable refreshes", async () => {
        const session = fixture();
        session.start();
        session.setViewport(12, 55);
        const cache = new GraphObjectCache();
        const create = (version: number, prefix = false) => {
            const ref = { kind: "root", id: String(version) };
            cache.put([{ ref, value: { ...prefix ? { inserted: true } : {},
                ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`row${i}`, i])) } }]);
            return new GraphExplorerModel(ref, new GraphLoader(async () => { throw new Error("Unexpected load"); }, cache));
        };
        const original = create(1);
        await calls[0]!.options.onModel?.(original, 1);
        dispatchViewKey(session, { input: "", name: "pagedown" });
        await settle();
        dispatchViewKey(session, { input: "", name: "pagedown" });
        await settle();
        const before = stripVTControlCharacters(await capturePanel(session, 55)).split("\n");
        const top = original.lines[session.state.get().scrollTop!]!.key;
        const selected = original.selectedKey;
        await calls[0]!.options.onUpdating?.();
        expect(stripVTControlCharacters(await capturePanel(session, 55))).toContain("Refreshing root…");
        const next = create(2, true);
        await calls[0]!.options.onModel?.(next, 2);
        const after = stripVTControlCharacters(await capturePanel(session, 55)).split("\n");
        expect(next.lines[session.state.get().scrollTop!]!.key).toBe(top);
        expect(next.selectedKey).toBe(selected);
        expect(after.slice(3, 9)).toEqual(before.slice(3, 9));
        expect(after[0]).toContain("v2");
        expect(after[10]).toBe(` ${selected}`);
    });

    it("clips unsafe and wide text once in narrow Ink viewports, keeping errors and stale snapshots", async () => {
        const session = fixture();
        session.start();
        session.setViewport(10, 27);
        const cache = new GraphObjectCache(), ref = { kind: "node", id: "\x1b[2J" };
        cache.put([{ ref, value: { unicode: "漢字😀".repeat(30), "long-property-name-abcdefgh": 42 } }]);
        const model = new GraphExplorerModel(ref, new GraphLoader(async () => { throw new Error("Unexpected load"); }, cache));
        await calls[0]!.options.onModel?.(model, 1);
        dispatchViewKey(session, { input: "i" });
        let output = stripVTControlCharacters(await capturePanel(session, 27));
        expect(output).not.toContain("\x1b[2J");
        expect(output).toContain("\\u{001b}");
        expect(output).toContain("漢字😀");
        expect(output.trimEnd().split("\n")).toHaveLength(10);
        expect(output).not.toContain("……");
        calls[0]!.reject(new Error("Disconnected\nremote error"));
        await settle();
        output = stripVTControlCharacters(await capturePanel(session, 27));
        expect(output).toContain("STOPPED");
        expect(output).toContain("long-property");
        expect(output).toContain("Error: Disconnected");
        expect(output.trimEnd().split("\n")).toHaveLength(10);
        session.setViewport(16, 70);
        expect(stripVTControlCharacters(await capturePanel(session, 70)).trimEnd().split("\n")).toHaveLength(16);
    });

    it("shows object loading without dropping the last rendered tree", async () => {
        const session = fixture();
        session.start();
        session.setViewport(12, 65);
        const root = { kind: "root", id: "v1" }, child = { kind: "child", id: "c1" };
        const nested = { kind: "nested", id: "n1" };
        const cache = new GraphObjectCache();
        cache.put([
            { ref: root, value: { child } },
            { ref: child, value: { title: "Loaded child", nested } },
        ]);
        let finish!: () => void;
        const loading = new Promise<void>(resolve => { finish = resolve; });
        const model = new GraphExplorerModel(root, new GraphLoader(async () => {
            await loading;
            return { objects: [{ ref: nested, value: { title: "Nested title" } }], missing: [], complete: true };
        }, cache));
        model.select(1);
        await calls[0]!.options.onModel?.(model, 1);
        dispatchViewKey(session, { input: "", name: "right" });
        await settle();
        const loadingFrame = stripVTControlCharacters(await capturePanel(session, 65));
        expect(loadingFrame).toContain("Loading object…");
        expect(loadingFrame).toContain("child  child  Loaded child");
        expect(loadingFrame).toContain("nested  nested  [fetch on expand]");
        finish();
        await settle();
        const loadedFrame = stripVTControlCharacters(await capturePanel(session, 65));
        expect(loadedFrame).toContain("Loaded child");
        expect(loadedFrame).toContain("Nested title");
        expect(loadedFrame).toContain("$.child");
        expect(loadedFrame).toContain("3 cached objects");
        expect(loadedFrame).not.toContain("Loading object");
    });

    it("gives the graph precisely the remaining standalone and tabbed frame rows", async () => {
        const session = fixture();
        session.start();
        for (const tabbed of [false, true]) {
            const output = new PassThrough();
            let text = "";
            output.on("data", chunk => { text += String(chunk); });
            const instance = render(<ViewFrame session={session} rows={20} columns={70} tabbed={tabbed} />, {
                stdout: Object.assign(output, { columns: 70 }) as never, stderr: output as never,
                stdin: new PassThrough() as never, debug: true, exitOnCtrlC: false, patchConsole: false,
            });
            try {
                await settle();
                const frames = stripVTControlCharacters(text).split(" GRAPH EXPLORER").slice(1);
                const last = " GRAPH EXPLORER" + frames.at(-1)!;
                expect(last.trimEnd().split("\n")).toHaveLength(20);
                expect(last).toContain("Waiting for first root");
                expect(session.state.get().viewportColumns).toBe(70);
                expect(session.state.get().viewportRows).toBeLessThan(20);
            } finally { instance.unmount(); output.destroy(); }
        }
    });
});

async function capturePanel(session: GraphSession, columns: number): Promise<string> {
    const output = Object.assign(new PassThrough(), { columns });
    let text = "";
    output.on("data", chunk => { if (String(chunk).includes("GRAPH")) text = String(chunk); });
    const instance = render(session.element, {
        stdout: output as never, stderr: output as never, stdin: new PassThrough() as never,
        debug: true, exitOnCtrlC: false, patchConsole: false,
    });
    try { await settle(); return text; }
    finally { instance.unmount(); output.destroy(); }
}
