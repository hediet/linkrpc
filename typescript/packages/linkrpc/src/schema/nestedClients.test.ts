import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
    defineInterface, defineInterfaceTemplate, interfaceFromSchema, LinkRpcConnection,
    applicationError, notificationType, requestType, isRpcFailure,
    type InterfaceClient, type InterfaceHandlers, type InterfaceResultClient,
    type InterfaceTemplateClient, type InterfaceTemplateResultClient, type Schema,
    type InterfaceDeclarations, type FlattenInterfaceDeclarations, type MemberType,
} from '../index';
import { Channel, RpcError, type IRequestSender, type SendOpts } from '../connection/channel';
import { interfaceTarget, defaultInterfaceTarget } from '../connection/interfaceTarget';
import { bareInterfaceTarget } from '../connection/bareInterfaceTarget';
import { TransportPair } from '../transport/messageTransport';

const Store = defineInterfaceTemplate({ id: 'nested.store', parameters: ['Value'] },
    <V>({ Value }: { Value: Schema<V> }) => ({
        get: requestType(z.object({}), Value),
        set: requestType(z.object({ value: Value }), Value),
        changed: notificationType(Value),
    }));
const numbers = Store({ Value: z.number() });
const other = Store({ Value: z.number() }).mapMembers({
    get: 'read+other', set: 'write-other', changed: 'other_changed',
});
const api = defineInterface({ id: 'nested.api' }, { numbers, other, ping: requestType(z.object({}), z.string()) });

function consume(store: InterfaceTemplateClient<typeof numbers>): Promise<number> {
    return store.get({}).then(value => store.set({ value: value + 1 }));
}
function consumeResult(store: InterfaceTemplateResultClient<typeof numbers>) {
    return store.get({});
}
function pair() {
    const transports = new TransportPair();
    const client = LinkRpcConnection.fromTransport(transports.a);
    const server = LinkRpcConnection.fromTransport(transports.b);
    return { client, server, close() { client.close(); server.close(); } };
}
function handlers(): InterfaceHandlers<typeof api> {
    return {
        numbers: { get: () => 10, set: ({ value }) => value, changed: () => {} },
        other: { get: () => 20, set: ({ value }) => value, changed: () => {} },
        ping: () => 'pong',
    };
}

