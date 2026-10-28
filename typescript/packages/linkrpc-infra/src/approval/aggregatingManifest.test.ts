import { describe, expect, it } from 'vitest';
import type { Permission } from '@hediet/linkrpc';
import type { IHubAccessManifest } from '@hediet/linkrpc/hub/common';
import { AggregatingHubAccessManifest, type AggregatorSource } from './aggregatingManifest';

const PERMISSION: Permission = {
    target: { serviceId: { exact: 'svc' }, interfaceId: { exact: 'greeter' }, members: [{ exact: 'hello' }] },
    canInvoke: true,
};

function streaming<T>(promise: Promise<T>, cancel = async () => {}) {
    return Object.assign(promise, {
        requestId: Promise.resolve(0),
        send: async (_value: never) => {},
        ping: async () => {},
        cancel,
    });
}

/** A minimal fake manifest whose `getDesired` returns `doc` verbatim (bypassing the wire). */
function fakeManifest(doc: unknown): IHubAccessManifest {
    const idleStream = Object.assign(Promise.resolve({}), {
        cancel: async () => { /* noop */ },
        send: async () => { /* noop */ },
        ping: async () => { /* noop */ },
        requestId: Promise.resolve(0 as never),
    });
    return {
        getDesired: () => streaming(Promise.resolve(doc as never)),
        watchDesired: () => idleStream as never,
        getCurrent: async () => ({ current: {}, revision: 0 }),
        setCurrent: () => streaming(Promise.resolve({ revision: 0 })),
        watchCurrent: () => idleStream as never,
    };
}

describe('AggregatingHubAccessManifest — result validation at the boundary', () => {
    it('reports failed reads and clears their health error after recovery or removal', async () => {
        let failing = true;
        const manifest: IHubAccessManifest = {
            ...fakeManifest({ requested: {}, revision: 0 }),
            getDesired: () => streaming((async () => {
                if (failing) throw new Error('discovery denied');
                return { requested: {}, revision: 1 };
            })()),
        };
        let sources: AggregatorSource[] = [{ tag: 'source', manifest }];
        const errors = new Map<string, string>();
        const aggregate = new AggregatingHubAccessManifest({
            resolveSources: () => sources,
            onSourceError: (tag, error) => {
                if (error === undefined) errors.delete(tag);
                else errors.set(tag, error);
            },
        });
        try {
            await aggregate.getDesired();
            expect(errors.get('source')).toContain('discovery denied');
            failing = false;
            await aggregate.getDesired();
            expect(errors.size).toBe(0);
            failing = true;
            await aggregate.getDesired();
            expect(errors.size).toBe(1);
            sources = [];
            await aggregate.getDesired();
            expect(errors.size).toBe(0);
        } finally {
            aggregate.dispose();
        }
    });

    it('cancels and identifies a manifest source that exceeds its timeout', async () => {
        let cancelled = false;
        const pending = streaming(new Promise<never>(() => {}), async () => { cancelled = true; });
        const slow: IHubAccessManifest = {
            ...fakeManifest({ requested: {}, revision: 0 }),
            getDesired: () => pending,
        };
        const logs: string[] = [];
        const agg = new AggregatingHubAccessManifest({
            resolveSources: () => [{ tag: 'slow-service', manifest: slow }],
            timeoutMs: 10,
            log: (line) => logs.push(line),
        });

        const doc = await agg.getDesired();

        expect(doc.requested).toEqual({});
        expect(cancelled).toBe(true);
        expect(logs).toContain(
            "aggregator: getDesired(slow-service) failed: "
            + "hubAccessManifest service 'slow-service' timed out after 10ms",
        );
        agg.dispose();
    });

    it('reads slow sources concurrently, so their delays do not add up to a timeout', async () => {
        const entry = (name: string) => ({
            kind: 'direct', consumer: { name, principal: `id:key:${name}` }, permissions: [PERMISSION],
        });
        const slow = (name: string): IHubAccessManifest => ({
            ...fakeManifest({ requested: {}, revision: 0 }),
            getDesired: () => streaming(new Promise((resolve) => setTimeout(
                () => resolve({ requested: { [name]: entry(name) }, revision: 1 } as never), 100,
            ))),
        });
        const logs: string[] = [];
        const agg = new AggregatingHubAccessManifest({
            resolveSources: () => ['a', 'b', 'c', 'd'].map((tag) => ({ tag, manifest: slow(tag) })),
            timeoutMs: 150,
            log: (line) => logs.push(line),
        });

        const started = Date.now();
        const doc = await agg.getDesired();
        const elapsedMs = Date.now() - started;

        // Read one after another, the four sources would take at least 400 ms.
        expect({ requested: Object.keys(doc.requested).length, logs, withinOneTimeout: elapsedMs < 300 })
            .toEqual({ requested: 4, logs: [], withinOneTimeout: true });
        agg.dispose();
    });

    it('skips a source whose getDesired document violates the schema, and logs it', async () => {
        const good = fakeManifest({
            requested: { e1: { kind: 'direct', consumer: { name: 'good', principal: 'id:key:good' }, permissions: [PERMISSION] } },
            revision: 1,
        });
        // BAD: the direct entry omits its required per-entry `consumer` (the
        // document-level-consumer encoding a buggy participant might emit).
        const bad = fakeManifest({
            consumer: { name: 'bad', principal: 'id:key:bad' },
            requested: { e2: { kind: 'direct', permissions: [PERMISSION] } },
            revision: 1,
        });

        const logs: string[] = [];
        const sources: AggregatorSource[] = [
            { tag: 'good', manifest: good },
            { tag: 'bad', manifest: bad },
        ];
        const agg = new AggregatingHubAccessManifest({ resolveSources: () => sources, log: (l) => logs.push(l) });

        const doc = await agg.getDesired();

        // The good source's entry is present (namespaced); the bad source is dropped.
        expect(Object.keys(doc.requested)).toEqual(['good\u0000e1']);
        expect(logs.some((l) => l.includes("source 'bad'") && l.includes('invalid'))).toBe(true);

        agg.dispose();
    });

    it('passes a well-formed multi-entry document through, namespaced by tag', async () => {
        const src = fakeManifest({
            requested: {
                a: { kind: 'direct', consumer: { name: 'c', principal: 'id:key:c' }, permissions: [PERMISSION] },
                b: { kind: 'discover', consumer: { name: 'c', principal: 'id:key:c' }, interfaces: [{ id: 'greeter', required: true }], members: [] },
            },
            revision: 3,
        });

        const agg = new AggregatingHubAccessManifest({ resolveSources: () => [{ tag: 'srcX', manifest: src }] });
        const doc = await agg.getDesired();
        expect(Object.keys(doc.requested).sort()).toEqual(['srcX\u0000a', 'srcX\u0000b']);
        agg.dispose();
    });
});

