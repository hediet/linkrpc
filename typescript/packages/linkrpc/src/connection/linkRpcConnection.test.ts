import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { nodeInterface } from '../hub/common/node.interfaces';
import {
    topologyInterface,
    trafficInterface,
    type TrafficEvent,
} from '../hub/common/inspection.interfaces';
import { defaultsInterface, directoryInterface, schemasInterface } from '../hub/common/reflection.interfaces';
import { defineInterface, interfaceFromSchema } from './interfaceDefinition';
import { notificationType, requestType } from '../schema/memberTypes';
import { traceMessageTransport, TransportPair } from '../transport/messageTransport';
import type { IMessageTransport } from '../transport/messageTransport';
import type { JsonRpcMessage } from '../protocol/jsonRpc';
import { getLocalMessageContext } from '../transport/messageTransport';
import { RpcError } from './channel';
import { LinkRpcConnection } from './linkRpcConnection';
import { JsonRpcChannel } from './jsonRpcChannel';
import { bareInterfaceTarget } from './bareInterfaceTarget';

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

interface BareBindingVector {
    prefix: string;
    interfaceId: string;
    serviceId?: string;
    members: string[];
}

interface BareBindingCase {
    name: string;
    bindings: BareBindingVector[];
    method: string;
    expected: {
        interfaceId?: string;
        serviceId?: string;
        member?: string;
        error?: 'methodNotFound';
    };
}

