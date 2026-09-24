import { stdin, stdout } from "node:process";
import { describe, expect, it, vi } from "vitest";
import { GraphTerminal } from "./inspectGraphTerminal";
import { stripVTControlCharacters } from "node:util";
import { GraphLoader } from "./inspectGraphModel";
import { GraphExplorerModel } from "./inspectGraphView";

vi.mock("node:readline", () => ({ emitKeypressEvents: vi.fn() }));
vi.mock("node:process", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        stdin: Object.assign(new EventEmitter(), {
            isRaw: false,
            readableFlowing: null,
            setRawMode: vi.fn(),
            resume: vi.fn(),
            pause: vi.fn(),
        }),
        stdout: Object.assign(new EventEmitter(), {
            columns: 90, rows: 24, write: vi.fn(),
        }),
    };
});

describe("graph terminal lifecycle", () => {
    it("toggles immutable object IDs during refresh without fetching or moving selection", async () => {
        const fetch = vi.fn(async () => ({ objects: [], missing: [], complete: true }));
        const loader = new GraphLoader(fetch);
        const root = { kind: "node", id: "debug-v1" };
        const nextRoot = { kind: "node", id: "debug-v2" };
        loader.cache.put([{ ref: root, value: { a: 1 } }, { ref: nextRoot, value: { a: 2 } }]);
        const first = new GraphExplorerModel(root, loader);
        first.select(1);
        const frames: string[] = [];
        const terminal = new GraphTerminal("demo", "{}", frame => frames.push(frame));
        try {
            terminal.update(first, 1);
            expect(frames.at(-1)).not.toContain("debug-v1");
            await terminal.beginUpdate();
            stdin.emit("keypress", "i", { name: "i" });
            expect(frames.at(-1)).toContain("node:debug-v1");
            expect(first.selectedKey).toBe("$.a");
            await terminal.finishUpdate(new GraphExplorerModel(nextRoot, loader), 2);
            expect(frames.at(-1)).toContain("node:debug-v2");
            stdin.emit("keypress", "i", { name: "i" });
            expect(frames.at(-1)).not.toContain("debug-v2");
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            terminal.dispose();
        }
    });

    it("preserves navigation and collapse made while replacement objects are loading", async () => {
        const root = { kind: "node", id: "root" };
        const nextRoot = { kind: "node", id: "root2" };
        const child = { kind: "node", id: "child" };
        const nextChild = { kind: "node", id: "child2" };
        let release!: () => void;
        let started!: () => void;
        const fetching = new Promise<void>(resolve => { started = resolve; });
        const pending = new Promise<void>(resolve => { release = resolve; });
        const loader = new GraphLoader(async () => {
            started();
            await pending;
            return { objects: [{ ref: nextChild, value: { title: "new" } }], missing: [], complete: true };
        });
        loader.cache.put([
            { ref: root, value: { child, other: 1 } },
            { ref: child, value: { title: "old" } },
            { ref: nextRoot, value: { child: nextChild, other: 2 } },
        ]);
        const first = new GraphExplorerModel(root, loader);
        first.select(1);
        await first.expandSelected();
        const terminal = new GraphTerminal("demo", "{}", () => {});
        try {
            terminal.update(first, 1);
            await terminal.beginUpdate();
            const next = new GraphExplorerModel(nextRoot, loader);
            const updating = terminal.finishUpdate(next, 2);
            await fetching;
            stdin.emit("keypress", "", { name: "left" });
            stdin.emit("keypress", "", { name: "down" });
            expect(first.selectedKey).toBe("$.other");
            release();
            await updating;
            expect(next.selectedKey).toBe("$.other");
            expect(next.lines.map(line => line.key)).toEqual(["$", "$.child", "$.other"]);
        } finally {
            release();
            terminal.dispose();
        }
    });

    it("allows navigation during refresh instead of dropping keys", async () => {
        const loader = new GraphLoader(async () => ({ objects: [], missing: [], complete: true }));
        const root = { kind: "node", id: "root" };
        loader.cache.put([{ ref: root, value: { a: 1, b: 2 } }]);
        const model = new GraphExplorerModel(root, loader);
        const terminal = new GraphTerminal("demo", "{}", () => {});
        try {
            terminal.update(model, 1);
            await terminal.beginUpdate();
            stdin.emit("keypress", "", { name: "down" });
            expect(model.selectedKey).toBe("$.a");
        } finally {
            terminal.dispose();
        }
    });

    it("keeps the top visible path through root refreshes and resumes scrolling on navigation", async () => {
        const makeModel = async (id: string, extra: number, selectedKey?: string) => {
            const root = { kind: "root", id };
            const value = Object.fromEntries([
                ...Array.from({ length: extra }, (_, i) => [`inserted${i}`, i]),
                ...Array.from({ length: 60 }, (_, i) => [`item${i}`, `${id}-${i}`]),
            ]);
            const loader = new GraphLoader(async () => ({
                objects: [{ ref: root, value }], missing: [], complete: true,
            }));
            await loader.load([{ ref: root, paths: ["/"] }]);
            return new GraphExplorerModel(root, loader, undefined, { selectedKey });
        };
        const frames: string[] = [];
        const terminal = new GraphTerminal("demo", "{}", frame => frames.push(frame));
        try {
            const first = await makeModel("v1", 0);
            first.select(30);
            terminal.update(first, 1);
            const top = () => stripVTControlCharacters(frames.at(-1)!.split(/\x1b\[\d+;1H/)[4]);
            expect(top()).toContain("item13");
            await terminal.beginUpdate();
            terminal.update(await makeModel("v2", 8, first.selectedKey), 2);
            expect(top()).toContain("item13");
            expect(top()).toContain("v2-13");

            // A removed selection falls back to the root, but must not pull the
            // viewport away from the surviving top path during refresh.
            await terminal.beginUpdate();
            terminal.update(await makeModel("v3", 2, "$.removed"), 3);
            expect(top()).toContain("item13");
            stdin.emit("keypress", "", { name: "home" });
            await terminal.beginUpdate();
            expect(top()).toContain("root");
        } finally {
            terminal.dispose();
        }
    });

    it.each([
        ["q", { name: "q" }],
        ["\x03", { name: "c", ctrl: true }],
    ])("restores the terminal and releases idle input on %s", async (text, key) => {
        vi.clearAllMocks();
        const terminal = new GraphTerminal("demo", "{}");
        expect(stdin.setRawMode).toHaveBeenCalledWith(true);
        stdin.emit("keypress", text, key);
        await terminal.result;
        terminal.dispose();
        expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
        expect(stdin.pause).toHaveBeenCalledOnce();
        expect(stdin.listenerCount("keypress")).toBe(0);
        expect(stdout.listenerCount("resize")).toBe(0);
        expect(stdout.write).toHaveBeenLastCalledWith("\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l");
    });
});
