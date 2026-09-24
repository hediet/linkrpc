import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineInterface, interfaceFromSchema, type InterfaceClient, type InterfaceHandlers } from '../connection/interfaceDefinition';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { TransportPair } from '../transport/messageTransport';
import { bareInterfaceTarget } from '../connection/bareInterfaceTarget';
import { defineInterfaceTemplate } from './defineInterfaceTemplate';
import { applicationError, notificationType, requestType, type Schema } from './memberTypes';
import { generateTsInterface } from './codegen/generateTsInterface';

const Store = defineInterfaceTemplate({ id: 'test.store', parameters: ['value'] }, <V>({ value }: { value: Schema<V> }) => ({
    get: requestType(value, value),
    watch: requestType(value, value).withStream({ client: value, server: value }),
    changed: notificationType(value),
}));
const numbers = Store({ value: z.number() });
const missing = applicationError('Missing');
const api = defineInterface({ id: 'test.groups' }, {
    numbers,
    text: Store({ value: z.string() }).mapMembers({ get: 'readText', watch: 'observeText', changed: 'textChanged' }),
    ping: requestType(z.object({}), z.string()).withErrors([missing]),
});

function pair() {
    const transports = new TransportPair();
    const client = LinkRpcConnection.fromTransport(transports.a);
    const server = LinkRpcConnection.fromTransport(transports.b);
    return { client, server, dispose() { client.close(); server.close(); } };
}

function handlers(): InterfaceHandlers<typeof api> {
    return {
        numbers: {
            get: value => value + 1,
            watch: async (value, _ctx, stream) => {
                expectTypeOf(value).toEqualTypeOf<number>();
                expectTypeOf(stream.send).parameter(0).toEqualTypeOf<number>();
                return new Promise<number>(resolve => {
                    stream.onMessage(next => { resolve(next); });
                    void stream.send(value);
                });
            },
            changed: value => { expectTypeOf(value).toEqualTypeOf<number>(); },
        },
        text: {
            get: value => value.toUpperCase(),
            watch: value => value,
            changed: () => {},
        },
        ping: () => 'pong',
    };
}