describe('nested clients', () => {
    it('accepts widened mapping variables without forbidding all handler keys', async () => {
        const Echo = defineInterfaceTemplate({ id: 'echo', parameters: ['Value'] },
            <V>({ Value }: { Value: Schema<V> }) => ({ echo: requestType(Value, Value) }));
        const mapping = { echo: 'wire' };
        const mapped = defineInterface({ id: 'mapped' }, {
            values: Echo({ Value: z.number() }).mapMembers(mapping),
            ping: requestType(z.string(), z.string()),
        });
        const implementation: InterfaceHandlers<typeof mapped> = {
            values: { echo: value => value + 1 },
            ping: value => value,
        };
        const p = pair();
        try {
            p.server.register(mapped, implementation);
            expect(await p.client.get(mapped).values.echo(4)).toBe(5);
            expect(await p.client.get(mapped).ping('pong')).toBe('pong');
            expect(() => p.server.register(mapped, { ...implementation, wire: () => 0 } as typeof implementation))
                .toThrow();
        } finally { p.close(); }
    });

    it('keeps broadly annotated declarations uncertain rather than promising callable groups', async () => {
        const declarations: InterfaceDeclarations = { numbers };
        const broad = defineInterface({ id: 'broad' }, declarations);
        expectTypeOf<FlattenInterfaceDeclarations<InterfaceDeclarations>[string]>().toEqualTypeOf<MemberType>();
        const implementation: InterfaceHandlers<typeof broad> = {
            numbers: { get: () => 7, set: ({ value }: { value: number }) => value, changed: () => {} },
        };
        const check = (connection: LinkRpcConnection) => {
            // @ts-expect-error unknown declarations can be nested groups, not just callable members
            connection.get(broad).numbers({});
            // @ts-expect-error result clients preserve the same uncertainty
            connection.getResultClient(broad).numbers({});
            // @ts-expect-error an unknown declaration is not definitely a group either
            connection.get(broad).numbers.get({});
        };
        expect(check).toBeTypeOf('function');
        const p = pair();
        try {
            p.server.register(broad, implementation);
            expect(Object.keys(p.client.get(broad).numbers)).toEqual(['get', 'set', 'changed']);
        } finally { p.close(); }
    });

    it('distributes individual declaration unions without intersecting incompatible member kinds', () => {
        const request = requestType(z.number(), z.number());
        const notification = notificationType(z.number());
        type Either = typeof request | typeof notification;
        expectTypeOf<FlattenInterfaceDeclarations<{ value: Either }>['value']>().toEqualTypeOf<Either>();
        const uncertain = defineInterface({ id: 'uncertain' }, { value: numbers as typeof numbers | typeof request });
        const implementation: InterfaceHandlers<typeof uncertain> = {
            value: { get: () => 1, set: ({ value }) => value, changed: () => {} },
        };
        const check = (connection: LinkRpcConnection) => {
            // @ts-expect-error this particular declaration might be a group
            connection.get(uncertain).value(1);
            // @ts-expect-error result-client helpers distribute the same union
            connection.getResultClient(uncertain).value(1);
        };
        expect(implementation.value).toBeTypeOf('object');
        expect(check).toBeTypeOf('function');
    });

    it('derives group-only types from authored declarations, including result clients', () => {
        expectTypeOf<keyof InterfaceClient<typeof api>>().toEqualTypeOf<'numbers' | 'other' | 'ping'>();
        expectTypeOf<keyof InterfaceResultClient<typeof api>>().toEqualTypeOf<'numbers' | 'other' | 'ping'>();
        expectTypeOf<InterfaceClient<typeof api>['other']>().toEqualTypeOf<InterfaceTemplateClient<typeof numbers>>();
        expectTypeOf<InterfaceClient<typeof api>['other']>().toEqualTypeOf<InterfaceTemplateClient<typeof other>>();
        const check = (client: LinkRpcConnection) => {
            const remote = client.get(api);
            void consume(remote.numbers);
            void consume(remote.other);
            void consumeResult(client.getResultClient(api).other);
            // @ts-expect-error wrong generic parameter
            remote.numbers.set({ value: 'wrong' });
            // @ts-expect-error required member payload
            remote.numbers.set({});
            // @ts-expect-error flat generated aliases are not client properties
            remote['numbers$get']({});
            // @ts-expect-error explicit mapped aliases are not client properties either
            remote['read+other']({});
            // @ts-expect-error result clients use the same group-only shape
            client.getResultClient(api)['numbers$get']({});
            // @ts-expect-error result clients retain generic argument validation
            client.getResultClient(api).other.set({ value: false });
            // @ts-expect-error notifications retain generic argument validation
            remote.other.changed('wrong');
        };
        expect(check).toBeTypeOf('function');
    });

    it('delegates two independent instances to the same consumer and re-registers compatible groups', async () => {
        const p = pair();
        try {
            let notified = 0;
            p.server.register(api, {
                ...handlers(),
                numbers: { ...handlers().numbers, changed: value => { notified = value; } },
            });
            const remote = p.client.get(api);
            expect(Object.keys(remote).sort()).toEqual(['numbers', 'other', 'ping']);
            expect(Object.keys(remote.numbers).sort()).toEqual(['changed', 'get', 'set']);
            expect(Object.hasOwn(remote, 'numbers$get')).toBe(false);
            expect(Object.hasOwn(remote, 'read+other')).toBe(false);
            expect(await consume(remote.numbers)).toBe(11);
            expect(await consume(remote.other)).toBe(21);
            expect(await consumeResult(p.client.getResultClient(api).other)).toBe(20);
            p.client.getResultClient(api).numbers.changed(17);
            expect(await remote.ping({})).toBe('pong');
            expect(notified).toBe(17);

            const delegated = defineInterface({ id: 'nested.delegated' }, { store: numbers });
            p.client.register(delegated, { store: remote.other });
            expect(await p.server.get(delegated).store.get({})).toBe(20);
        } finally { p.close(); }
    });

    it('keeps definitions with identical wire hashes independently flat or grouped', async () => {
        const p = pair();
        const flat = defineInterface(api.info, api.members, {
            templates: {
                numbers: numbers.mapMembers({ get: 'numbers$get', set: 'numbers$set', changed: 'numbers$changed' }),
                other,
            },
        });
        const reflected = interfaceFromSchema(api.toSchema());
        try {
            p.server.register(api, handlers());
            expect(flat.schemaHash).toBe(api.schemaHash);
            expect(flat.toSchema()).toEqual(api.toSchema());
            for (const definition of [flat, reflected]) {
                const remote = p.client.get(definition);
                expect(Object.keys(remote)).toEqual(Object.keys(api.members));
                expect(Object.hasOwn(remote, 'numbers')).toBe(false);
                expect(await remote['numbers$get']({})).toBe(10);
                expect(await p.client.getResultClient(definition)['read+other']({})).toBe(20);
            }
            expect(await p.client.get(api).numbers.get({})).toBe(10);
        } finally { p.close(); }
    });

    it('uses frozen authoring snapshots despite later declaration, mapping and reflection changes', async () => {
        const mapping = { get: 'read', set: 'write', changed: 'notify' } as const;
        const bound = { ...numbers.mapMembers(mapping), mapping };
        const declarations = { store: bound };
        const definition = defineInterface({ id: 'nested.snapshot' }, declarations);
        (mapping as Record<string, string>).get = 'broken';
        Object.assign(declarations, { store: numbers.mapMembers({ get: 'another', set: 'anotherSet', changed: 'anotherChanged' }) });
        definition.toSchema()['x-interface-templates'] = undefined;
        const p = pair();
        try {
            p.server.register(definition, { store: handlers().numbers });
            expect(await p.client.get(definition).store.get({})).toBe(10);
            expect(Object.keys(p.client.get(definition))).toEqual(['store']);
            expect(Object.keys(definition.members)).toEqual(['read', 'write', 'notify']);
        } finally { p.close(); }
    });

    it('treats prototype-like group, member and wire names as own properties', async () => {
        const Special = defineInterfaceTemplate({ id: 'nested.special', parameters: [] }, () => ({
            ['__proto__']: requestType(z.number(), z.number()),
            constructor: requestType(z.number(), z.number()),
            toString: notificationType(z.number()),
        }));
        const definition = defineInterface({ id: 'nested.special.api' }, {
            ['__proto__']: Special({}).mapMembers({ ['__proto__']: 'protoWire', constructor: 'constructor', toString: 'toString' }),
        });
        const p = pair();
        try {
            let notification = 0;
            p.server.register(definition, { ['__proto__']: {
                ['__proto__']: value => value + 1, constructor: value => value + 2,
                toString: value => { notification = value; },
            } });
            const remote = p.client.get(definition);
            expect(Object.getPrototypeOf(remote)).toBeNull();
            expect(Object.getPrototypeOf(remote.__proto__)).toBeNull();
            expect(await remote.__proto__.__proto__(1)).toBe(2);
            remote.__proto__.toString(7);
            expect(await remote.__proto__.constructor(1)).toBe(3);
            expect(notification).toBe(7);
            expect(await p.client.getResultClient(definition).__proto__.__proto__(2)).toBe(3);
            expect(() => definition.flattenHandlers({
                ['__proto__']: { ['__proto__']: () => 1, constructor: () => 1, toString: () => {} },
                toString: () => '',
            })).toThrow(/Unexpected handler/);
        } finally { p.close(); }
    });

    it('reuses materialized call functions and returns augmented calls verbatim', () => {
        const token = Object.assign(Promise.resolve(1), { send: () => {}, cancel: () => {}, ping: () => {} });
        const get = () => token;
        const wire = { 'numbers$get': get, 'numbers$set': get, 'numbers$changed': get,
            'read+other': get, 'write-other': get, other_changed: get, ping: get };
        const nested = api.nestClient(wire) as InterfaceClient<typeof api>;
        expect(nested.numbers.get).toBe(get);
        expect(nested.other.get).toBe(get);
        expect(nested.numbers.get({})).toBe(token);
        const plain = defineInterface({ id: 'plain' }, numbers.members);
        expect(plain.nestClient(wire)).toBe(wire);
    });

    it('preserves context options and qualified, default, service and bare routes', async () => {
        const sent: { method: string; opts?: SendOpts<{ user: string }> }[] = [];
        const sender: IRequestSender<{ user: string }> = {
            sendRequest: async (method, _params, opts) => { sent.push({ method, opts }); return 1; },
            sendNotification: async (method, _params, opts) => { sent.push({ method, opts }); },
            sendRequestWithStream: () => { throw new Error('unused'); }, close: () => {},
        };
        const connection = new LinkRpcConnection<undefined, { user: string }>(sender);
        await connection.get(api, { user: 'alice', serviceId: 'svc' }).numbers.get({});
        await connection.service('other').getResultClient(api, { user: 'bob' }).other.get({});
        await connection.get(interfaceTarget(api, { serviceId: 'target' })).numbers.get({});
        await connection.getResultClient(defaultInterfaceTarget(api)).other.get({});
        await connection.get(bareInterfaceTarget(api, { prefix: 'foreign.' })).numbers.get({});
        await connection.getResultClient(bareInterfaceTarget(api)).other.get({});
        await connection.getBare(api, { prefix: 'bare.' }).numbers.get({});
        expect(sent.map(call => call.method)).toEqual([
            'svc::nested.api::numbers$get', 'other::nested.api::read+other',
            'target::nested.api::numbers$get', 'read+other', 'foreign.numbers$get', 'read+other', 'bare.numbers$get',
        ]);
        expect(sent[0].opts).toEqual({ ctx: { user: 'alice' }, interfaceHash: api.schemaHash });
        expect(sent[1].opts).toEqual({ ctx: { user: 'bob' }, interfaceHash: api.schemaHash });
        expect(sent.slice(4).every(call => call.opts === undefined)).toBe(true);
    });

    it('delivers inbound context to grouped handlers without forwarding it as stream options', async () => {
        const transports = new TransportPair();
        const { JsonRpcChannel } = await import('../connection/jsonRpcChannel');
        const raw = JsonRpcChannel.create(transports.b);
        const server = new LinkRpcConnection(new Channel< { user: string }>(
            raw.sender, handler => raw.setRequestHandler(handler === undefined ? undefined : {
                handleRequest: call => handler.handleRequest({ ...call, context: { user: 'alice' } }),
                handleNotification: call => handler.handleNotification({ ...call, context: { user: 'alice' } }),
            }),
        ));
        const client = LinkRpcConnection.fromTransport(transports.a);
        try {
            server.register(api, {
                ping: () => 'pong',
                other: { get: () => 20, set: ({ value }) => value, changed: () => {} },
                numbers: {
                set: ({ value }) => value,
                changed: () => {},
                get: (_params, ctx) => {
                    expectTypeOf(ctx).toEqualTypeOf<{ user: string }>();
                    expect(ctx.user).toBe('alice');
                    return 30;
                },
            } });
            expect(await client.get(api).numbers.get({})).toBe(30);
        } finally { server.close(); client.close(); }
    });
});

