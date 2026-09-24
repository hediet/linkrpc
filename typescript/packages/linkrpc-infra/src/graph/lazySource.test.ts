import assert from "node:assert/strict";
import { test } from "vitest";
import { GraphComposition, LazyGraphSource, createGraphRuntime } from "./source.js";

test("retaining and fetching a parent does not hydrate deferred descendants", async () => {
    const source = new LazyGraphSource();
    let calls = 0;
    const leaf = source.defer("detail", async () => { calls++; return { text: "hello" }; });
    source.root.set(source.put("catalog", { leaf }), undefined);
    const composition = new GraphComposition([{ id: "test", label: "test", source }]);
    const runtime = createGraphRuntime(composition);
    const limits = { maxObjects: 10, maxBytes: 10000 };
    const root = composition.root.get();
    const lease = await composition.store.retainClosure!(root);
    assert.equal(calls, 0);
    await runtime.batchObjGet({ needs: [{ ref: root, paths: ["/**"] }], have: [], limits: { ...limits, maxObjects: 2 } });
    assert.equal(calls, 0);
    await Promise.all([source.store.lookup(leaf), source.store.lookup(leaf)]);
    assert.equal(calls, 1);
    assert.deepEqual(await source.store.lookup(leaf), { found: true, value: { text: "hello" } });
    assert.deepEqual(await source.store.lookup({ ...leaf, kind: "wrong" }), { found: false, reason: "missing" });
    await lease.dispose();
    await composition.dispose();
});
