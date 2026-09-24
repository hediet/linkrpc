import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { GraphLoader } from "./inspectGraphModel";
import { GraphExplorerModel } from "./inspectGraphView";
import { anchorGraphScrollTop, renderGraphScreen } from "./inspectGraphTerminal";

describe("graph terminal screen", () => {
    it("anchors by path rather than immutable identity and falls back to a surviving neighbor", () => {
        const lines = (keys: string[]) => keys.map(key => ({ key, depth: 0, text: key, expandable: false }));
        const old = lines(["$", "$.a", "$.b", "$.c", "$.d"]);
        expect(anchorGraphScrollTop(old, lines(["$", "$.new", "$.a", "$.b", "$.c", "$.d"]), 2)).toBe(3);
        expect(anchorGraphScrollTop(old, lines(["$", "$.a", "$.c", "$.d"]), 2)).toBe(2);
        expect(anchorGraphScrollTop(old, lines(["$", "$.a"]), 4)).toBe(1);
        expect(anchorGraphScrollTop(old, [], 2)).toBe(2);
    });

    it("renders a compact tree, live header and keyboard hints without a command prompt", async () => {
        const root = { kind: "list", id: "v1" };
        const child = { kind: "session", id: "alpha" };
        const loader = new GraphLoader(async () => ({
            objects: [{ ref: root, value: { sessions: [child], count: 1 } }],
            missing: [], complete: true,
        }));
        await loader.load([{ ref: root, paths: ["/"] }]);
        const model = new GraphExplorerModel(root, loader);
        model.select(1);
        const screen = renderGraphScreen(model, {
            title: "local / demo.graph / sessions", params: '{"list":"sessions"}',
            version: 3, columns: 90, rows: 12, scrollTop: 0,
        });
        const plain = stripVTControlCharacters(screen.text.replace(/\x1b\[\d+;1H/g, "\n"));
        expect(plain).toContain("GRAPH EXPLORER    LIVE  v3");
        expect(plain).toContain("\u251c\u2500 \u25b8 sessions[0]  session  [fetch on expand]");
        expect(plain).not.toContain("session:alpha");
        expect(plain).toContain("i IDs:off");
        expect(plain).toContain("\u2514\u2500   count  1");
        expect(plain).toContain("2/3  1 cached objects");
        expect(plain).toContain("Enter open");
        expect(plain).not.toContain("graph>");
        expect(screen.text).toContain("\x1b[1;30;46m");
    });

    it("scrolls to the selection and confines content to the terminal viewport", async () => {
        const root = { kind: "node", id: "root" };
        const loader = new GraphLoader(async () => ({
            objects: [{ ref: root, value: Array.from({ length: 30 }, (_, i) => `row ${i}`) }],
            missing: [], complete: true,
        }));
        await loader.load([{ ref: root, paths: ["/"] }]);
        const model = new GraphExplorerModel(root, loader);
        model.select(25);
        const screen = renderGraphScreen(model, {
            title: "Demo", params: "", columns: 40, rows: 12, scrollTop: 0,
        });
        expect(screen.scrollTop).toBe(21);
        const rows = screen.text.split(/\x1b\[\d+;1H/).slice(1).map(stripVTControlCharacters);
        expect(rows.length).toBeLessThanOrEqual(12);
        expect(rows.every(row => [...row].length <= 39)).toBe(true);
        expect(rows.join("\n")).toContain("row 24");
    });

    it("escapes control characters supplied by a remote graph", async () => {
        const root = { kind: "node", id: "\x1b[2J" };
        const loader = new GraphLoader(async () => ({
            objects: [{ ref: root, value: {} }], missing: [], complete: true,
        }));
        await loader.load([{ ref: root, paths: ["/"] }]);
        const screen = renderGraphScreen(new GraphExplorerModel(root, loader), {
            title: "Demo\nInjected", params: "", columns: 100, rows: 12, scrollTop: 0,
            showObjectIds: true,
        });
        expect(screen.text).not.toContain("\x1b[2J");
        expect(screen.text).toContain("\\u{001b}[2J");
        expect(screen.text).toContain("Demo\\u{000a}Injected");
    });
});