const missing = applicationError('missing', { data: z.object({ value: z.number() }) });
const Streams = defineInterfaceTemplate({ id: 'nested.streams', parameters: [] }, () => ({
    read: requestType(z.object({ fail: z.boolean() }), z.number()).withErrors([missing]),
    duplex: requestType(z.object({ fail: z.boolean() }), z.number())
        .withStream({ client: z.number(), server: z.number() }).withErrors([missing]),
    cancel: requestType(z.object({}), z.number()).withStream({ server: z.string() }),
}));
const streams = Streams({});
const streamingApi = defineInterface({ id: 'nested.streaming' }, { streams });
function streamHandlers(): InterfaceHandlers<typeof streamingApi> {
    return { streams: {
        read: ({ fail }) => fail ? missing.create({ value: 7 }) : 7,
        duplex: ({ fail }, _ctx, stream) => new Promise((resolve, reject) => {
            stream.onMessage(value => {
                void stream.send(value + 1).then(() => resolve(fail ? missing.create({ value }) : value), reject);
            });
            void stream.send(0).catch(reject);
        }),
        cancel: async (_params, _ctx, stream) => {
            const aborted = new Promise<void>(resolve => stream.signal.addEventListener('abort', () => resolve(), { once: true }));
            await stream.send('ready');
            await aborted;
            throw stream.signal.reason;
        },
    } };
}

