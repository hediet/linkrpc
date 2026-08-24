import { describe, expect, it } from 'vitest';
import { defineInterface, requestType, LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { z } from 'zod';
import { directoryInterface, directoryWatchNever } from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface, walkHub } from '@hediet/linkrpc/hub/common';
import { createHubServiceInterfaces } from '../hubServices';
import { RootOverlay } from './rootOverlay';
import { registerHubServices } from '../rootServices';
import { type AttachedLink, Hub } from './routingHub';

const mathInterface = defineInterface(
    { id: 'math', description: 'Arithmetic.' },
    {
        add: requestType(
            z.object({ a: z.number(), b: z.number() }),
            z.object({ sum: z.number() }),
        ),
    },
);

const pingInterface = defineInterface(
    { id: 'ping', description: 'Liveness.' },
    { ping: requestType(z.object({}), z.object({ pong: z.boolean() })) },
);

/** Build an overlay uplinked to `hub` with the bootstrap root services. */
function makeOverlay(hub: Hub, grantedServiceIdNamespace?: string): { overlay: RootOverlay; upstream: AttachedLink; } {
    const p = new TransportPair();
    const upstream = hub.attach(p.b);
    const overlay = new RootOverlay({ uplink: p.a });
    registerHubServices(overlay.root, upstream, { grantedServiceIdNamespace });
    return { overlay, upstream };
}

/** Connect a math participant onto a fresh overlay and claim its prefix. */
async function joinParticipant(
    hub: Hub,
    prefix: string,
): Promise<{ conn: LinkRpcConnection; overlay: RootOverlay; upstream: AttachedLink; }> {
    const { overlay, upstream } = makeOverlay(hub, prefix);
    const pair = new TransportPair();
    overlay.connectParticipant(pair.a);
    const conn = LinkRpcConnection.fromTransport(pair.b);
    conn.register(mathInterface, { add: ({ a, b }) => ({ sum: a + b }) }, { serviceId: prefix });
    conn.enableReflection({ serviceId: prefix });
    await conn.get(hubGrantedServiceIdInterface).register({ serviceId: prefix });
    return { conn, overlay, upstream };
}

function attachConsumer(hub: Hub): LinkRpcConnection {
    const pair = new TransportPair();
    hub.attach(pair.a);
    return LinkRpcConnection.fromTransport(pair.b);
}

