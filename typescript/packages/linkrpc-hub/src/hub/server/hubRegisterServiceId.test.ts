import { describe, expect, it } from 'vitest';
import { defineInterface, directoryInterface, requestType, LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { z } from 'zod';
import { walkHub } from '@hediet/linkrpc/hub/common';
import { hubRegisterServiceId } from './hubRegisterServiceId';
import { createHubServiceInterfaces } from './hubServices';
import { Hub } from './routing/routingHub';

const mathInterface = defineInterface(
    { id: 'math', description: 'Arithmetic.' },
    { add: requestType(z.object({ a: z.number(), b: z.number() }), z.object({ sum: z.number() })) },
);

/** Attach a bare consumer link to the hub (no overlay). */
function attachConsumer(hub: Hub): LinkRpcConnection {
    const pair = new TransportPair();
    hub.attach(pair.a);
    return LinkRpcConnection.fromTransport(pair.b);
}

describe('hubRegisterServiceId (in-process service)', () => {
    it('routes fully-qualified calls to the in-process service', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);

        const svc = hubRegisterServiceId(hub, 'vscode');
        svc.connection.register(mathInterface, { add: ({ a, b }) => ({ sum: a + b }) }, { serviceId: 'vscode' });

        const consumer = attachConsumer(hub);
        const result = await consumer.service('vscode').get(mathInterface).add({ a: 2, b: 3 });
        expect(result).toEqual({ sum: 5 });
    });

    it('surfaces the service as a referral that the walk flattens', async () => {
        const hub = new Hub();
        const { connection: hubConn, hubServiceId } = createHubServiceInterfaces(hub);

        const svc = hubRegisterServiceId(hub, 'vscode');
        svc.connection.register(mathInterface, { add: ({ a, b }) => ({ sum: a + b }) }, { serviceId: 'vscode' });

        const consumer = attachConsumer(hub);

        // Referral-only: the hub lists the 'vscode' prefix's directory, not its
        // leaves.
        const { items } = await consumer
            .service(hubServiceId)
            .get(directoryInterface)
            .list({});
        expect(items.some((it) => it.serviceId === 'vscode' && it.interfaceId === 'linkrpc.directory')).toBe(true);
        expect(items.some((it) => it.serviceId === 'vscode' && it.interfaceId === 'math')).toBe(false);

        // The breadth-first walk recurses into the referral and finds the leaf.
        const leaves = await walkHub(consumer.channel, { rootTarget: hubServiceId });
        expect(leaves.some((it) => it.serviceId === 'vscode' && it.interfaceId === 'math')).toBe(true);
        void hubConn;
    });

    it('releases the claimed prefix when disposed', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);

        const first = hubRegisterServiceId(hub, 'vscode');
        first.connection.register(mathInterface, { add: ({ a, b }) => ({ sum: a + b }) }, { serviceId: 'vscode' });
        first.dispose();

        // The prefix is free again — a second registration may claim it.
        const second = hubRegisterServiceId(hub, 'vscode');
        second.connection.register(mathInterface, { add: ({ a, b }) => ({ sum: a * b }) }, { serviceId: 'vscode' });

        const consumer = attachConsumer(hub);
        const result = await consumer.service('vscode').get(mathInterface).add({ a: 4, b: 5 });
        expect(result).toEqual({ sum: 20 });
    });
});
