import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { nodeInterface } from '../hub/common/node.interfaces';
import {
    topologyInterface,
    trafficInterface,
    type TrafficEvent,
} from '../hub/common/inspection.interfaces';
import { defaultsInterface, directoryInterface, schemasInterface } from '../hub/common/reflection.interfaces';
import { defineInterface } from './interfaceDefinition';
import { notificationType, requestType } from '../schema/memberTypes';
import { TransportPair } from '../transport/messageTransport';
import type { IMessageTransport } from '../transport/messageTransport';
import type { JsonRpcMessage } from '../protocol/jsonRpc';
import { RpcError } from './channel';
import { LinkRpcConnection } from './linkRpcConnection';
import { JsonRpcChannel } from './jsonRpcChannel';

const greeter = defineInterface(
    { id: 'test.greeter' },
    {
        hello: requestType(
            z.object({ name: z.string() }),
            z.object({ greeting: z.string() }),
        ),
        shout: notificationType(z.object({ msg: z.string() })),
    },
);

function makePair(): { client: LinkRpcConnection; server: LinkRpcConnection; dispose: () => void; } {
    const pair = new TransportPair();
    const client = LinkRpcConnection.fromTransport(pair.a);
    const server = LinkRpcConnection.fromTransport(pair.b);
    return {
        client,
        server,
        dispose: () => {
            client.close();
            server.close();
        },
    };
}

