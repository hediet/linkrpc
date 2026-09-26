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

test("unreachable deferred loaders are collected while leased lazy references survive", async () => {
    const source = new LazyGraphSource();
    let calls = 0;
    const old = source.defer("detail", async () => { calls++; return { old: true }; });
    source.root.set(source.put("root", { old }), undefined);
    const lease = await source.store.retainClosure!(source.root.get());
    for (let index = 0; index < 250; index++) {
        const child = source.defer("detail", async () => { calls++; return { index }; });
        source.root.set(source.put("root", { child }), undefined);
        source.collectGarbage();
    }
    assert.equal(source.diagnostics.deferred, 2);
    assert.equal(source.diagnostics.objects, 2);
    assert.equal(calls, 0);
    assert.deepEqual(await source.store.lookup(old), { found: true, value: { old: true } });
    await lease.dispose();
    source.collectGarbage();
    assert.equal(source.diagnostics.deferred, 1);
    assert.equal(source.diagnostics.objects, 1);
    assert.equal((await source.store.lookup(old)).found, false);
    source.dispose();
    assert.deepEqual(source.diagnostics, {
        deferred: 0, pending: 0, objects: 0, identities: 0, interned: 0, retainedRoots: 0,
    });
});

test("failed deferred loads can retry and in-flight loads survive collection", async () => {
    const source = new LazyGraphSource();
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ref = source.defer("detail", async () => {
        if (++attempts === 1) throw new Error("Transient failure");
        await gate;
        return { loaded: true };
    });
    source.root.set(source.put("root", { ref }), undefined);
    await assert.rejects(Promise.resolve(source.store.lookup(ref)), /Transient failure/);
    const result = source.store.lookup(ref);
    source.root.set(source.put("root", {}), undefined);
    source.collectGarbage();
    assert.equal(source.diagnostics.deferred, 1);
    release();
    assert.deepEqual(await result, { found: true, value: { loaded: true } });
    source.collectGarbage();
    assert.equal(source.diagnostics.deferred, 0);
    assert.equal(source.diagnostics.pending, 0);
    assert.equal(source.diagnostics.objects, 1);
    source.dispose();
});