describe('AggregatingHubAccessManifest — progressive mode', () => {
    /** A source whose reads resolve when the test says so, and whose watch ticks on demand. */
    function controllable() {
        const entries: Record<string, unknown> = {};
        let release: (() => void) | undefined;
        let holdReads = false;
        let tick: (() => void) | undefined;
        const decisions: unknown[] = [];
        let reads = 0;
        const manifest: IHubAccessManifest = {
            ...fakeManifest({ requested: {}, revision: 0 }),
            getDesired: () => streaming((async () => {
                reads++;
                if (holdReads) await new Promise<void>((resolve) => { release = resolve; });
                return { requested: { ...entries }, revision: reads } as never;
            })()),
            watchDesired: ((_params: unknown, opts?: { onMessage?: () => void }) => {
                tick = () => opts?.onMessage?.();
                return streaming(new Promise<never>(() => {}));
            }) as never,
            setCurrent: ((params: { patches: { path: string }[] }) => {
                for (const patch of params.patches) {
                    decisions.push(patch.path);
                    delete entries[patch.path.slice('/current/'.length)];
                }
                return streaming(Promise.resolve({ revision: 0 }));
            }) as never,
        };
        return {
            manifest,
            entries,
            decisions,
            reads: () => reads,
            hold: () => { holdReads = true; },
            release: () => { holdReads = false; release?.(); },
            tick: () => tick?.(),
        };
    }
    const entry = (name: string) => ({ kind: 'direct', consumer: { name, principal: `id:key:${name}` }, permissions: [PERMISSION] });
    const ids = async (agg: AggregatingHubAccessManifest) =>
        Object.keys((await agg.getDesired()).requested).map((key) => key.replace('\u0000', ':')).sort();
    async function until(condition: () => boolean): Promise<void> {
        for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(condition()).toBe(true);
    }

    it('serves fast sources while a slow one is still reading, and emits once it answers', async () => {
        const fast = controllable();
        fast.entries.f = entry('fast');
        const slow = controllable();
        slow.entries.s = entry('slow');
        slow.hold();
        const agg = new AggregatingHubAccessManifest({
            resolveSources: () => [{ tag: 'fast', manifest: fast.manifest }, { tag: 'slow', manifest: slow.manifest }],
            progressive: true,
        });
        let changes = 0;
        const off = agg.onDidChange(() => changes++);
        try {
            await until(() => fast.reads() === 1 && agg.pendingSources().length === 1);
            expect({ ids: await ids(agg), pending: agg.pendingSources() })
                .toEqual({ ids: ['fast:f'], pending: ['slow'] });

            const settled = agg.whenSettled();
            const changesBefore = changes;
            slow.release();
            await settled;
            expect({ ids: await ids(agg), pending: agg.pendingSources(), emitted: changes > changesBefore })
                .toEqual({ ids: ['fast:f', 'slow:s'], pending: [], emitted: true });
        } finally {
            off();
            agg.dispose();
        }
    });

    it('re-reads only the source whose watch ticked', async () => {
        const a = controllable();
        const b = controllable();
        const agg = new AggregatingHubAccessManifest({
            resolveSources: () => [{ tag: 'a', manifest: a.manifest }, { tag: 'b', manifest: b.manifest }],
            progressive: true,
        });
        try {
            await agg.whenSettled();
            await ids(agg);
            a.entries.new = entry('new');
            a.tick();
            await until(() => a.reads() === 2);
            await agg.whenSettled();
            expect({ ids: await ids(agg), readsA: a.reads(), readsB: b.reads() })
                .toEqual({ ids: ['a:new'], readsA: 2, readsB: 1 });
        } finally {
            agg.dispose();
        }
    });

    it('reflects a decision in the next snapshot', async () => {
        const source = controllable();
        source.entries.r = entry('request');
        const agg = new AggregatingHubAccessManifest({
            resolveSources: () => [{ tag: 'src', manifest: source.manifest }],
            progressive: true,
        });
        try {
            await agg.whenSettled();
            expect(await ids(agg)).toEqual(['src:r']);
            await agg.setCurrent([{ op: 'set', path: '/current/src\u0000r', value: { status: 'denied' } } as never]);
            expect({ ids: await ids(agg), decisions: source.decisions }).toEqual({ ids: [], decisions: ['/current/r'] });
        } finally {
            agg.dispose();
        }
    });
});