describe('LinkRpcConnection', () => {
    it('round-trips a request via form 2', async () => {
        const { client, server, dispose } = makePair();
        server.register(greeter, {
            hello: async ({ name }) => ({ greeting: `Hi, ${name}!` }),
            shout: () => { },
        });
        const g = client.get(greeter);
        expect(await g.hello({ name: 'world' })).toEqual({ greeting: 'Hi, world!' });
        dispose();
    });

    it('delivers notifications', async () => {
        const { client, server, dispose } = makePair();
        const received: string[] = [];
        let resolveDone!: () => void;
        const done = new Promise<void>((r) => {
            resolveDone = r;
        });
        server.register(greeter, {
            hello: async () => ({ greeting: '' }),
            shout: ({ msg }) => {
                received.push(msg);
                resolveDone();
            },
        });
        client.get(greeter).shout({ msg: 'boom' });
        await done;
        expect(received).toEqual(['boom']);
        dispose();
    });

    it('rejects invalid request params locally by default', async () => {
        const { client, server, dispose } = makePair();
        server.register(greeter, {
            hello: async ({ name }) => ({ greeting: `Hi, ${name}!` }),
            shout: () => { },
        });
        const g = client.get(greeter);
        // @ts-expect-error - bad params on purpose
        const err = await g.hello({ name: 42 }).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(-32602);
        expect((err as RpcError).message).toBe('Invalid params for test.greeter::hello');
        expect((err as RpcError).data).toMatchObject({
            issues: [expect.objectContaining({ path: ['name'] })],
        });
        dispose();
    });

    it('can disable outbound request param validation', async () => {
        const pair = new TransportPair();
        const client = LinkRpcConnection.fromTransport(pair.a, { validateOutboundParams: false });
        const server = LinkRpcConnection.fromTransport(pair.b);
        server.register(greeter, {
            hello: async ({ name }) => ({ greeting: `Hi, ${name}!` }),
            shout: () => { },
        });

        // @ts-expect-error - bad params on purpose
        const err = await client.get(greeter).hello({ name: 42 }).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(-32602);
        expect((err as RpcError).message).toBe('Invalid params');

        client.close();
        server.close();
    });

    it('rejects invalid notification params locally by default', async () => {
        const { client, dispose } = makePair();

        await expect(
            // @ts-expect-error - bad params on purpose
            client.get(greeter).shout({ msg: 42 }),
        ).rejects.toMatchObject({
            code: -32602,
            message: 'Invalid params for test.greeter::shout',
            data: { issues: [expect.objectContaining({ path: ['msg'] })] },
        });
        dispose();
    });

    it('rejects with -32601 when interface is unregistered', async () => {
        const { client, dispose } = makePair();
        const err = await client.get(greeter).hello({ name: 'x' }).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(-32601);
        dispose();
    });

    it('routes via form 3 with explicit serviceId', async () => {
        const { client, server, dispose } = makePair();
        server.service('svcA').register(greeter, {
            hello: async ({ name }) => ({ greeting: `A:${name}` }),
            shout: () => { },
        });
        server.service('svcB').register(greeter, {
            hello: async ({ name }) => ({ greeting: `B:${name}` }),
            shout: () => { },
        });

        expect(await client.service('svcA').get(greeter).hello({ name: 'x' }))
            .toEqual({ greeting: 'A:x' });
        expect(await client.service('svcB').get(greeter).hello({ name: 'x' }))
            .toEqual({ greeting: 'B:x' });
        dispose();
    });

    it('two interfaces share one connection', async () => {
        const { client, server, dispose } = makePair();
        const other = defineInterface(
            { id: 'test.other' },
            { add: requestType(z.object({ a: z.number(), b: z.number() }), z.number()) },
        );
        server.register(greeter, {
            hello: async ({ name }) => ({ greeting: `Hi ${name}` }),
            shout: () => { },
        });
        server.register(other, {
            add: ({ a, b }) => a + b,
        });
        expect(await client.get(greeter).hello({ name: 'z' })).toEqual({ greeting: 'Hi z' });
        expect(await client.get(other).add({ a: 2, b: 3 })).toBe(5);
        dispose();
    });

    it('propagates RpcError thrown by a handler', async () => {
        const { client, server, dispose } = makePair();
        server.register(greeter, {
            hello: async () => {
                throw new RpcError('nope', -32099, { why: 'test' });
            },
            shout: () => { },
        });
        const err = await client.get(greeter).hello({ name: 'x' }).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(-32099);
        expect((err as RpcError).data).toEqual({ why: 'test' });
        dispose();
    });

    it('refuses duplicate registration of the same interface', () => {
        const { server, dispose } = makePair();
        server.register(greeter, { hello: async () => ({ greeting: '' }), shout: () => { } });
        expect(() => server.register(greeter, { hello: async () => ({ greeting: '' }), shout: () => { } }))
            .toThrow(/already registered/);
        dispose();
    });

    it('disposes registrations and permits the same route to be registered again', async () => {
        const { client, server, dispose } = makePair();
        const registration = server.service('dynamic').register(
            greeter,
            {
                hello: async ({ name }) => ({ greeting: `first:${name}` }),
                shout: () => { },
            },
            { serviceDescription: 'Dynamic service' },
        );
        const dynamic = client.service('dynamic').get(greeter);

        expect(await dynamic.hello({ name: 'x' })).toEqual({ greeting: 'first:x' });
        expect(server.listRegisteredInterfaces()).toEqual([
            expect.objectContaining({
                serviceId: 'dynamic',
                interfaceId: greeter.info.id,
                serviceDescription: 'Dynamic service',
            }),
        ]);

        registration.dispose();
        registration.dispose();

        await expect(dynamic.hello({ name: 'x' })).rejects.toMatchObject({ code: -32601 });
        expect(server.listRegisteredInterfaces()).toEqual([]);

        server.service('dynamic').register(
            greeter,
            {
                hello: async ({ name }) => ({ greeting: `second:${name}` }),
                shout: () => { },
            },
            { serviceDescription: 'Replacement service' },
        );
        expect(await dynamic.hello({ name: 'x' })).toEqual({ greeting: 'second:x' });
        expect(server.listRegisteredInterfaces()[0]?.serviceDescription).toBe('Replacement service');
        dispose();
    });

    it('disposes a service-scoped reflection set as one registration', async () => {
        const { client, server, dispose } = makePair();
        const reflection = server.enableReflection({ serviceId: 'dynamic' });
        const dynamicDirectory = client.service('dynamic').get(directoryInterface);

        await expect(dynamicDirectory.list({})).resolves.toMatchObject({
            items: expect.any(Array),
        });

        reflection.dispose();
        reflection.dispose();

        await expect(dynamicDirectory.list({})).rejects.toMatchObject({ code: -32601 });
        expect(server.listRegisteredInterfaces()).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ serviceId: 'dynamic' }),
            ]),
        );
        dispose();
    });

    it('enables a stable generated node identity at the connection root', async () => {
        const { client, server, dispose } = makePair();
        const registration = server.enableInspection();
        const repeated = server.enableInspection();
        const node = client.get(nodeInterface);

        expect(repeated).toBe(registration);
        expect(registration.nodeId).toMatch(/^node:[A-Za-z0-9_-]{22}$/);
        expect(registration.portId).toMatch(/^port:[A-Za-z0-9_-]{22}$/);
        expect(registration.nodeId).not.toBe(registration.portId);
        await expect(node.getNodeId({})).resolves.toEqual({
            nodeId: registration.nodeId,
            portId: registration.portId,
        });

        await expect(node.getNodeId({})).resolves.toEqual({
            nodeId: registration.nodeId,
            portId: registration.portId,
        });

        dispose();
    });

    it('uses an injected topology generator and keeps IDs stable until registration disposal', async () => {
        const pair = new TransportPair();
        const client = LinkRpcConnection.fromTransport(pair.a);
        let nextId = 0;
        const server = LinkRpcConnection.fromTransport(pair.b, {
            generateTopologyId: (kind) => `test-${kind}-${++nextId}`,
        });
        try {
            const first = server.enableInspection();
            expect(server.enableInspection()).toBe(first);
            expect(nextId).toBe(2);
            await expect(client.get(nodeInterface).getNodeId({})).resolves.toEqual({
                nodeId: 'test-node-1',
                portId: 'test-port-2',
            });
            first.dispose();
            server.enableInspection();
            await expect(client.get(nodeInterface).getNodeId({})).resolves.toEqual({
                nodeId: 'test-node-3',
                portId: 'test-port-4',
            });
        } finally {
            client.close();
            server.close();
        }
    });

    it('keeps outbound inspection requests as plain JSON-RPC messages', () => {
        let sent: JsonRpcMessage | undefined;
        const transport: IMessageTransport = {
            send: (message) => {
                sent = message;
            },
            setListener: () => { },
            dispose: () => { },
        };
        const connection = LinkRpcConnection.fromTransport(transport);

        void connection.service('hub').get(topologyInterface).getGraph({}).catch(() => undefined);

        expect(sent).toEqual({
            jsonrpc: '2.0',
            id: 1,
            method: 'hub::hubrpc.topology::getGraph',
            params: {},
        });
        connection.close();
    });

    it('removes and regenerates inspection identity with its registration', async () => {
        const { client, server, dispose } = makePair();
        const first = server.enableInspection();
        const node = client.get(nodeInterface);

        first.dispose();
        first.dispose();
        await expect(node.getNodeId({})).rejects.toMatchObject({ code: -32601 });

        const second = server.enableInspection();
        expect(second.nodeId).not.toBe(first.nodeId);
        expect(second.portId).not.toBe(first.portId);
        await expect(node.getNodeId({})).resolves.toEqual({
            nodeId: second.nodeId,
            portId: second.portId,
        });

        dispose();
    });

    it('exposes shared node identity and trivial graphs under every service', async () => {
        const { client, server, dispose } = makePair();
        server.service('svcA').register(greeter, {
            hello: ({ name }) => ({ greeting: `A:${name}` }),
            shout: () => { },
        });
        server.service('svcB').register(greeter, {
            hello: ({ name }) => ({ greeting: `B:${name}` }),
            shout: () => { },
        });
        const inspection = server.enableInspection();

        const [root, a, b, graphA, graphB] = await Promise.all([
            client.get(nodeInterface).getNodeId({}),
            client.service('svcA').get(nodeInterface).getNodeId({}),
            client.service('svcB').get(nodeInterface).getNodeId({}),
            client.service('svcA').get(topologyInterface).getGraph({}),
            client.service('svcB').get(topologyInterface).getGraph({}),
        ]);

        expect(root).toEqual({ nodeId: inspection.nodeId, portId: inspection.portId });
        expect(a).toEqual(root);
        expect(b).toEqual(root);
        expect(graphA).toMatchObject({
            observerServiceId: 'svcA',
            entryNodeId: inspection.nodeId,
            nodes: [{
                nodeId: inspection.nodeId,
                ports: [{ portId: inspection.portId }],
            }],
            links: [],
            routes: [{
                serviceId: 'svcA',
                nodeId: inspection.nodeId,
                portId: inspection.portId,
                match: 'exact',
            }],
        });
        expect(graphB.routes).toEqual([{
            serviceId: 'svcB',
            nodeId: inspection.nodeId,
            portId: inspection.portId,
            match: 'exact',
        }]);
        inspection.dispose();
        await expect(client.service('svcA').get(topologyInterface).getGraph({}))
            .rejects.toMatchObject({ code: -32601 });
        dispose();
    });

    it('adds and removes service inspection with late business registrations', async () => {
        const { client, server, dispose } = makePair();
        server.enableInspection();
        const lateNode = client.service('late').get(nodeInterface);
        await expect(lateNode.getNodeId({})).rejects.toMatchObject({ code: -32601 });

        const registration = server.service('late').register(greeter, {
            hello: ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        await expect(lateNode.getNodeId({})).resolves.toEqual({
            nodeId: expect.stringMatching(/^node:/),
            portId: expect.stringMatching(/^port:/),
        });

        registration.dispose();
        await expect(lateNode.getNodeId({})).rejects.toMatchObject({ code: -32601 });
        dispose();
    });

    it('observes endpoint requests and responses while excluding only self-traffic', async () => {
        const { client, server, dispose } = makePair();
        server.service('svc').register(greeter, {
            hello: ({ name }) => ({ greeting: `Hi ${name}` }),
            shout: () => { },
        });
        server.service('other').register(greeter, {
            hello: ({ name }) => ({ greeting: `Hi ${name}` }),
            shout: () => { },
        });
        server.enableInspection();
        expect(server.trafficObserverCount).toBe(0);

        const events: TrafficEvent[] = [];
        let resolveObserved!: () => void;
        const observed = new Promise<void>((resolve) => resolveObserved = resolve);
        const watch = client.service('svc').get(trafficInterface).watch({}, {
            onMessage: (event) => {
                events.push(event);
                if (events.filter((item) => item.type === 'transit').length >= 2) {
                    resolveObserved();
                }
            },
        });
        expect(server.trafficObserverCount).toBe(1);

        await client.service('svc').get(topologyInterface).getGraph({});
        await client.service('svc').get(nodeInterface).getNodeId({});
        await expect(client.service('other').get(greeter).hello({ name: 'Ada' }))
            .resolves.toEqual({ greeting: 'Hi Ada' });
        await observed;

        const transits = events.filter((event) => event.type === 'transit');
        expect(transits).toHaveLength(6);
        const businessTransits = transits.filter((transit) =>
            transit.method === 'other::test.greeter::hello'
        );
        expect(businessTransits.map((transit) => transit.kind)).toEqual(['request', 'response']);
        expect(businessTransits[0]).toMatchObject({
            method: 'other::test.greeter::hello',
            disposition: 'consumed',
            in: expect.objectContaining({ requestId: expect.any(Number) }),
        });
        expect(businessTransits[1]).toMatchObject({
            method: 'other::test.greeter::hello',
            disposition: 'forwarded',
            out: expect.objectContaining({ requestId: businessTransits[0].in?.requestId }),
        });
        expect(transits.every((transit) =>
            !transit.method?.includes('hubrpc.traffic'))).toBe(true);

        await watch.cancel('test-complete');
        await expect(watch).resolves.toMatchObject({ delivered: 6, dropped: 0 });
        expect(server.trafficObserverCount).toBe(0);
        dispose();
    });

    it('includes capped payloads only for watchWithPayloads', async () => {
        const { client, server, dispose } = makePair();
        server.service('svc').register(greeter, {
            hello: ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        server.enableInspection();

        let resolveFlow!: (event: TrafficEvent) => void;
        const event = new Promise<TrafficEvent>((resolve) => resolveFlow = resolve);
        const watch = client.service('svc').get(trafficInterface).watchWithPayloads({
            methodPrefix: 'svc::test.greeter::hello',
            trafficIgnoreKey: 'payload-watch',
            maxPayloadBytes: 8,
        }, {
            onMessage: (value) => {
                if (value.type === 'transit' && value.kind === 'request') resolveFlow(value);
            },
        });
        await client.service('svc').get(greeter).hello({ name: 'a very long payload' });
        await expect(event).resolves.toMatchObject({
            type: 'transit',
            kind: 'request',
            params: expect.any(String),
        });
        await watch.cancel();
        await watch;
        dispose();
    });

    it('exposes lazy in-process endpoint traffic observations', async () => {
        const { client, server, dispose } = makePair();
        server.service('svc').register(greeter, {
            hello: ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        const inspection = server.enableInspection();
        const events: TrafficEvent[] = [];

        expect(server.trafficObserverCount).toBe(0);
        const observation = inspection.observeTraffic((event) => events.push(event));
        expect(server.trafficObserverCount).toBe(1);
        await client.service('svc').get(greeter).hello({ name: 'Ada' });

        expect(events.map((event) => event.type === 'overflow'
            ? event
            : {
                kind: event.kind,
                method: event.method,
                disposition: event.disposition,
                params: event.params,
                result: event.result,
                direction: event.in !== undefined ? 'inbound' : 'outbound',
            })).toMatchInlineSnapshot(`
              [
                {
                  "direction": "inbound",
                  "disposition": "consumed",
                  "kind": "request",
                  "method": "svc::test.greeter::hello",
                  "params": {
                    "name": "Ada",
                  },
                  "result": undefined,
                },
                {
                  "direction": "outbound",
                  "disposition": "forwarded",
                  "kind": "response",
                  "method": "svc::test.greeter::hello",
                  "params": undefined,
                  "result": {
                    "greeting": "Ada",
                  },
                },
              ]
            `);

        observation.dispose();
        expect(server.trafficObserverCount).toBe(0);
        dispose();
    });

    it('bounds slow traffic subscribers and reports overflow', async () => {
        const { client, server, dispose } = makePair();
        server.service('svc').register(greeter, {
            hello: ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        server.enableInspection();

        let resolveOverflow!: (dropped: number) => void;
        const overflow = new Promise<number>((resolve) => resolveOverflow = resolve);
        const watch = client.service('svc').get(trafficInterface).watch({
            methodPrefix: 'svc::test.greeter::shout',
            trafficIgnoreKey: 'overflow-watch',
        }, {
            onMessage: (event) => {
                if (event.type === 'overflow') resolveOverflow(event.dropped);
            },
        });
        const greeterClient = client.service('svc').get(greeter);
        for (let i = 0; i < 300; i++) greeterClient.shout({ msg: String(i) });

        await expect(overflow).resolves.toBeGreaterThan(0);
        await watch.cancel();
        await expect(watch).resolves.toMatchObject({
            dropped: expect.any(Number),
        });
        expect(server.trafficObserverCount).toBe(0);
        dispose();
    });
});

describe('LinkRpcConnection — preset (form 1)', () => {
    function makeRawClientServer() {
        const pair = new TransportPair();
        const client = JsonRpcChannel.create(pair.a).sender;
        const server = LinkRpcConnection.fromTransport(pair.b);
        return {
            client,
            server,
            dispose: () => {
                client.close();
                server.close();
            },
        };
    }

    it('routes bare method names through the preset interface', async () => {
        const { client, server, dispose } = makeRawClientServer();
        server.register(greeter, {
            hello: async ({ name }) => ({ greeting: `Yo ${name}` }),
            shout: () => { },
        });
        server.setPreset(greeter);
        const result = await client.sendRequest('hello', { name: 'x' });
        expect(result).toEqual({ greeting: 'Yo x' });
        dispose();
    });

    it('returns no-preset error when no preset configured', async () => {
        const { client, server, dispose } = makeRawClientServer();
        server.register(greeter, {
            hello: async ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        const err = await client.sendRequest('hello', { name: 'x' }).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(-32601);
        expect((err as RpcError).data).toMatchObject({ reason: 'no-preset' });
        dispose();
    });

    it('setPreset throws if interface is not registered', () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.b);
        expect(() => server.setPreset(greeter)).toThrow(/not registered/);
        server.close();
    });
});

describe('LinkRpcConnection — reflection', () => {
    it('hubrpc.defaults reports the preset', async () => {
        const { client, server, dispose } = makePair();
        server.register(greeter, {
            hello: async ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        server.setPreset(greeter);
        server.enableReflection();
        const r = await client.get(defaultsInterface).get({});
        expect(r).toEqual({
            serviceId: undefined,
            interfaceId: greeter.info.id,
            interfaceHash: greeter.schemaHash,
        });
        dispose();
    });

    it('hubrpc.directory lists registered services', async () => {
        const { client, server, dispose } = makePair();
        server.register(greeter, {
            hello: async ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        server.service('acme').register(greeter, {
            hello: async ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        server.enableReflection();

        const all = await client.get(directoryInterface).list({});
        const ids = all.items.map((i) => `${i.serviceId}::${i.interfaceId}`).sort();
        expect(ids).toContain(`::${greeter.info.id}`);
        expect(ids).toContain(`acme::${greeter.info.id}`);
        expect(ids).toContain('::hubrpc.directory');
        expect(ids).toContain('::hubrpc.schemas');
        expect(ids).toContain('::hubrpc.defaults');

        const filtered = await client.get(directoryInterface).list({ interfaceId: greeter.info.id });
        expect(filtered.items.every((i) => i.interfaceId === greeter.info.id)).toBe(true);

        const prefixed = await client.get(directoryInterface).list({ interfaceIdPrefix: 'hubrpc.' });
        expect(prefixed.items.map((i) => i.interfaceId).sort()).toEqual([
            'hubrpc.defaults',
            'hubrpc.directory',
            'hubrpc.schemas',
        ]);

        dispose();
    });

    it('hubrpc.directory applies exact and segment-aware prefix service scopes', async () => {
        const { client, server, dispose } = makePair();
        for (const serviceId of ['acme', 'acme/child', 'acme-other']) {
            server.service(serviceId).register(greeter, {
                hello: async ({ name }) => ({ greeting: name }),
                shout: () => { },
            });
        }
        server.enableReflection();

        const prefix = await client.get(directoryInterface).list({
            serviceIdScopes: [{ prefix: 'acme' }],
        });
        expect([...new Set(prefix.items.map((item) => item.serviceId))].sort())
            .toEqual(['acme', 'acme/child']);

        const exact = await client.get(directoryInterface).list({
            serviceIdScopes: [{ exact: 'acme' }],
        });
        expect([...new Set(exact.items.map((item) => item.serviceId))]).toEqual(['acme']);

        const empty = await client.get(directoryInterface).list({ serviceIdScopes: [] });
        expect(empty.items).toEqual([]);
        dispose();
    });

    it('keeps an addressed directory scoped to its addressed service', async () => {
        const { client, server, dispose } = makePair();
        for (const serviceId of ['acme', 'other']) {
            server.service(serviceId).register(greeter, {
                hello: async ({ name }) => ({ greeting: name }),
                shout: () => { },
            });
        }
        server.enableReflection({ serviceId: 'acme' });

        const addressed = await client.service('acme').get(directoryInterface).list({});
        expect(addressed.items.length).toBeGreaterThan(0);
        expect(addressed.items.every((item) => item.serviceId === 'acme')).toBe(true);

        const root = await client.get(directoryInterface).list({});
        expect(root.items.some((item) =>
            item.serviceId === 'acme' && item.interfaceId === directoryInterface.info.id))
            .toBe(true);
        dispose();
    });

    it('hubrpc.directory includes per-service rootPrincipalSets on all interfaces of that service', async () => {
        const { client, server, dispose } = makePair();
        const other = defineInterface(
            { id: 'test.other' },
            {
                ping: requestType(z.object({}), z.object({ ok: z.boolean() })),
            },
        );
        const rootPrincipalSets = [
            [{ principal: 'node:X', transitive: true }],
            [{ principal: 'node:Y' }],
        ] as const;

        server.service('acme').register(greeter, {
            hello: async ({ name }) => ({ greeting: name }),
            shout: () => { },
        }, { rootPrincipalSets });
        server.service('acme').register(other, {
            ping: () => ({ ok: true }),
        });
        server.enableReflection();

        const acme = await client.get(directoryInterface).list({ serviceId: 'acme' });
        expect(acme.items.length).toBeGreaterThan(0);
        expect(acme.items.every((i) => i.rootPrincipalSets !== undefined)).toBe(true);
        for (const item of acme.items) {
            expect(item.rootPrincipalSets).toEqual(rootPrincipalSets);
        }

        dispose();
    });

    it('rejects conflicting rootPrincipalSets for the same service', () => {
        const { server, dispose } = makePair();
        const other = defineInterface(
            { id: 'test.other.conflict' },
            {
                ping: requestType(z.object({}), z.object({ ok: z.boolean() })),
            },
        );

        server.service('acme').register(greeter, {
            hello: async ({ name }) => ({ greeting: name }),
            shout: () => { },
        }, { rootPrincipalSets: [[{ principal: 'node:X' }]] });

        expect(() => {
            server.service('acme').register(other, {
                ping: () => ({ ok: true }),
            }, { rootPrincipalSets: [[{ principal: 'node:Y' }]] });
        }).toThrow('conflicting rootPrincipalSets');

        dispose();
    });

    it('hubrpc.directory pages with limit + cursor', async () => {
        const { client, server, dispose } = makePair();
        server.register(greeter, { hello: async () => ({ greeting: '' }), shout: () => { } });
        server.enableReflection();
        const page1 = await client.get(directoryInterface).list({ limit: 2 });
        expect(page1.items.length).toBe(2);
        expect(page1.nextCursor).toBe('2');
        const page2 = await client.get(directoryInterface).list({ limit: 2, cursor: page1.nextCursor });
        expect(page2.items.length).toBeGreaterThan(0);
        dispose();
    });

    it("hubrpc.schemas returns the registered interface's schema", async () => {
        const { client, server, dispose } = makePair();
        server.register(greeter, {
            hello: async ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        server.enableReflection();
        const r = await client.get(schemasInterface).get({ interfaceId: greeter.info.id });
        const schema = r.schema as { id: string; hash: string; };
        expect(schema.id).toBe(greeter.info.id);
        expect(schema.hash).toBe(greeter.schemaHash);
        dispose();
    });

    it('hubrpc.schemas rejects unknown interface', async () => {
        const { client, server, dispose } = makePair();
        server.enableReflection();
        const err = await client.get(schemasInterface).get({ interfaceId: 'nope.x' }).then(() => null, (e) => e);
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe(-32601);
        dispose();
    });
});