describe('RootOverlay + hub services (end-to-end)', () => {
    it('registers a participant and routes a real call consumer -> hub -> overlay -> participant', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        await joinParticipant(hub, 'calc');

        const consumer = attachConsumer(hub);
        const result = await consumer.service('calc').get(mathInterface).add({ a: 2, b: 3 });
        expect(result).toEqual({ sum: 5 });
    });

    it('the global directory lists participant directories as referrals; the walk flattens them', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        await joinParticipant(hub, 'calc');
        await joinParticipant(hub, 'sci');

        const consumer = attachConsumer(hub);
        const dir = await consumer.service('hub').get(directoryInterface).list({});
        const ids = dir.items.map((i) => `${i.serviceId}::${i.interfaceId}`);

        // Referral-only: the hub lists each prefix's directory, not its leaves.
        expect(ids).toContain('calc::linkrpc.directory');
        expect(ids).toContain('sci::linkrpc.directory');
        expect(ids).not.toContain('calc::math');
        // The hub's own services show up under the hub prefix.
        expect(ids).toContain('hub::linkrpc.directory');

        const scoped = await consumer.service('hub').get(directoryInterface).list({
            serviceIdScopes: [{ exact: 'calc' }],
        });
        expect(scoped.items.some((item) => item.serviceId === 'calc')).toBe(true);
        expect(scoped.items.some((item) => item.serviceId === 'sci')).toBe(false);

        // The breadth-first walk flattens the referral tree into the leaves.
        const leaves = (await walkHub(consumer.channel, { rootTarget: 'hub' }))
            .map((l) => `${l.serviceId}::${l.interfaceId}`);
        expect(leaves).toContain('calc::math');
        expect(leaves).toContain('sci::math');
    });

    it('the global directory respects the interfaceId filter', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        await joinParticipant(hub, 'calc');

        const consumer = attachConsumer(hub);
        const dir = await consumer.service('hub').get(directoryInterface)
            .list({ interfaceId: 'linkrpc.directory' });
        expect(dir.items.length).toBeGreaterThan(0);
        expect(dir.items.every((i) => i.interfaceId === 'linkrpc.directory')).toBe(true);
    });

    it('discovers public root -> cloud -> Auth through explicit directory listings', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const cloudPair = new TransportPair();
        hub.claimPrefix(cloudPair.a, 'cloud');
        const cloud = LinkRpcConnection.fromTransport(cloudPair.b);
        cloud.register(directoryInterface, {
            list: () => ({
                items: [{
                    serviceId: 'cloud',
                    interfaceId: directoryInterface.info.id,
                    interfaceHash: directoryInterface.schemaHash,
                }],
            }),
            watch: directoryWatchNever,
        });
        cloud.register(directoryInterface, {
            list: () => ({
                items: [{
                    serviceId: 'cloud/Auth',
                    interfaceId: directoryInterface.info.id,
                    interfaceHash: directoryInterface.schemaHash,
                }],
            }),
            watch: directoryWatchNever,
        }, { serviceId: 'cloud' });
        cloud.register(directoryInterface, {
            list: () => ({
                items: [{
                    serviceId: 'cloud/Auth',
                    interfaceId: 'Auth',
                    interfaceHash: 'auth-v1',
                }],
            }),
            watch: directoryWatchNever,
        }, { serviceId: 'cloud/Auth' });

        const consumer = attachConsumer(hub);
        const listings = await walkHub(consumer.channel, { rootTarget: 'hub' });
        expect(listings).toContainEqual(expect.objectContaining({
            serviceId: 'cloud/Auth',
            interfaceId: 'Auth',
            hash: 'auth-v1',
        }));
    });

    it('does not synthesize a directory referral from a raw routing claim', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const pair = new TransportPair();
        const child = hub.attach(pair.a);
        const childHub = new Hub();
        const childSide = childHub.attach(pair.b);
        const consumer = attachConsumer(hub);
        let ticks = 0;
        const watch = consumer.service('hub').get(directoryInterface).watch(
            { interfaceId: directoryInterface.info.id },
            { onMessage: () => ticks++ },
        );
        await consumer.service('hub').get(directoryInterface).list({});

        child.claimPrefix('child');
        await until(() => ticks === 1);
        const afterClaim = await consumer.service('hub').get(directoryInterface).list({
            interfaceId: directoryInterface.info.id,
        });
        expect(afterClaim.items.some((item) => item.serviceId === 'child')).toBe(false);

        child.dispose();
        childSide.dispose();
        await until(() => ticks === 2);
        const after = await consumer.service('hub').get(directoryInterface).list({
            interfaceId: directoryInterface.info.id,
        });
        expect(after.items.some((item) => item.serviceId === 'child')).toBe(false);
        watch.cancel('done');
    });

    it('ticks the global directory when a participant adds a referral under an existing claim', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const pair = new TransportPair();
        const child = hub.attach(pair.a);
        const participant = LinkRpcConnection.fromTransport(pair.b);
        child.claimPrefix('acme');
        participant.enableReflection({ serviceId: 'acme' });
        const consumer = attachConsumer(hub);
        let ticks = 0;
        const watch = consumer.service('hub').get(directoryInterface).watch(
            { interfaceId: directoryInterface.info.id },
            { onMessage: () => ticks++ },
        );
        await consumer.service('hub').get(directoryInterface).list({});

        participant.enableReflection({ serviceId: 'acme/new' });

        await until(() => ticks === 1);
        const after = await consumer.service('hub').get(directoryInterface).list({
            interfaceId: directoryInterface.info.id,
        });
        expect(after.items).toContainEqual(expect.objectContaining({
            serviceId: 'acme/new',
            interfaceId: directoryInterface.info.id,
        }));
        watch.cancel('done');
    });

    it('ticks the overlay root directory when its registration set changes', async () => {
        const hub = new Hub();
        const { overlay } = makeOverlay(hub);
        const pair = new TransportPair();
        overlay.connectParticipant(pair.a);
        const participant = LinkRpcConnection.fromTransport(pair.b);
        let ticks = 0;
        const watch = participant.get(directoryInterface).watch(
            { interfaceId: pingInterface.info.id },
            { onMessage: () => ticks++ },
        );
        await participant.get(directoryInterface).list({});

        overlay.root.register(pingInterface, {
            ping: () => ({ pong: true }),
        });

        await until(() => ticks === 1);
        const after = await participant.get(directoryInterface).list({
            interfaceId: pingInterface.info.id,
        });
        expect(after.items).toContainEqual(expect.objectContaining({
            serviceId: '',
            interfaceId: pingInterface.info.id,
        }));
        watch.cancel('done');
    });

    async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
        const started = Date.now();
        while (!condition()) {
            if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }

    it('the walk folds transitive rootPrincipalSets from a referral onto descendants', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);

        // 'parent' refers to 'child', and the referral edge carries a transitive
        // requirement: reaching anything under 'child' needs node:X. It serves
        // this at its ROOT directory, where the hub's fan-out reads it.
        const parentPair = new TransportPair();
        hub.claimPrefix(parentPair.a, 'parent');
        const parent = LinkRpcConnection.fromTransport(parentPair.b);
        parent.register(directoryInterface, {
            list: ({ interfaceId }) => {
                const items = [
                    {
                        serviceId: 'child',
                        interfaceId: directoryInterface.info.id,
                        interfaceHash: directoryInterface.schemaHash,
                        rootPrincipalSets: [[{ principal: 'node:X', transitive: true }]],
                        reachableServiceIds: [{ prefix: 'github' }],
                    },
                ];
                return {
                    items: interfaceId === undefined
                        ? items
                        : items.filter((i) => i.interfaceId === interfaceId),
                };
            },
            watch: directoryWatchNever,
        });

        // 'child' lists a leaf interface that carries no requirements of its
        // own, reached by the walk via its form-3 `child::linkrpc.directory`.
        const childPair = new TransportPair();
        hub.claimPrefix(childPair.a, 'child');
        const child = LinkRpcConnection.fromTransport(childPair.b);
        child.register(directoryInterface, {
            list: ({ interfaceId }) => {
                const items = [
                    {
                        serviceId: 'github',
                        interfaceId: mathInterface.info.id,
                        interfaceHash: mathInterface.schemaHash,
                    },
                ];
                return {
                    items: interfaceId === undefined
                        ? items
                        : items.filter((i) => i.interfaceId === interfaceId),
                };
            },
            watch: directoryWatchNever,
        }, { serviceId: 'child' });

        const consumer = attachConsumer(hub);
        const leaves = await walkHub(consumer.channel, { rootTarget: 'hub' });
        const github = leaves.find(
            (i) => i.serviceId === 'github' && i.interfaceId === mathInterface.info.id,
        );
        expect(github).toBeDefined();
        expect(github?.rootPrincipalSets).toEqual([[{ principal: 'node:X', transitive: true }]]);
    });

    it("the overlay's own directory is a referral, not an aggregation", async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const { conn: participant } = await joinParticipant(hub, 'calc');

        // Form-2 (root-addressed) directory hits the overlay root services.
        const own = await participant.get(directoryInterface).list({});
        const referrals = own.items.filter(
            (i) => i.serviceId === 'hub' && i.interfaceId === 'linkrpc.directory',
        );
        // Exactly one referral row pointing at the hub's global directory.
        expect(referrals).toHaveLength(1);
        expect(referrals[0]?.reachableServiceIds).toEqual([{ prefix: '' }]);
        // It lists its own connection-root interfaces, but NOT the sibling's services.
        const ids = own.items.map((i) => i.interfaceId);
        expect(ids).toContain('hubGrantedServiceId');
        expect(ids).not.toContain('math');
    });

    it('rejects a prefix already claimed by another participant', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        await joinParticipant(hub, 'calc');

        const { overlay } = makeOverlay(hub, 'calc');
        const pair = new TransportPair();
        overlay.connectParticipant(pair.a);
        const conn = LinkRpcConnection.fromTransport(pair.b);
        await expect(
            conn.get(hubGrantedServiceIdInterface).register({ serviceId: 'calc' }),
        ).rejects.toThrow();
    });

    it('releases the parent prefix when the upstream link is disposed', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);

        const first = await joinParticipant(hub, 'calc');
        expect(hub.claimedPrefixes()).toContain('calc');
        // The acceptor disposes the overlay AND the upstream link on close;
        // detaching the upstream drops its claimed prefixes on the parent.
        first.overlay.dispose();
        first.upstream.dispose();
        expect(hub.claimedPrefixes()).not.toContain('calc');

        // The prefix is now reclaimable by a new participant.
        const second = await joinParticipant(hub, 'calc');
        expect(second.conn).toBeDefined();
    });

    it('hubs nest: a child hub uplinks to a parent and reaches its services', async () => {
        const rootHub = new Hub();

        // A service on the root hub under prefix "os".
        const svcPair = new TransportPair();
        rootHub.claimPrefix(svcPair.a, 'os');
        const osConn = LinkRpcConnection.fromTransport(svcPair.b);
        osConn.register(pingInterface, { ping: () => ({ pong: true }) }, { serviceId: 'os' });

        // A child hub that uses the root hub as its default route.
        const childHub = new Hub();
        const nesting = new TransportPair();
        rootHub.attach(nesting.a);
        childHub.setUplink(nesting.b);

        const childConsumer = attachConsumer(childHub);
        const res = await childConsumer.service('os').get(pingInterface).ping({});
        expect(res).toEqual({ pong: true });
    });
});
