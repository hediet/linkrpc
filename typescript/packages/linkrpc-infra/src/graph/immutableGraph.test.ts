import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@hediet/linkrpc';
import {
    ImmutableGraphRuntime, InMemoryImmutableGraphStore, isGraphRef,
    standardGraphRuntimeOptions, type GraphBatchRequest, type GraphRef,
} from './index';

const ref = (id: string, kind = 'node'): GraphRef => ({ kind, id });
const request = (paths = ['/**']): GraphBatchRequest<GraphRef> => ({
    needs: [{ ref: ref('root'), paths }], have: [], limits: { maxObjects: 20, maxBytes: 20_000 },
});

it('root leases protect newly materialized descendants and collection bounds retained-root metadata', () => {
    const store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
    store.set(ref('root'), { child: ref('deferred') });
    const leases = Array.from({ length: 250 }, () => store.retainClosure(ref('root')));
    store.set(ref('deferred'), { child: ref('late') });
    store.set(ref('late'), { text: 'late materialization' });
    store.set(ref('unused'), { unused: true });
    store.collectGarbage([], true);
    expect(store.lookup(ref('late')).found).toBe(true);
    expect(store.lookup(ref('unused')).found).toBe(false);
    expect(store.diagnostics).toEqual({ objects: 3, identities: 3, retainedRoots: 1 });
    expect(() => store.markUnavailable(ref('late'), 'expired')).toThrow(/Retained/);
    for (const lease of leases) lease.dispose();
    store.collectGarbage([], true);
    expect(store.diagnostics).toEqual({ objects: 0, identities: 0, retainedRoots: 0 });
});
function fixture() {
    const store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
    store.set(ref('root'), { children: [ref('a'), ref('b')], shared: ref('shared') });
    store.set(ref('a'), { next: ref('shared') });
    store.set(ref('b'), { next: ref('root') });
    store.set(ref('shared'), { label: 'shared' });
    return { store, runtime: new ImmutableGraphRuntime(store, standardGraphRuntimeOptions) };
}

