import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { directoryInterface } from '../hub/common/reflection.interfaces';
import { requestType } from '../schema/memberTypes';
import { TransportPair } from '../transport/messageTransport';
import { defineInterface } from './interfaceDefinition';
import { LinkRpcConnection } from './linkRpcConnection';

describe('LinkRpcConnection reflection watch', () => {
    it('ticks when matching registrations are added or removed', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        server.enableReflection({ serviceId: 'svc' });
        let ticks = 0;
        const watch = client.service('svc').get(directoryInterface).watch(
            { interfaceId: 'demo.dynamic' },
            { onMessage: () => ticks++ },
        );
        await client.service('svc').get(directoryInterface).list({});
        const dynamic = defineInterface(
            { id: 'demo.dynamic' },
            { run: requestType(z.object({}), z.object({})) },
        );

        const registration = server.register(dynamic, { run: () => ({}) }, { serviceId: 'svc' });
        await until(() => ticks === 1);
        registration.dispose();
        await until(() => ticks === 2);
        watch.cancel('done');
    });

    it('supports interface family prefix watches', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        server.enableReflection({ serviceId: 'svc' });
        let ticks = 0;
        const watch = client.service('svc').get(directoryInterface).watch(
            { interfaceIdPrefix: 'mcp.server.' },
            { onMessage: () => ticks++ },
        );
        await client.service('svc').get(directoryInterface).list({});
        const unrelated = defineInterface(
            { id: 'demo.unrelated' },
            { run: requestType(z.object({}), z.object({})) },
        );
        const matching = defineInterface(
            { id: 'mcp.server.github' },
            { run: requestType(z.object({}), z.object({})) },
        );

        server.register(unrelated, { run: () => ({}) }, { serviceId: 'svc' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(ticks).toBe(0);
        server.register(matching, { run: () => ({}) }, { serviceId: 'svc' });
        await until(() => ticks === 1);
        watch.cancel('done');
    });

    it('uses segment-aware service scopes as watch relevance hints', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        server.enableReflection({ serviceId: 'svc' });
        let ticks = 0;
        const watch = client.service('svc').get(directoryInterface).watch(
            { serviceIdScopes: [{ prefix: 'svc' }] },
            { onMessage: () => ticks++ },
        );
        await client.service('svc').get(directoryInterface).list({});
        const dynamic = defineInterface(
            { id: 'demo.scoped' },
            { run: requestType(z.object({}), z.object({})) },
        );

        server.service('svc-other').register(dynamic, { run: () => ({}) });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(ticks).toBe(0);
        server.service('svc/child').register(dynamic, { run: () => ({}) });
        await until(() => ticks === 1);
        watch.cancel('done');
    });

    it('ticks filtered watches when service metadata changes through another interface', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        server.enableReflection({ serviceId: 'demo' });
        const first = defineInterface(
            { id: 'demo.first' },
            { run: requestType(z.object({}), z.object({})) },
        );
        const second = defineInterface(
            { id: 'demo.second' },
            { run: requestType(z.object({}), z.object({})) },
        );
        server.service('demo').register(first, { run: () => ({}) });
        let ticks = 0;
        const watch = client.service('demo').get(directoryInterface).watch(
            { interfaceId: first.info.id },
            { onMessage: () => ticks++ },
        );
        await client.service('demo').get(directoryInterface).list({});

        server.service('demo').register(
            second,
            { run: () => ({}) },
            { serviceDescription: 'Demo service' },
        );

        await until(() => ticks === 1);
        const listing = await client.service('demo').get(directoryInterface).list({
            interfaceId: first.info.id,
        });
        expect(listing.items).toContainEqual(expect.objectContaining({
            interfaceId: first.info.id,
            serviceDescription: 'Demo service',
        }));
        watch.cancel('done');
    });

    it('isolates coarse directory listener failures from registration cleanup', () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const dynamic = defineInterface(
            { id: 'demo.listener-failure' },
            { run: requestType(z.object({}), z.object({})) },
        );
        server.onDidChangeDirectory(() => {
            throw new Error('observer failed');
        });

        const registration = server.register(dynamic, { run: () => ({}) });
        expect(server.listRegisteredInterfaces()).toContainEqual(expect.objectContaining({
            interfaceId: dynamic.info.id,
        }));
        registration.dispose();
        expect(server.listRegisteredInterfaces()).not.toContainEqual(expect.objectContaining({
            interfaceId: dynamic.info.id,
        }));
    });
});

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
