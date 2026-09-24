import { describe, expect, it, vi } from "vitest";
import { ImmutableGraphRuntime, InMemoryImmutableGraphStore, standardGraphRuntimeOptions } from "@hediet/linkrpc-infra/graph";
import type { JsonValue } from "@hediet/linkrpc";
import {
    GraphLoader,
    GraphObjectCache,
    createGraphTree,
    graphRefKey,
    parseGraphBatchResult,
    type GraphRef,
    type GraphBatchFetch,
} from "./inspectGraphModel";

describe("GraphLoader", () => {
    it("cancels in-flight fetches and does not start more work after quit", async () => {
        const cancellation = new AbortController();
        let requested = 0;
        let requestSignal: AbortSignal | undefined;
        const loader = new GraphLoader(async (_request, signal) => {
            requested++;
            requestSignal = signal;
            return new Promise(() => {});
        }, undefined, { signal: cancellation.signal });
        const loading = loader.load([{ ref: { kind: "node", id: "root" }, paths: ["/"] }]);
        cancellation.abort(new Error("closed"));
        await expect(loading).rejects.toThrow("closed");
        expect(requestSignal?.aborted).toBe(true);
        await expect(loader.load([])).rejects.toThrow("closed");
        expect(requested).toBe(1);
    });

    const root = { kind: "node", id: "root" };
    const child = { kind: "node", id: "child" };

    it.each([{ paths: ["/"] }, { paths: [] }])("omits all haves for uncached object-only needs with paths $paths", async ({ paths }) => {
        const cache = new GraphObjectCache();
        cache.put(Array.from({ length: 1000 }, (_, i) => ({
            ref: { kind: "node", id: `cached-${i}` }, value: { i },
        })));
        const fetch = vi.fn<GraphBatchFetch>(async () => ({
            objects: [{ ref: root, value: { child } }], missing: [], complete: true,
        }));
        await new GraphLoader(fetch, cache).load([{ ref: root, paths }]);
        expect(fetch.mock.calls[0][0].have).toHaveLength(0);
        expect(fetch.mock.calls[0][0].needs).toEqual([{ ref: root, paths }]);
    });

    it("skips cached object-only needs and empty batches without a fetch", async () => {
        const cache = new GraphObjectCache();
        cache.put([{ ref: root, value: { child } }]);
        const fetch = vi.fn();
        const loader = new GraphLoader(fetch, cache);
        await loader.load([{ ref: root, paths: ["/"] }, { ref: root, paths: [] }]);
        await loader.load([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("removes fetched needs between bounded object-only rounds instead of sending haves", async () => {
        const store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
        store.set(root, { child });
        store.set(child, { name: "Ada" });
        const runtime = new ImmutableGraphRuntime(store, standardGraphRuntimeOptions);
        const fetch = vi.fn<GraphBatchFetch>((request) => runtime.batchObjGet(request));
        const loader = new GraphLoader(fetch, undefined, { maxObjects: 1 });
        await loader.load([{ ref: root, paths: ["/"] }, { ref: child, paths: [] }]);
        expect(fetch.mock.calls.map(([request]) => ({ needs: request.needs, have: request.have }))).toEqual([
            { needs: [{ ref: root, paths: ["/"] }, { ref: child, paths: [] }], have: [] },
            { needs: [{ ref: child, paths: [] }], have: [] },
        ]);
        expect(loader.cache.get(child)?.value).toEqual({ name: "Ada" });
    });

    it.each(["/**", "/child/@", "mixed"])("preserves haves for traversal %s through an uncached parent", async path => {
        const store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
        store.set(root, { child });
        store.set(child, { name: "Ada" });
        const cache = new GraphObjectCache();
        cache.put([{ ref: child, value: { name: "Ada" } }]);
        const runtime = new ImmutableGraphRuntime(store, standardGraphRuntimeOptions);
        const fetch = vi.fn((request: Parameters<GraphBatchFetch>[0]) => runtime.batchObjGet(request));
        const needs = path === "mixed"
            ? [{ ref: child, paths: ["/"] }, { ref: root, paths: ["/**"] }]
            : [{ ref: root, paths: [path] }];
        await new GraphLoader(fetch, cache).load(needs);
        expect(fetch.mock.calls[0][0].have).toEqual([{ ref: child, coverage: "object" }]);
        expect(parseGraphBatchResult(await fetch.mock.results[0].value).objects.map(object => object.ref)).toEqual([root]);
    });

    it("continues partial responses with updated have state", async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce({
                objects: [{ ref: root, value: { child } }],
                missing: [],
                complete: false,
            })
            .mockResolvedValueOnce({
                objects: [{ ref: child, value: { name: "Ada" } }],
                missing: [],
                complete: true,
            });
        const loader = new GraphLoader(fetch);

        await loader.load([{ ref: root, paths: ["/**"] }]);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1][0]).toMatchInlineSnapshot(`
          {
            "have": [
              {
                "coverage": "object",
                "ref": {
                  "id": "root",
                  "kind": "node",
                },
              },
            ],
            "limits": {
              "maxBytes": 1048576,
              "maxObjects": 256,
            },
            "needs": [
              {
                "paths": [
                  "/**",
                ],
                "ref": {
                  "id": "root",
                  "kind": "node",
                },
              },
            ],
          }
        `);
        expect(loader.cache.get(child)?.value).toEqual({ name: "Ada" });
    });

    it("diagnoses a partial response that makes no progress", async () => {
        const loader = new GraphLoader(async () => ({
            objects: [],
            missing: [],
            complete: false,
        }));

        await expect(loader.load([{ ref: root, paths: ["/"] }]))
            .rejects.toThrow(/incomplete batch without progress/i);
    });

    it("rejects conflicting immutable object versions", async () => {
        const cache = new GraphObjectCache();
        cache.put([{ ref: root, value: { value: 1 } }]);
        expect(() => cache.put([{ ref: root, value: { value: 2 } }]))
            .toThrow(/conflicting values/);
    });
});

describe("graph batch validation", () => {
    it("rejects malformed server results", () => {
        expect(() => parseGraphBatchResult({ objects: "nope", missing: [], complete: true }))
            .toThrow("graph batch result.objects must be an array");
        expect(() => parseGraphBatchResult({
            objects: [{ ref: { kind: "node", id: 42 }, value: {} }],
            missing: [],
            complete: true,
        })).toThrow(/exactly string kind and id fields/);
    });
});

describe("graph tree rendering", () => {
    const root: GraphRef = { kind: "node", id: "root" };
    const child: GraphRef = { kind: "node", id: "child" };

    it("renders cycles and shared references without duplicating subtrees", () => {
        const cache = new GraphObjectCache();
        cache.put([
            { ref: root, value: { first: child, second: child } },
            { ref: child, value: { parent: root, title: "Child" } },
        ]);
        const expanded = new Set([graphRefKey(root), graphRefKey(child)]);

        expect(createGraphTree(root, cache, expanded).map((line) => line.text))
            .toMatchInlineSnapshot(`
              [
                "$ → node:root",
                "$.first → node:child",
                "$.first.parent → node:root ↩ cycle to $",
                "$.first.title = "Child"",
                "$.second → node:child ↗ shared with $.first",
              ]
            `);
    });

    it("keeps unloaded references visible and expandable after they arrive", () => {
        const cache = new GraphObjectCache();
        cache.put([{ ref: root, value: { child } }]);
        const expanded = new Set([graphRefKey(root), graphRefKey(child)]);

        expect(createGraphTree(root, cache, expanded).map((line) => line.text)).toEqual([
            "$ → node:root",
            "$.child → node:child [not loaded]",
        ]);

        cache.put([{ ref: child, value: { title: "Loaded" } }]);
        expect(createGraphTree(root, cache, expanded).map((line) => line.text)).toEqual([
            "$ → node:root",
            "$.child → node:child",
            '$.child.title = "Loaded"',
        ]);
    });
});
