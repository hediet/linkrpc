import { describe, expect, it } from 'vitest';
import { defineInterface, requestType } from '@hediet/linkrpc';
import { z } from 'zod';
import {
    candidatesForSlot,
    fetchFullDirectory,
    resolveAccessCandidates,
    type AccessSlotRequest,
    type DirectoryEntry,
} from './accessCandidates';
import { hubRegisterServiceId } from './hubRegisterServiceId';
import { createHubServiceInterfaces } from './hubServices';
import { Hub } from './routing/routingHub';
import { LinkRpcConnection, TransportPair } from '@hediet/linkrpc';

const mathInterface = defineInterface(
    { id: 'math', description: 'Arithmetic.' },
    { add: requestType(z.object({ a: z.number(), b: z.number() }), z.object({ sum: z.number() })) },
);
const clockInterface = defineInterface(
    { id: 'clock', description: 'Time.' },
    { now: requestType(z.object({}), z.object({ ms: z.number() })) },
);

function dir(...entries: DirectoryEntry[]): DirectoryEntry[] {
    return entries;
}

function attachConsumer(hub: Hub): LinkRpcConnection {
    const pair = new TransportPair();
    hub.attach(pair.a);
    return LinkRpcConnection.fromTransport(pair.b);
}

describe('candidatesForSlot', () => {
    it('emits a service that satisfies every required interface', () => {
        const directory = dir(
            { serviceId: 'github', interfaceId: 'math', hash: 'h1' },
            { serviceId: 'github', interfaceId: 'clock', hash: 'h2' },
            { serviceId: 'other', interfaceId: 'clock', hash: 'h2' },
        );
        const slot: AccessSlotRequest = {
            interfaces: [{ id: 'math', required: true }],
            members: [],
        };
        const candidates = candidatesForSlot(slot, directory);
        expect(candidates.map((c) => c.serviceId)).toEqual(['github']);
        expect(candidates[0].satisfiedInterfaces).toEqual([{ id: 'math', required: true }]);
    });

    it('filters out services missing a required interface', () => {
        const directory = dir(
            { serviceId: 'github', interfaceId: 'math', hash: 'h1' },
            { serviceId: 'other', interfaceId: 'clock', hash: 'h2' },
        );
        const slot: AccessSlotRequest = {
            interfaces: [
                { id: 'math', required: true },
                { id: 'clock', required: true },
            ],
            members: [],
        };
        expect(candidatesForSlot(slot, directory)).toEqual([]);
    });

    it('keeps services missing an optional interface and reports it unsatisfied', () => {
        const directory = dir({ serviceId: 'github', interfaceId: 'math', hash: 'h1' });
        const slot: AccessSlotRequest = {
            interfaces: [
                { id: 'math', required: true },
                { id: 'clock', required: false },
            ],
            members: [],
        };
        const [candidate] = candidatesForSlot(slot, directory);
        expect(candidate.serviceId).toBe('github');
        expect(candidate.satisfiedInterfaces).toEqual([{ id: 'math', required: true }]);
        expect(candidate.unsatisfiedInterfaces).toEqual([{ id: 'clock', required: false }]);
    });

    it('respects a pinned interface hash', () => {
        const directory = dir({ serviceId: 'github', interfaceId: 'math', hash: 'h1' });
        const matching: AccessSlotRequest = {
            interfaces: [{ id: 'math', hash: 'h1', required: true }],
            members: [],
        };
        const mismatching: AccessSlotRequest = {
            interfaces: [{ id: 'math', hash: 'WRONG', required: true }],
            members: [],
        };
        expect(candidatesForSlot(matching, directory).map((c) => c.serviceId)).toEqual(['github']);
        expect(candidatesForSlot(mismatching, directory)).toEqual([]);
    });

    it('carries the service description from the directory', () => {
        const directory = dir({
            serviceId: 'github',
            interfaceId: 'math',
            hash: 'h1',
            serviceDescription: 'GitHub service',
        });
        const slot: AccessSlotRequest = { interfaces: [{ id: 'math', required: true }], members: [] };
        expect(candidatesForSlot(slot, directory)[0].serviceDescription).toBe('GitHub service');
    });
});

describe('resolveAccessCandidates', () => {
    it('reports slots with no candidate', () => {
        const directory = dir({ serviceId: 'github', interfaceId: 'math', hash: 'h1' });
        const { dependencies, noCandidateSlots } = resolveAccessCandidates(
            {
                a: { interfaces: [{ id: 'math', required: true }], members: [] },
                b: { interfaces: [{ id: 'missing', required: true }], members: [] },
            },
            directory,
        );
        expect(dependencies.a.candidates.map((c) => c.serviceId)).toEqual(['github']);
        expect(dependencies.b.candidates).toEqual([]);
        expect(noCandidateSlots).toEqual(['b']);
    });
});

describe('fetchFullDirectory', () => {
    it('returns the aggregated interface inventory across claimed prefixes', async () => {
        const hub = new Hub();
        const { connection: hubConn } = createHubServiceInterfaces(hub);

        const github = hubRegisterServiceId(hub, 'github');
        github.connection.register(
            mathInterface,
            { add: ({ a, b }) => ({ sum: a + b }) },
            { serviceId: 'github', rootPrincipalSets: [[{ principal: 'node:github' }]] },
        );
        const time = hubRegisterServiceId(hub, 'time');
        time.connection.register(clockInterface, { now: () => ({ ms: 0 }) }, { serviceId: 'time' });

        const consumer = attachConsumer(hub);
        const directory = await fetchFullDirectory(consumer);

        expect(directory.some((e) => e.serviceId === 'github' && e.interfaceId === 'math')).toBe(true);
        expect(directory.some((e) => e.serviceId === 'time' && e.interfaceId === 'clock')).toBe(true);
        expect(
            directory.find((e) => e.serviceId === 'github' && e.interfaceId === 'math')?.rootPrincipalSets,
        ).toEqual([[{ principal: 'node:github' }]]);

        // The resolver can match a real slot against the live directory.
        const { dependencies, noCandidateSlots } = resolveAccessCandidates(
            { slot0: { interfaces: [{ id: 'math', required: true }], members: [] } },
            directory,
        );
        expect(noCandidateSlots).toEqual([]);
        expect(dependencies.slot0.candidates.map((c) => c.serviceId)).toContain('github');
        void hubConn;
    });
});