const bareBindingVectors = JSON.parse(readFileSync(
    new URL('../../../../../conformance/vectors/bare_bindings.json', import.meta.url),
    'utf8',
)) as {
    invalidPrefixes: string[];
    cases: BareBindingCase[];
};

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

    it('marks outbound inspection requests without requiring a local watcher', () => {
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

        expect(sent).toBeDefined();
        expect(getLocalMessageContext(sent!)?.inspection).toBe(true);
        expect(JSON.stringify(sent)).not.toContain('context');
        expect(getLocalMessageContext({
            jsonrpc: '2.0',
            id: 1,
            method: 'hub::hubrpc.topology::getGraph',
            context: { inspection: true },
        } as JsonRpcMessage)).toBeUndefined();
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

    it('lazily observes endpoint requests and responses without self-traffic', async () => {
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
        expect(transits).toHaveLength(2);
        expect(transits.map((transit) => transit.kind)).toEqual(['request', 'response']);
        expect(transits[0]).toMatchObject({
            method: 'other::test.greeter::hello',
            disposition: 'consumed',
            in: expect.objectContaining({ requestId: expect.any(Number) }),
        });
        expect(transits[1]).toMatchObject({
            method: 'other::test.greeter::hello',
            disposition: 'forwarded',
            out: expect.objectContaining({ requestId: transits[0].in?.requestId }),
        });
        expect(transits.every((transit) =>
            !transit.method?.includes('hubrpc.topology')
            && !transit.method?.includes('hubrpc.node')
            && !transit.method?.includes('hubrpc.traffic'))).toBe(true);

        await watch.cancel('test-complete');
        await expect(watch).resolves.toMatchObject({ delivered: 2, dropped: 0 });
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

describe('LinkRpcConnection — bare bindings', () => {
    const language = defineInterface(
        { id: 'test.language' },
        {
            hover: requestType(z.object({ value: z.string() }), z.string()),
            changed: notificationType(z.object({ value: z.string() })),
        },
    );

    it('uses the longest prefix without falling back when its member is absent', async () => {
        const pair = new TransportPair();
        const client = JsonRpcChannel.create(pair.a).sender;
        const server = LinkRpcConnection.fromTransport(pair.b);
        server.register(language, {
            hover: ({ value }) => `root:${value}`,
            changed: () => { },
        });
        server.service('mounted').register(greeter, {
            hello: ({ name }) => ({ greeting: `mounted:${name}` }),
            shout: () => { },
        });
        server.bindBare(language, { prefix: 'text/' });
        server.bindBare(greeter, { prefix: 'text/document/', serviceId: 'mounted' });

        await expect(client.sendRequest('text/hover', { value: 'x' })).resolves.toBe('root:x');
        await expect(client.sendRequest('text/document/hello', { name: 'x' }))
            .resolves.toEqual({ greeting: 'mounted:x' });
        await expect(client.sendRequest('text/document/hover', { value: 'x' }))
            .rejects.toMatchObject({ code: -32601, data: { reason: 'unknown-method' } });
        client.close();
        server.close();
    });

    it('validates prefixes, registration targets, and duplicate prefixes', () => {
        const { server, dispose } = makePair();
        server.register(language, { hover: ({ value }) => value, changed: () => { } });
        expect(() => server.bindBare(language, { prefix: '\n' })).toThrow(/printable ASCII/);
        expect(() => server.bindBare(language, { prefix: 'a::b' })).toThrow(/must not contain/);
        expect(() => server.bindBare(greeter, { prefix: 'x' })).toThrow(/not registered/);
        server.bindBare(language, { prefix: 'x' });
        expect(() => server.bindBare(language, { prefix: 'x' })).toThrow(/already bound/);
        dispose();
    });

    describe('shared conformance vectors', () => {
        for (const vector of bareBindingVectors.cases) {
            it(vector.name, async () => {
                const pair = new TransportPair();
                const client = JsonRpcChannel.create(pair.a).sender;
                const server = LinkRpcConnection.fromTransport(pair.b);
                for (const binding of vector.bindings) {
                    const resultSchema = z.object({
                        interfaceId: z.string(),
                        serviceId: z.string().optional(),
                        member: z.string(),
                    });
                    const iface = defineInterface(
                        { id: binding.interfaceId },
                        Object.fromEntries(binding.members.map((member) => [
                            member,
                            requestType(z.object({}), resultSchema),
                        ])),
                    );
                    const handlers = Object.fromEntries(binding.members.map((member) => [
                        member,
                        () => ({
                            interfaceId: binding.interfaceId,
                            ...(binding.serviceId === undefined ? {} : { serviceId: binding.serviceId }),
                            member,
                        }),
                    ]));
                    server.register(iface, handlers as never, { serviceId: binding.serviceId });
                    server.bindBare(iface, {
                        prefix: binding.prefix,
                        serviceId: binding.serviceId,
                    });
                }

                if (vector.expected.error === 'methodNotFound') {
                    await expect(client.sendRequest(vector.method, {}))
                        .rejects.toMatchObject({ code: -32601 });
                } else {
                    await expect(client.sendRequest(vector.method, {}))
                        .resolves.toEqual(vector.expected);
                }
                client.close();
                server.close();
            });
        }

        it('rejects every invalid prefix', () => {
            const { server, dispose } = makePair();
            server.register(language, { hover: ({ value }) => value, changed: () => { } });
            for (const prefix of bareBindingVectors.invalidPrefixes) {
                expect(() => server.bindBare(language, { prefix })).toThrow(/prefix/);
            }
            dispose();
        });
    });

    it('removes bindings on either binding or interface disposal', async () => {
        const pair = new TransportPair();
        const client = JsonRpcChannel.create(pair.a).sender;
        const server = LinkRpcConnection.fromTransport(pair.b);
        const registration = server.register(language, {
            hover: ({ value }) => value,
            changed: () => { },
        });
        const first = server.bindBare(language, { prefix: 'a/' });
        first.dispose();
        await expect(client.sendRequest('a/hover', { value: 'x' }))
            .rejects.toMatchObject({ data: { reason: 'no-preset' } });
        server.bindBare(language, { prefix: 'b/' });
        registration.dispose();
        await expect(client.sendRequest('b/hover', { value: 'x' }))
            .rejects.toMatchObject({ data: { reason: 'no-preset' } });
        client.close();
        server.close();
    });

    it('shares the empty slot with setPreset and reflects bindings deterministically', async () => {
        const { client, server, dispose } = makePair();
        server.register(language, { hover: ({ value }) => value, changed: () => { } });
        server.register(greeter, {
            hello: ({ name }) => ({ greeting: name }),
            shout: () => { },
        });
        const explicit = server.bindBare(language, { prefix: '' });
        expect(() => server.bindBare(greeter, { prefix: '' })).toThrow(/already bound/);
        server.setPreset(greeter);
        explicit.dispose(); // Must not remove the replacement preset.
        server.bindBare(language, { prefix: 'z/' });
        server.bindBare(language, { prefix: 'a/' });
        server.enableReflection();

        await expect(client.getBare(greeter).hello({ name: 'x' }))
            .resolves.toEqual({ greeting: 'x' });
        await expect(client.get(defaultsInterface).get({})).resolves.toMatchObject({
            interfaceId: greeter.info.id,
            interfaceHash: greeter.schemaHash,
        });
        await expect(client.get(defaultsInterface).listBindings({})).resolves.toEqual({
            bindings: [
                {
                    prefix: '',
                    serviceId: undefined,
                    interfaceId: greeter.info.id,
                    interfaceHash: greeter.schemaHash,
                },
                {
                    prefix: 'a/',
                    serviceId: undefined,
                    interfaceId: language.info.id,
                    interfaceHash: language.schemaHash,
                },
                {
                    prefix: 'z/',
                    serviceId: undefined,
                    interfaceId: language.info.id,
                    interfaceHash: language.schemaHash,
                },
            ],
        });
        dispose();
    });

    it('defaults get reports only the empty binding, including its mounted service', async () => {
        const { client, server, dispose } = makePair();
        server.service('mounted').register(language, {
            hover: ({ value }) => value,
            changed: () => { },
        });
        server.bindBare(language, { prefix: 'nonempty/', serviceId: 'mounted' });
        server.enableReflection();
        await expect(client.get(defaultsInterface).get({})).resolves.toEqual({});

        server.bindBare(language, { prefix: '', serviceId: 'mounted' });
        await expect(client.get(defaultsInterface).get({})).resolves.toEqual({
            serviceId: 'mounted',
            interfaceId: language.info.id,
            interfaceHash: language.schemaHash,
        });
        dispose();
    });

    it('getBare sends exact method names without interface metadata and supports reverse calls', async () => {
        const pair = new TransportPair();
        const a = LinkRpcConnection.fromTransport(pair.a);
        const b = LinkRpcConnection.fromTransport(pair.b);
        const changes: string[] = [];
        b.register(language, {
            hover: ({ value }) => `b:${value}`,
            changed: ({ value }) => { changes.push(value); },
        });
        b.bindBare(language, { prefix: 'lsp/' });
        a.register(language, {
            hover: ({ value }) => `a:${value}`,
            changed: () => { },
        });
        a.bindBare(language, { prefix: 'reverse/' });

        const dynamicLanguage = interfaceFromSchema(language.toSchema());
        await expect(a.getBare(dynamicLanguage, { prefix: 'lsp/' }).hover({ value: 'x' }))
            .resolves.toBe('b:x');
        a.getBare(language, { prefix: 'lsp/' }).changed({ value: 'notice' });
        await expect(b.getBare(language, { prefix: 'reverse/' }).hover({ value: 'y' }))
            .resolves.toBe('a:y');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(changes).toEqual(['notice']);
        a.close();
        b.close();
    });

    it('getBare preserves legitimate null and rejects streaming interfaces', async () => {
        const nullable = defineInterface(
            { id: 'test.nullable' },
            { read: requestType(z.object({}), z.null()) },
        );
        const sender = {
            sendRequest: async () => null,
            sendNotification: async () => { },
            sendRequestWithStream: () => { throw new Error('unused'); },
            close: () => { },
        };
        const connection = new LinkRpcConnection(sender);
        await expect(connection.getBare(nullable).read({})).resolves.toBeNull();
        await expect(connection.getBare(interfaceFromSchema(nullable.toSchema())).read({}))
            .resolves.toBeNull();

        const streaming = defineInterface(
            { id: 'test.streaming' },
            {
                watch: requestType(z.object({}), z.object({}))
                    .withStream({ server: z.object({}) }),
            },
        );
        expect(() => connection.getBare(streaming)).toThrow(/streaming method/);
    });

    it('getBare omits LinkRPC metadata for requests and notifications', async () => {
        const sent: Array<{ method: string; opts: unknown; }> = [];
        const sender = {
            sendRequest: async (method: string, _params: unknown, opts?: unknown) => {
                sent.push({ method, opts });
                return 'ok';
            },
            sendNotification: async (method: string, _params: unknown, opts?: unknown) => {
                sent.push({ method, opts });
            },
            sendRequestWithStream: () => { throw new Error('unused'); },
            close: () => { },
        };
        const connection = new LinkRpcConnection(sender);
        const client = connection.getBare(language, { prefix: 'cdp.' });
        await expect(client.hover({ value: 'x' })).resolves.toBe('ok');
        client.changed({ value: 'x' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(sent).toEqual([
            { method: 'cdp.hover', opts: undefined },
            { method: 'cdp.changed', opts: undefined },
        ]);
    });

    it('get accepts an immutable bare interface target without changing normal get', async () => {
        const runtime = defineInterface(
            { id: 'cdp.runtime' },
            {
                evaluate: requestType(
                    z.object({ expression: z.string() }),
                    z.object({ result: z.object({ value: z.number() }) }),
                ),
            },
        );
        const sent: Array<{ method: string; params: unknown; opts: unknown; }> = [];
        const sender = {
            sendRequest: async (method: string, params: unknown, opts?: unknown) => {
                sent.push({ method, params, opts });
                return { result: { value: 42 } };
            },
            sendNotification: async () => { },
            sendRequestWithStream: () => { throw new Error('unused'); },
            close: () => { },
        };
        const connection = new LinkRpcConnection(sender);
        const cdpRuntime = bareInterfaceTarget(runtime, { prefix: 'Runtime.' });

        expect(Object.isFrozen(cdpRuntime)).toBe(true);
        const response = await connection.get(cdpRuntime).evaluate({ expression: '6 * 7' });
        response.result.value satisfies number;
        expect(response).toEqual({ result: { value: 42 } });
        expect(sent).toEqual([{
            method: 'Runtime.evaluate',
            params: { expression: '6 * 7' },
            opts: undefined,
        }]);

        await connection.get(runtime).evaluate({ expression: 'normal' });
        expect(sent[1]).toMatchObject({
            method: 'cdp.runtime::evaluate',
            opts: { interfaceHash: runtime.schemaHash },
        });

        if (false) {
            // @ts-expect-error bare targets do not accept native service/call options
            connection.get(cdpRuntime, { serviceId: 'runtime' });
            // @ts-expect-error service-scoped get only accepts interface definitions
            connection.service('runtime').get(cdpRuntime);
        }
        expect(() => (connection.service('runtime').get as (target: unknown) => unknown)(cdpRuntime))
            .toThrow(/bare interface targets do not accept/);
    });

    it('bareInterfaceTarget and getBare reject the same invalid prefixes', () => {
        const connection = new LinkRpcConnection({
            sendRequest: async () => null,
            sendNotification: async () => { },
            sendRequestWithStream: () => { throw new Error('unused'); },
            close: () => { },
        });
        for (const prefix of bareBindingVectors.invalidPrefixes) {
            expect(() => bareInterfaceTarget(language, { prefix })).toThrow(/prefix/);
            expect(() => connection.getBare(language, { prefix })).toThrow(/prefix/);
        }
    });

    it('getBare omits params from the JSON-RPC envelope when undefined', async () => {
        const noParams = defineInterface(
            { id: 'test.noParams' },
            { ping: requestType(z.undefined(), z.string()) },
        );
        const pair = new TransportPair();
        const outbound: JsonRpcMessage[] = [];
        const client = LinkRpcConnection.fromTransport(traceMessageTransport(
            pair.a,
            (direction, message) => {
                if (direction === 'send') outbound.push(message);
            },
        ));
        const server = LinkRpcConnection.fromTransport(pair.b);
        server.register(noParams, { ping: () => 'pong' });
        server.bindBare(noParams, { prefix: 'cdp.' });

        await expect(client.getBare(noParams, { prefix: 'cdp.' }).ping(undefined))
            .resolves.toBe('pong');
        expect(outbound[0]).toEqual({
            jsonrpc: '2.0',
            id: 1,
            method: 'cdp.ping',
        });
        client.close();
        server.close();
    });

    it('does not emit native stream keepalives for slow foreign requests', async () => {
        vi.useFakeTimers();
        try {
            const outbound: JsonRpcMessage[] = [];
            const transport: IMessageTransport = {
                send: (message) => { outbound.push(message); },
                setListener: () => { },
                dispose: () => { },
            };
            const connection = LinkRpcConnection.fromTransport(transport);
            const pending = connection.getBare(language, { prefix: 'lsp/' }).hover({ value: 'x' });

            await vi.advanceTimersByTimeAsync(11 * 60_000);
            expect(outbound).toEqual([{
                jsonrpc: '2.0',
                id: 1,
                method: 'lsp/hover',
                params: { value: 'x' },
            }]);

            connection.close();
            await expect(pending).rejects.toMatchObject({ code: -32402 });
        } finally {
            vi.useRealTimers();
        }
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
        ];

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