describe('nested checked and streaming clients', () => {
    it('preserves checked call methods and result-client application errors', async () => {
        const p = pair();
        try {
            p.server.register(streamingApi, streamHandlers());
            const remote = p.client.get(streamingApi);
            const call = remote.streams.read({ fail: true });
            expect(call.result).toBeTypeOf('function');
            expect(missing.is(await call)).toBe(true);
            expect(await call.result()).toMatchObject({ ok: false, error: { type: 'missing', data: { value: 7 } } });
            const result = await p.client.getResultClient(streamingApi).streams.read({ fail: true });
            expect(result).toMatchObject({ error: { kind: 'application', error: { type: 'missing', data: { value: 7 } } } });
            if (isRpcFailure(result) && result.error.kind === 'application') {
                expectTypeOf(result.error.error.data.value).toEqualTypeOf<number>();
            }
        } finally { p.close(); }
    });

    it.each([
        { resultClient: false, fail: false }, { resultClient: false, fail: true },
        { resultClient: true, fail: false }, { resultClient: true, fail: true },
    ])('preserves duplex streams, detached calls and ping ($resultClient, $fail)', async ({ resultClient, fail }) => {
        const p = pair();
        try {
            p.server.register(streamingApi, streamHandlers());
            const remote = resultClient ? p.client.getResultClient(streamingApi) : p.client.get(streamingApi);
            const { duplex } = remote.streams;
            const messages: number[] = [];
            let ready!: () => void;
            const started = new Promise<void>(resolve => { ready = resolve; });
            const call = duplex({ fail }, { onMessage: value => { messages.push(value); ready(); } });
            if (false) {
                // @ts-expect-error stream payload remains specialized
                void call.send('wrong');
                // @ts-expect-error streams cannot be blindly re-registered as handlers: context is not call options
                const incompatible: InterfaceHandlers<typeof streamingApi, { user: string }>['streams'] = remote.streams;
                void incompatible;
            }
            expect(call.send).toBeTypeOf('function');
            expect(call.cancel).toBeTypeOf('function');
            expect(call.dispose).toBeTypeOf('function');
            if (!resultClient) {
                expect((call as ReturnType<InterfaceTemplateClient<typeof streams>['duplex']>).result).toBeTypeOf('function');
            }
            await started;
            await call.ping();
            await call.send(9);
            const value = await call;
            expect(messages).toEqual([0, 10]);
            if (!fail) expect(value).toBe(9);
            else if (resultClient) expect(value).toMatchObject({ error: { kind: 'application', error: { data: { value: 9 } } } });
            else expect(missing.is(value)).toBe(true);
        } finally { p.close(); }
    });

    it.each([false, true])('retains cancellation and generic failures (result client: %s)', async resultClient => {
        const p = pair();
        try {
            p.server.register(streamingApi, streamHandlers());
            const remote = resultClient ? p.client.getResultClient(streamingApi) : p.client.get(streamingApi);
            let ready!: () => void;
            const started = new Promise<void>(resolve => { ready = resolve; });
            const call = remote.streams.cancel({}, { onMessage: () => ready() });
            const settled = call.then(value => ({ value }), error => ({ error }));
            await started;
            await call.cancel('nested cancelled');
            if (resultClient) expect(await settled).toMatchObject({ value: { error: { kind: 'generic', error: { kind: 'remote' } } } });
            else expect(await settled).toMatchObject({ error: { message: 'nested cancelled' } });
        } finally { p.close(); }
    });

    it('preserves local and remote failures through nested Result methods', async () => {
        const p = pair();
        try {
            p.server.register(streamingApi, { streams: { ...streamHandlers().streams, read: () => { throw new RpcError('broken', 123); } } });
            await expect(p.client.get(streamingApi).streams.read({ fail: false })).rejects.toMatchObject({ code: 123 });
            expect(await p.client.getResultClient(streamingApi).streams.read({ fail: false }))
                .toMatchObject({ error: { kind: 'generic', error: { kind: 'remote', code: 123 } } });
            expect(await p.client.getResultClient(streamingApi).streams.read({ fail: 'wrong' } as any))
                .toMatchObject({ error: { kind: 'generic', error: { kind: 'local' } } });
            p.client.close();
            expect(await p.client.getResultClient(streamingApi).streams.read({ fail: false }))
                .toMatchObject({ error: { kind: 'generic', error: { kind: 'local' } } });
        } finally { p.close(); }
    });

    it('preserves transport failures for both regular and streaming Result methods', async () => {
        const error = new RpcError('disconnected', -32603, undefined, 'transport');
        const connection = new LinkRpcConnection({
            sendRequest: async () => { throw error; },
            sendNotification: async () => {},
            sendRequestWithStream: () => ({
                result: Promise.reject(error), send: () => {}, cancel: () => {}, ping: async () => {},
            }),
            close: () => {},
        });
        const remote = connection.getResultClient(streamingApi).streams;
        for (const value of [await remote.read({ fail: false }), await remote.duplex({ fail: false })]) {
            expect(value).toMatchObject({ error: { kind: 'generic', error: { kind: 'transport' } } });
        }
    });
});
