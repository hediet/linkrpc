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