describe('direct interface groups', () => {
    it('flattens wire members, preserves exact client types and reflects two instances', () => {
        expect(Object.keys(api.members)).toEqual([
            'numbers$get', 'numbers$watch', 'numbers$changed', 'readText', 'observeText', 'textChanged', 'ping',
        ]);
        expectTypeOf<InterfaceClient<typeof api>['numbers']['get']>().parameter(0).toEqualTypeOf<number>();
        expectTypeOf<InterfaceClient<typeof api>['text']['get']>().returns.toEqualTypeOf<Promise<string>>();
        expect(api.ref.readText.member).toBe('readText');
        expect(api.toSchema()['x-interface-templates']).toMatchObject({
            instances: [
                { name: 'numbers', template: 'test.store', members: { get: 'numbers$get', watch: 'numbers$watch', changed: 'numbers$changed' } },
                { name: 'text', template: 'test.store', members: { get: 'readText', watch: 'observeText', changed: 'textChanged' } },
            ],
        });
        expect(api.members['numbers$get']).toBe(numbers.members.get);
        expect(defineInterface(api.info, api.members).schemaHash).toBe(api.schemaHash);
    });

    it('requires complete grouped handlers at compile time including on variables', () => {
        const valid = handlers();
        // @ts-expect-error a grouped member cannot be implemented as a flat alias
        const flat: InterfaceHandlers<typeof api> = { ...valid, 'numbers$get': (value: number) => value };
        // @ts-expect-error missing required group
        const noGroup: InterfaceHandlers<typeof api> = { text: valid.text, ping: valid.ping };
        // @ts-expect-error missing required member
        const noMember: InterfaceHandlers<typeof api> = { ...valid, numbers: { get: valid.numbers.get } };
        const aliases = { ...valid, readText: (value: string) => value };
        // @ts-expect-error mapped concrete aliases are forbidden even through variables
        const conflicting: InterfaceHandlers<typeof api> = aliases;
        expect([flat, noGroup, noMember, conflicting]).toHaveLength(4);
        const checkRegistration = (connection: LinkRpcConnection) => {
            // @ts-expect-error registration cannot infer away a forbidden flat alias
            connection.register(api, aliases);
            // @ts-expect-error a complete flat implementation is not a grouped implementation
            connection.register(api, { 'numbers$get': () => 1, readText: () => '', ping: () => '' });
            // @ts-expect-error grouped payload inference is not any
            connection.register(api, { ...valid, numbers: { ...valid.numbers, get: (value: string) => value } });
        };
        expect(checkRegistration).toBeTypeOf('function');
    });

    it('registers grouped methods, notifications, bidirectional streams and ordinary errors', async () => {
        const p = pair();
        try {
            let notified = 0;
            const implementation: InterfaceHandlers<typeof api> = {
                ...handlers(),
                numbers: { ...handlers().numbers, changed: value => { notified = value; } },
                ping: () => missing.create(),
            };
            p.server.register(api, implementation);
            const remote = p.client.get(api);
            expect(await remote.numbers.get(41)).toBe(42);
            expect(await remote.text.get('hi')).toBe('HI');
            remote.numbers.changed(12);
            let streamed = 0;
            let ready!: () => void;
            const started = new Promise<void>(resolve => { ready = resolve; });
            const call = remote.numbers.watch(3, { onMessage: value => { streamed = value; ready(); } });
            await started;
            await call.send(7);
            expect(await call).toBe(7);
            expect(streamed).toBe(3);
            expect(notified).toBe(12);
            expect(missing.is(await remote.ping({}))).toBe(true);
        } finally { p.dispose(); }
    });

    it.each([
        ['missing group', (h: any) => { delete h.numbers; }, /Missing handler group/],
        ['missing member', (h: any) => { delete h.numbers.get; }, /Missing or invalid handler/],
        ['nonfunction member', (h: any) => { h.numbers.get = 1; }, /Missing or invalid handler/],
        ['invalid group', (h: any) => { h.numbers = () => {}; }, /Expected handler group/],
        ['flat alias', (h: any) => { h['numbers$get'] = () => 1; }, /Unexpected handler/],
        ['mapped alias', (h: any) => { h.readText = () => ''; }, /Unexpected handler/],
        ['extra member', (h: any) => { h.numbers.extra = () => {}; }, /Unexpected handler/],
        ['extra group', (h: any) => { h.extra = {}; }, /Unexpected handler/],
        ['missing ordinary member', (h: any) => { delete h.ping; }, /Missing or invalid handler/],
        ['inherited member', (h: any) => { h.numbers = Object.create(h.numbers); }, /Missing or invalid handler/],
        ['inherited group', (h: any) => Object.setPrototypeOf(h, { numbers: h.numbers }) && delete h.numbers, /Missing handler group/],
    ])('rejects %s atomically', (_name, mutate, error) => {
        const p = pair();
        try {
            const bad = handlers();
            mutate(bad);
            expect(() => p.server.register(api, bad)).toThrow(error);
            expect(() => p.server.register(api, handlers())).not.toThrow();
        } finally { p.dispose(); }
    });

    it('rejects flat-only implementations and enforces grouping through service/bare targets', () => {
        const p = pair();
        try {
            const flat = Object.fromEntries(Object.keys(api.members).map(name => [name, () => {}]));
            expect(() => p.server.register(api, flat as any)).toThrow(/Unexpected handler/);
            expect(() => p.server.service('svc').register(api, flat as any)).toThrow(/Unexpected handler/);
            expect(() => p.server.register(bareInterfaceTarget(api), flat as any)).toThrow(/Unexpected handler/);
        } finally { p.dispose(); }
    });

    it('rejects concrete collisions, group/flat collisions and metadata name conflicts', () => {
        expect(() => defineInterface({ id: 'bad' }, { numbers, 'numbers$get': numbers.members.get })).toThrow(/collision/);
        expect(() => defineInterface({ id: 'bad' }, {
            numbers, other: numbers.mapMembers({ get: 'numbers$get', watch: 'w', changed: 'c' }),
        })).toThrow(/collision/);
        expect(() => defineInterface({ id: 'bad' }, {
            numbers: numbers.mapMembers({ get: 'numbers', watch: 'w', changed: 'c' }),
        })).toThrow(/collision/);
        expect(() => defineInterface({ id: 'bad' }, {
            numbers: numbers.mapMembers({ get: 'ping', watch: 'w', changed: 'c' }), ping: numbers.members.get,
        })).toThrow(/collision/);
        expect(() => defineInterface({ id: 'bad' }, {
            numbers: numbers.mapMembers({ get: 'numbers', watch: 'w', changed: 'c' }),
        })).toThrow(/collision/);
        expect(() => defineInterface({ id: 'bad' }, { numbers }, {
            templates: { numbers: numbers.mapMembers({ get: 'numbers$get', watch: 'numbers$watch', changed: 'numbers$changed' }) },
        })).toThrow(/collision/);
    });

    it('revalidates concrete mapping completeness instead of silently falling back', () => {
        const original = numbers.mapMembers({ get: 'get', watch: 'watch', changed: 'changed' });
        const mapping: Record<string, string> = { ...original.mapping };
        const mapped = { ...original, mapping: mapping as typeof original.mapping };
        mapping.extra = 'ignored';
        expect(() => defineInterface({ id: 'bad' }, { numbers: mapped })).toThrow(/Unknown mapped member/);
        delete mapping.extra;
        delete mapping.get;
        expect(() => defineInterface({ id: 'bad' }, { numbers: mapped })).toThrow(/Missing mapped member/);
        Object.setPrototypeOf(mapping, { get: 'get' });
        expect(() => defineInterface({ id: 'bad' }, { numbers: mapped })).toThrow(/Missing mapped member/);
    });

    it('treats prototype-like group, template and concrete names as own data', async () => {
        const Echo = defineInterfaceTemplate({ id: 'constructor', parameters: [] }, () => ({
            get: requestType(z.number(), z.number()),
        }));
        const special = defineInterface({ id: 'special' }, {
            data: Echo({}).mapMembers({ get: '__proto__' }),
        });
        expect(Object.keys(special.members)).toEqual(['__proto__']);
        expect(Object.keys(special.toSchema().methods)).toEqual(['__proto__']);
        expect(special.toSchema()['x-interface-templates']).toMatchObject({
            instances: [{ name: 'data', members: { get: '__proto__' } }],
        });
        const named = defineInterface({ id: 'named' }, { ['__proto__']: Echo({}) });
        expect(named.toSchema()['x-interface-templates']).toMatchObject({ instances: [{ name: '__proto__' }] });
        const p = pair();
        try {
            p.server.register(special, { data: { get: value => value + 1 } });
            expect(await p.client.get(special).data.get(1)).toBe(2);
            const reflected = interfaceFromSchema(special.toSchema());
            expect(Object.keys(reflected.members)).toEqual(['__proto__']);
            expect(await p.client.get(reflected)['__proto__'](2)).toBe(3);
        } finally { p.dispose(); }
    });

    it('round trips and generates flat implementations without inferring local handler groups', async () => {
        const schema = api.toSchema();
        const reflected = interfaceFromSchema(schema);
        expect(reflected.toSchema()).toEqual(schema);
        expect(reflected.schemaHash).toBe(api.schemaHash);
        const generated = generateTsInterface(schema);
        const serialized = generated.match(/JSON\.parse\((.*)\);/)![1]!;
        expect(JSON.parse(JSON.parse(serialized))).toEqual(schema);
        const p = pair();
        try {
            p.server.register(reflected, api.flattenHandlers(handlers()) as any);
            expect(await p.client.get(api).text.get('roundtrip')).toBe('ROUNDTRIP');
        } finally { p.dispose(); }
    });

    it('retains flat handlers for ordinary members and explicit metadata-only instances', async () => {
        const flat = defineInterface({ id: 'flat' }, numbers.members, {
            templates: { numbers: numbers.mapMembers({ get: 'get', watch: 'watch', changed: 'changed' }) },
        });
        const p = pair();
        try {
            p.server.register(flat, handlers().numbers);
            expect(await p.client.get(flat).get(1)).toBe(2);
        } finally { p.dispose(); }
    });

    it('retains context inference and supports checked template errors', () => {
        const impl: InterfaceHandlers<typeof api, { user: string }>['numbers'] = {
                watch: value => value,
                changed: () => {},
                get: (value, context) => {
                    expectTypeOf(context).toEqualTypeOf<{ user: string }>();
                    return value;
                },
        };
        expect(impl).toBeDefined();
        expect(() => defineInterfaceTemplate({ id: 'errors', parameters: [] }, () => ({
            get: requestType(z.string(), z.string()).withErrors([missing]),
        }))({})).not.toThrow();
    });
});