describe('immutable graph runtime', () => {
    it('traverses deterministic ancestor-first cycles, shared refs and selected subtrees', async () => {
        const { runtime } = fixture();
        for (const [paths, ids] of [
            [['/**'], ['root', 'a', 'b', 'shared']],
            [['/children/0/@/**'], ['root', 'a', 'shared']],
            [['/children/*/@/next/@'], ['root', 'a', 'b', 'shared']],
            [[], ['root']],
        ] as const) {
            const result = await runtime.batchObjGet(request([...paths]));
            expect(result.objects.map(row => row.ref.id)).toEqual(ids);
            expect(result.complete).toBe(true);
        }
    });

    it('keeps escaped selector segments distinct and rejects invalid selectors before retaining', async () => {
        const { store, runtime } = fixture();
        store.set(ref('escaped'), { 'a/b': ref('a'), a: { b: ref('b') } });
        const result = await runtime.batchObjGet({
            ...request(), needs: [{ ref: ref('escaped'), paths: ['/a~1b/@', '/a/b/@'] }],
        });
        expect(result.objects.map(row => row.ref.id)).toEqual(['escaped', 'a', 'b']);
        for (const path of ['invalid', '/bad~2', '/**/child']) {
            await expect(runtime.batchObjGet(request([path]))).rejects.toThrow();
            expect(store.isRetained(ref('root'))).toBe(false);
        }
    });

    it('stops before a deferred lookup at the object budget and progresses using have', async () => {
        const { store } = fixture();
        const lookedUp: string[] = [];
        const runtime = new ImmutableGraphRuntime({
            lookup: (ref: GraphRef) => { lookedUp.push(ref.id); return store.lookup(ref); },
        }, standardGraphRuntimeOptions);
        const first = await runtime.batchObjGet({ ...request(), limits: { maxObjects: 1, maxBytes: 20_000 } });
        expect(lookedUp).toEqual(['root']);
        expect(first.complete).toBe(false);
        const second = await runtime.batchObjGet({
            ...request(), have: first.objects.map(({ ref }) => ({ ref, coverage: 'object' })),
        });
        expect(second.objects.map(row => row.ref.id)).toEqual(['a', 'b', 'shared']);
        expect(second.complete).toBe(true);
    });

    it('counts UTF-8 row bytes, resumes byte-limited batches and reports oversized rows once', async () => {
        const store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
        const value = { child: ref('child'), payload: '😀'.repeat(20) };
        store.set(ref('root'), value);
        store.set(ref('child'), { payload: 'é'.repeat(20) });
        const runtime = new ImmutableGraphRuntime(store, standardGraphRuntimeOptions);
        const maxBytes = new TextEncoder().encode(JSON.stringify({ ref: ref('root'), value })).byteLength;
        const first = await runtime.batchObjGet({ ...request(), limits: { maxObjects: 10, maxBytes } });
        expect(first.objects.map(row => row.ref.id)).toEqual(['root']);
        expect(first.complete).toBe(false);
        const second = await runtime.batchObjGet({
            ...request(), limits: { maxObjects: 10, maxBytes },
            have: [{ ref: ref('root'), coverage: 'object' }],
        });
        expect(second.objects.map(row => row.ref.id)).toEqual(['child']);
        expect(second.complete).toBe(true);
        const oversized = await runtime.batchObjGet({
            ...request(['/', '/child/@']), limits: { maxObjects: 10, maxBytes: maxBytes - 1 },
        });
        expect(oversized).toMatchObject({
            objects: [], missing: [{ ref: ref('root'), reason: 'oversized' }], complete: true,
        });
        expect(oversized.missing).toHaveLength(1);
    });

    it('validates closure claims, caches each lookup once per batch and never across batches', async () => {
        const { store } = fixture();
        const lookedUp: string[] = [];
        const runtime = new ImmutableGraphRuntime({
            lookup: (ref: GraphRef) => { lookedUp.push(ref.id); return store.lookup(ref); },
        }, standardGraphRuntimeOptions);
        const input: GraphBatchRequest<GraphRef> = {
            ...request(), have: [{ ref: ref('root'), coverage: 'closure' }],
        };
        expect((await runtime.batchObjGet(input)).objects).toEqual([]);
        expect(lookedUp).toEqual(['root', 'a', 'b', 'shared']);
        store.markUnavailable(ref('shared'), 'expired');
        lookedUp.length = 0;
        const stale = await runtime.batchObjGet(input);
        expect(stale.objects.map(row => row.ref.id)).toEqual(['root', 'a', 'b']);
        expect(stale.missing).toEqual([{ ref: ref('shared'), reason: 'expired' }]);
        expect(lookedUp).toEqual(['root', 'a', 'b', 'shared']);
    });

    it('preserves missing reasons and rejects invalid limits', async () => {
        const { store, runtime } = fixture();
        store.markUnavailable(ref('a'), 'forbidden', 'private');
        store.markUnavailable(ref('b'), 'missing');
        const result = await runtime.batchObjGet(request());
        expect(result.missing).toEqual([
            { ref: ref('a'), reason: 'forbidden', detail: 'private' }, { ref: ref('b'), reason: 'missing' },
        ]);
        for (const maxObjects of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            await expect(runtime.batchObjGet({ ...request(), limits: { maxObjects, maxBytes: 100 } })).rejects.toThrow();
        }
        await expect(runtime.batchObjGet({ ...request(), limits: { maxObjects: 1, maxBytes: 0 } })).rejects.toThrow();
    });

    it('isolates values, preserves expired identities and uses collision-free reference keys', () => {
        const { store } = fixture();
        const value = { nested: { title: 'original' } };
        store.set(ref('isolated'), value);
        value.nested.title = 'changed';
        const result = store.lookup(ref('isolated'));
        expect(result).toEqual({ found: true, value: { nested: { title: 'original' } } });
        if (result.found && typeof result.value === 'object' && result.value !== null) {
            expect(Object.isFrozen(result.value)).toBe(true);
            expect(Object.isFrozen(Object.values(result.value)[0])).toBe(true);
        }
        store.markUnavailable(ref('a'), 'expired');
        expect(() => store.set(ref('a'), { changed: true })).toThrow('cannot be replaced');
        store.set(ref('a'), { next: ref('shared') });
        expect(standardGraphRuntimeOptions.refKey(ref('b\0c', 'a')))
            .not.toBe(standardGraphRuntimeOptions.refKey(ref('c', 'a\0b')));
        expect(isGraphRef({ kind: 'node', id: 'id', extra: true })).toBe(false);
    });

    it('retains closures during a batch and releases nested shared leases idempotently', async () => {
        const { store } = fixture();
        const extra = store.retainClosure(ref('a'));
        const runtime = new ImmutableGraphRuntime({
            lookup: (ref: GraphRef) => {
                expect(store.isRetained(ref)).toBe(true);
                expect(() => store.markUnavailable(ref, 'expired')).toThrow('cannot be made unavailable');
                return store.lookup(ref);
            },
            retainClosure: (ref: GraphRef) => store.retainClosure(ref),
        }, standardGraphRuntimeOptions);
        await runtime.batchObjGet(request());
        expect(store.isRetained(ref('root'))).toBe(false);
        expect(store.isRetained(ref('shared'))).toBe(true);
        await extra.dispose();
        await extra.dispose();
        expect(store.isRetained(ref('shared'))).toBe(false);
    });

    it('attempts all cleanup even when acquisition and synchronous disposal fail', async () => {
        const disposed: string[] = [];
        const runtime = new ImmutableGraphRuntime<GraphRef, JsonValue>({
            lookup: () => ({ found: true, value: {} }),
            retainClosure: ref => {
                if (ref.id === 'fail') throw new Error('acquisition failed');
                return { dispose() { disposed.push(ref.id); if (ref.id === 'first') throw new Error('cleanup failed'); } };
            },
        }, standardGraphRuntimeOptions);
        await expect(runtime.batchObjGet({
            ...request(), needs: ['first', 'second', 'fail'].map(id => ({ ref: ref(id), paths: ['/'] })),
        })).rejects.toThrow('Graph batch failed');
        expect(disposed).toEqual(['first', 'second']);
    });
});
