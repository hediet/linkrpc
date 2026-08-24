import { describe, expect, it } from 'vitest';
import type { Permission } from '@hediet/linkrpc';
import type { IHubAccessManifest } from '@hediet/linkrpc/hub/common';
import { AggregatingHubAccessManifest, type AggregatorSource } from './aggregatingManifest';

const PERMISSION: Permission = {
    target: { serviceId: { exact: 'svc' }, interfaceId: { exact: 'greeter' }, members: [{ exact: 'hello' }] },
    canInvoke: true,
};

/** A minimal fake manifest whose `getDesired` returns `doc` verbatim (bypassing the wire). */
function fakeManifest(doc: unknown): IHubAccessManifest {
    const idleStream = Object.assign(Promise.resolve({}), {
        cancel: async () => { /* noop */ },
        send: async () => { /* noop */ },
        ping: async () => { /* noop */ },
        requestId: Promise.resolve(0 as never),
    });
    return {
        getDesired: async () => doc as never,
        watchDesired: () => idleStream as never,
        getCurrent: async () => ({ current: {}, revision: 0 }),
        setCurrent: async () => ({ revision: 0 }),
        watchCurrent: () => idleStream as never,
    } as IHubAccessManifest;
}

describe('AggregatingHubAccessManifest — result validation at the boundary', () => {
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
