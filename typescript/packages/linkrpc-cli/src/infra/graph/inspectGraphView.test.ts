import { describe, expect, it, vi } from "vitest";
import { GraphLoader, graphRefKey, type GraphRef, type GraphBatchFetch } from "./inspectGraphModel";
import { GraphTimings } from "./inspectGraphTiming";
import { ImmutableGraphRuntime, InMemoryImmutableGraphStore, standardGraphRuntimeOptions } from "@hediet/linkrpc-infra/graph";
import type { JsonValue } from "@hediet/linkrpc";
import {
    GraphExplorerModel,
    loadGraphDepth,
    renderGraphJson,
    renderGraphTree,
} from "./inspectGraphView";

describe("GraphExplorerModel", () => {
    const root: GraphRef = { kind: "node", id: "root" };
    const child: GraphRef = { kind: "node", id: "child" };

    it("loads collapsed rows one level ahead, without fetching their descendants", async () => {
        const detail = { kind: "node", id: "detail" };
        const nested = { kind: "node", id: "nested" };
        const store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
        store.set(root, { items: [child, child] });
        store.set(child, { title: "Child title", detail });
        store.set(detail, { title: "Detail title", nested });
        store.set(nested, { title: "Nested title" });
        const runtime = new ImmutableGraphRuntime(store, standardGraphRuntimeOptions);
        const fetch = vi.fn<GraphBatchFetch>(request => runtime.batchObjGet(request));
        const loader = new GraphLoader(fetch);
        await loadGraphDepth(root, loader, 0);
        const model = new GraphExplorerModel(root, loader);
        fetch.mockClear();
        await model.restoreExpanded();
        expect(fetch.mock.calls.map(([request]) => request.needs)).toEqual([
            [{ ref: child, paths: ["/"] }],
        ]);
        expect(model.lines.slice(1).map(line => [line.summary, line.expanded])).toEqual([
            ["Child title", false], ["Child title", false],
        ]);
        expect(loader.cache.has(detail)).toBe(false);

        model.select(1);
        await model.expandSelected();
        expect(model.lines.find(line => line.ref?.id === detail.id)?.summary).toBe("Detail title");
        expect(loader.cache.has(nested)).toBe(false);
        model.collapseSelected();
        expect(model.lines[1].summary).toBe("Child title");
        fetch.mockClear();
        await model.expandSelected();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("refreshes collapsed titles when a watched root replaces their immutable references", async () => {
        const nextRoot = { kind: "node", id: "root-v2" };
        const nextChild = { kind: "node", id: "child-v2" };
        const detail = { kind: "node", id: "unopened-detail" };
        const store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
        store.set(root, { child });
        store.set(nextRoot, { child: nextChild });
        store.set(child, { title: "Before", detail });
        store.set(nextChild, { title: "After", detail });
        const runtime = new ImmutableGraphRuntime(store, standardGraphRuntimeOptions);
        const loader = new GraphLoader(request => runtime.batchObjGet(request));
        await loadGraphDepth(root, loader, 0);
        const first = new GraphExplorerModel(root, loader);
        await first.restoreExpanded();
        first.select(1);
        expect(first.lines[1].summary).toBe("Before");

        await first.prefetchExpanded(nextRoot);
        const next = new GraphExplorerModel(nextRoot, loader);
        await next.restoreExpanded(undefined, first);
        expect(next.selectedKey).toBe("$.child");
        expect(next.lines[1]).toMatchObject({ summary: "After", expanded: false });
        expect(loader.cache.has(detail)).toBe(false);
    });

    it("does not turn literal selector operators into broad prefetches", () => {
        const loader = new GraphLoader(async () => ({ objects: [], missing: [], complete: true }));
        loader.cache.put([{ ref: root, value: { "*": child, "**": child, "@": child } }]);
        const model = new GraphExplorerModel(root, loader);
        expect(model.lines.slice(1).map(line => line.selector)).toEqual([undefined, undefined, undefined]);
    });

    it.each([1, 256])("prefetches an expanded replacement chain with maxObjects=%s, escaped selectors and cached descendants", async maxObjects => {
        const store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
        const nextRoot = { kind: "node", id: "root2" };
        const nextChild = { kind: "node", id: "child2" };
        const leaf = { kind: "node", id: "leaf" };
        const unopened = { kind: "node", id: "unopened" };
        store.set(root, { "a/b~": [child], unopened });
        store.set(child, { leaf });
        store.set(leaf, { title: "unchanged" });
        store.set(nextRoot, { "a/b~": [nextChild], unopened });
        store.set(nextChild, { leaf, title: "changed" });
        store.set(unopened, { title: "Collapsed" });
        const runtime = new ImmutableGraphRuntime(store, standardGraphRuntimeOptions);
        const fetch = vi.fn<GraphBatchFetch>(request => runtime.batchObjGet(request));
        const loader = new GraphLoader(fetch, undefined, { maxObjects });
        await loader.load([{ ref: root, paths: ["/a~1b~0/0/@/leaf/@"] }]);
        const first = new GraphExplorerModel(root, loader);
        first.select(1);
        await first.expandSelected();
        first.select(2);
        await first.expandSelected();
        fetch.mockClear();
        await first.prefetchExpanded(nextRoot);
        await loadGraphDepth(nextRoot, loader, 0);
        const next = new GraphExplorerModel(nextRoot, loader);
        await next.restoreExpanded(undefined, first);
        expect(fetch).toHaveBeenCalledTimes(maxObjects === 1 ? 2 : 1);
        expect(fetch.mock.calls[0][0].needs[0].paths).toContain("/a~1b~0/0/@/leaf/@");
        expect(next.lines.map(line => line.text).join("\n")).toContain('title = "changed"');
        expect(loader.cache.has(unopened)).toBe(true);
    });

    it("builds the tree only once across repeated cursor movements", () => {
        const loader = new GraphLoader(async () => ({ objects: [], missing: [], complete: true }));
        loader.cache.put([{ ref: root, value: Array.from({ length: 1000 }, (_, i) => i) }]);
        const emit = vi.fn();
        const model = new GraphExplorerModel(root, loader, undefined, undefined, new GraphTimings(emit));
        for (let i = 0; i < 100; i++) {
            model.move(1);
            expect(model.selectedIndex).toBe(i + 1);
        }
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit.mock.calls[0][0].phase).toBe("tree");
    });

    it("reuses tree lines across navigation and invalidates them when objects arrive", async () => {
        const loader = new GraphLoader(async ({ needs }) => ({
            objects: needs.map(({ ref }) => ({ ref, value: ref.id === root.id ? { child } : { name: "child" } })),
            missing: [], complete: true,
        }));
        await loader.load([{ ref: root, paths: ["/"] }]);
        const model = new GraphExplorerModel(root, loader);
        const lines = model.lines;
        model.move(1);
        expect(model.lines).toBe(lines);
        await loader.load([{ ref: child, paths: ["/"] }]);
        expect(model.lines).not.toBe(lines);
        expect(model.lines[1].loaded).toBe(true);
        const loaded = model.lines;
        expect(model.selectedKey).toBe("$.child");
        expect(model.lines).toBe(loaded);
    });

    it("restores sibling expansions and loads collapsed siblings without opening them", async () => {
        const sibling = { kind: "node", id: "sibling" };
        const unopened = { kind: "node", id: "unopened" };
        const fetch = vi.fn<GraphBatchFetch>(async ({ needs }) => ({
            objects: needs.map(({ ref }) => ({ ref, value: { name: ref.id } })),
            missing: [], complete: true,
        }));
        const loader = new GraphLoader(fetch);
        loader.cache.put([{ ref: root, value: { child, sibling, unopened } }]);
        const model = new GraphExplorerModel(root, loader, undefined, {
            expandedPaths: new Set(["$", "$.child", "$.sibling"]),
        });
        await model.restoreExpanded();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[0][0].needs).toEqual([
            { ref: child, paths: ["/"] }, { ref: sibling, paths: ["/"] },
        ]);
        expect(fetch.mock.calls[1][0].needs).toEqual([{ ref: unopened, paths: ["/"] }]);
        expect(loader.cache.has(unopened)).toBe(true);
        expect(model.lines.find(line => line.ref?.id === unopened.id)?.expanded).toBe(false);
    });

    it("lazily fetches expanded references and preserves selection by path", async () => {
        const loader = new GraphLoader(async ({ needs }) => ({
            objects: needs.map(({ ref }) => ({
                ref,
                value: ref.id === "root" ? { child } : { name: "child" },
            })),
            missing: [],
            complete: true,
        }));
        await loader.load([{ ref: root, paths: ["/"] }]);
        const model = new GraphExplorerModel(root, loader);
        model.select(1);

        await model.expandSelected();

        expect(model.lines.map((line) => line.text)).toEqual([
            "$ → node:root",
            "$.child → node:child",
            '$.child.name = "child"',
        ]);
        expect(model.selectedIndex).toBe(1);
        expect(renderGraphTree(model, { selected: true })).toContain(">   $.child → node:child");
    });

    it("loads a bounded static depth and renders cycles as JSON markers", async () => {
        const loader = new GraphLoader(async ({ needs }) => ({
            objects: needs.map(({ ref }) => ({
                ref,
                value: ref.id === "root" ? { child } : { root },
            })),
            missing: [],
            complete: true,
        }));

        await loadGraphDepth(root, loader, 1);

        expect(loader.cache.have().map((item) => graphRefKey(item.ref))).toEqual([
            graphRefKey(child),
            graphRefKey(root),
        ]);
        expect(renderGraphJson(root, loader)).toMatchInlineSnapshot(`
          "{
            "child": {
              "root": {
                "$ref": "node:root",
                "$cycle": true
              }
            }
          }"
        `);
    });

    it("preserves open paths and selection when immutable object versions change", async () => {
        const nextRoot = { kind: "node", id: "root-v2" };
        const nextChild = { kind: "node", id: "child-v2" };
        const loader = new GraphLoader(async ({ needs }) => ({
            objects: needs.map(({ ref }) => ({
                ref,
                value: ref.id === root.id ? { child }
                    : ref.id === nextRoot.id ? { child: nextChild }
                    : { name: ref.id },
            })),
            missing: [], complete: true,
        }));
        await loader.load([{ ref: root, paths: ["/"] }]);
        const first = new GraphExplorerModel(root, loader);
        first.select(1);
        await first.expandSelected();
        first.move(1);
        await loader.load([{ ref: nextRoot, paths: ["/"] }]);
        const second = new GraphExplorerModel(nextRoot, loader, undefined, {
            selectedKey: first.selectedKey,
            expanded: first.expandedKeys,
            expandedPaths: first.expandedPaths,
        });
        await second.restoreExpanded();
        expect(second.selectedKey).toBe("$.child.name");
        expect(second.lines.map(line => line.text)).toContain('$.child.name = "child-v2"');
        second.collapseSelected();
        expect(second.selectedKey).toBe("$.child");
    });

    it("normalizes shared aliases so collapsed branches stay collapsed on refresh", async () => {
        const loader = new GraphLoader(async ({ needs }) => ({
            objects: needs.map(({ ref }) => ({
                ref, value: ref.id === root.id ? { a: child, b: child } : { name: "shared" },
            })),
            missing: [], complete: true,
        }));
        await loader.load([{ ref: root, paths: ["/"] }]);
        const model = new GraphExplorerModel(root, loader);
        model.select(2);
        await model.expandSelected();
        expect(model.selectedKey).toBe("$.a");
        model.collapseSelected();
        const next = new GraphExplorerModel(root, loader, undefined, {
            expanded: model.expandedKeys, expandedPaths: model.expandedPaths,
        });
        await next.restoreExpanded();
        expect(next.lines.map(line => line.key)).toEqual(["$", "$.a", "$.b"]);
    });

    it("keeps a collapsed root collapsed after an update", async () => {
        const loader = new GraphLoader(async ({ needs }) => ({
            objects: needs.map(({ ref }) => ({ ref, value: { child } })),
            missing: [], complete: true,
        }));
        await loader.load([{ ref: root, paths: ["/"] }]);
        const model = new GraphExplorerModel(root, loader);
        model.collapseSelected();
        const next = new GraphExplorerModel(root, loader, undefined, {
            expanded: model.expandedKeys, expandedPaths: model.expandedPaths,
        });
        await next.restoreExpanded();
        expect(next.lines).toHaveLength(1);
    });

    it("rejects unbounded or invalid depth requests", async () => {
        const loader = new GraphLoader(async () => ({ objects: [], missing: [], complete: true }));
        await expect(loadGraphDepth(root, loader, -1)).rejects.toThrow(/non-negative integer/);
        await expect(loadGraphDepth(root, loader, Number.POSITIVE_INFINITY))
            .rejects.toThrow(/non-negative integer/);
    });
});
