import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineInterface, interfaceFromSchema, type InterfaceClient, type InterfaceHandlers } from '../connection/interfaceDefinition';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { TransportPair } from '../transport/messageTransport';
import { isRpcFailure } from '../connection/rpcFailure';
import { applicationError, requestType, rpcError, type Schema } from './memberTypes';
import { defineInterfaceTemplate } from './defineInterfaceTemplate';
import { generateTsInterface } from './codegen/generateTsInterface';

const Store = defineInterfaceTemplate({ id: 'store.checked', parameters: ['Value'] },
    <V>({ Value }: { Value: Schema<V> }) => {
        const Conflict = applicationError('conflict', { data: z.object({ current: Value }) });
        const Rejected = rpcError(410, z.object({ message: z.literal('rejected'), data: z.object({ value: Value }) }));
        return {
            get: requestType(z.object({}), Value),
            set: requestType(z.object({ value: Value }), z.object({})).withErrors([Conflict]),
            raw: requestType(Value, Value).withErrors([Rejected]),
            watch: requestType(Value, Value).withStream({ client: Value, server: Value }).withErrors([Conflict]),
        };
    });
const numbers = Store({ Value: z.number().min(1) });
const text = Store({ Value: z.string() });
const api = defineInterface({ id: 'settings' }, {
    numbers,
    text: text.mapMembers({ get: 'readText', set: 'writeText', raw: 'rawText', watch: 'watchText' }),
});
const conflict = numbers.members.set.errors[0];
const rejected = numbers.members.raw.errors[0];

describe('callable schema factories with checked errors', () => {
    it('preserves errors whose entire data payload is an unconstrained schema parameter', () => {
        const Scalar = defineInterfaceTemplate({ id: 'scalar', parameters: ['Value'] },
            <V>({ Value }: { Value: Schema<V> }) => ({
                get: requestType(Value, Value).withErrors([applicationError('Missing', { data: Value })]),
            }));
        const bound = Scalar({ Value: z.number() });
        expectTypeOf(bound.members.get.errors[0].create).parameter(0).toEqualTypeOf<number>();
        expect(bound.members.get.errors[0].create(-1).data).toBe(-1);
    });

    it('retains literal descriptors, generic error payloads and client result types', () => {
        expectTypeOf(conflict.type).toEqualTypeOf<'conflict'>();
        expectTypeOf(conflict.create).parameter(0).toEqualTypeOf<{ current: number }>();
        expectTypeOf(text.members.set.errors[0].create).parameter(0).toEqualTypeOf<{ current: string }>();
        expectTypeOf(rejected.code).toEqualTypeOf<410>();
        expectTypeOf(rejected.create).parameter(0).toEqualTypeOf<{
            message: 'rejected'; data: { value: number };
        } & { readonly message: string; readonly data?: unknown }>();
        expect(conflict.is(conflict.create({ current: 3 }))).toBe(true);
        expect(conflict.is(text.members.set.errors[0].create({ current: 'wrong' }))).toBe(false);
        expect(conflict.is(conflict.create({ current: 0 }))).toBe(false);
        expect(rejected.is(rejected.create({ message: 'rejected', data: { value: 3 } }))).toBe(true);
        expect(rejected.is(text.members.raw.errors[0].create({ message: 'rejected', data: { value: 'wrong' } }))).toBe(false);
        type SetResult = Awaited<ReturnType<InterfaceClient<typeof api>['numbers']['set']>>;
        type RawResult = Awaited<ReturnType<InterfaceClient<typeof api>['numbers']['raw']>>;
        const typeChecks = (result: SetResult, raw: RawResult, connection: LinkRpcConnection) => {
            if (isRpcFailure(result)) {
                expectTypeOf(result.error.data).toEqualTypeOf<{ current: number }>();
                expectTypeOf(result.error.type).toEqualTypeOf<'conflict'>();
            }
            if (isRpcFailure(raw)) {
                expectTypeOf(raw.error.code).toEqualTypeOf<410>();
                expectTypeOf(raw.error.data.value).toEqualTypeOf<number>();
            }
            // @ts-expect-error concrete checked errors must not accept string data
            conflict.create({ current: 'wrong' });
            // @ts-expect-error a bound schema is not erased to unknown or any
            connection.get(api).numbers.set({ value: 'wrong' });
            // @ts-expect-error grouped handlers must implement the specialized result
            const bad: InterfaceHandlers<typeof api>['numbers']['get'] = () => 'wrong';
            return bad;
        };
        expect(typeChecks).toBeTypeOf('function');
        const narrow = (value: unknown) => {
            if (!conflict.is(value)) return;
            const error = isRpcFailure(value) ? value.error : value;
            expectTypeOf(error.data.current).toEqualTypeOf<number>();
        };
        narrow(conflict.create({ current: 2 }));
    });

    it('exports parameterized named and raw errors and preserves them through reflection and codegen', () => {
        expect(numbers.template.methods.set.errors).toMatchObject([
            { type: 'conflict', data: { properties: { current: { $parameter: 'Value' } } } },
        ]);
        expect(numbers.template.methods.raw.errors).toMatchObject([
            { code: 410, schema: { properties: { data: { properties: { value: { $parameter: 'Value' } } } } } },
        ]);
        const schema = api.toSchema();
        expect(schema.methods['numbers$set'].errors).toMatchObject([
            { type: 'conflict', data: { properties: { current: { type: 'number' } } } },
        ]);
        expect(interfaceFromSchema(schema).toSchema()).toEqual(schema);
        const serialized = generateTsInterface(schema).match(/JSON\.parse\((.*)\);/)![1]!;
        expect(JSON.parse(JSON.parse(serialized))).toEqual(schema);
    });

    it('transmits successful results and parameterized checked errors over a real connection', async () => {
        const transports = new TransportPair();
        const server = LinkRpcConnection.fromTransport(transports.a);
        const client = LinkRpcConnection.fromTransport(transports.b);
        try {
            server.register(api, {
                numbers: {
                    get: () => 42,
                    set: ({ value }) => value === 1 ? {} : conflict.create({ current: value }),
                    raw: value => value === 1 ? value : rejected.create({ message: 'rejected', data: { value } }),
                    watch: async (value, _context, stream) => {
                        await stream.send(value);
                        return conflict.create({ current: value });
                    },
                },
                text: {
                    get: () => 'text', set: ({ value }) => text.members.set.errors[0].create({ current: value }),
                    raw: value => value, watch: value => value,
                },
            });
            const remote = client.get(api);
            expect(await remote.numbers.get({})).toBe(42);
            expect(await remote.numbers.set({ value: 1 })).toEqual({});
            const failure = await remote.numbers.set({ value: 3 });
            expect(conflict.is(failure)).toBe(true);
            if (isRpcFailure(failure)) expect(failure.error.data.current).toBe(3);
            expect(await remote.numbers.raw(1)).toBe(1);
            expect(rejected.is(await remote.numbers.raw(5))).toBe(true);
            expect(await remote.text.get({})).toBe('text');
            expect(text.members.set.errors[0].is(await remote.text.set({ value: 'data' }))).toBe(true);
            let streamed = 0;
            expect(conflict.is(await remote.numbers.watch(7, { onMessage: value => { streamed = value; } }))).toBe(true);
            expect(streamed).toBe(7);
        } finally { server.close(); client.close(); }
    });

    it('guards schema argument objects and metadata names without sacrificing generic inference', () => {
        const compileChecks = () => {
            // @ts-expect-error factory inputs must be schemas
            defineInterfaceTemplate({ id: 'bad', parameters: ['Value'] }, ({ Value }: { Value: number }) => ({ get: requestType(z.number()) }));
            // @ts-expect-error parameter names must match the schema argument object
            defineInterfaceTemplate({ id: 'bad', parameters: ['Other'] }, <V>({ Value }: { Value: Schema<V> }) => ({ get: requestType(Value) }));
        };
        expect(compileChecks).toBeTypeOf('function');
        // @ts-expect-error runtime checks JS callers too
        expect(() => Store({ Value: 1 })).toThrow(/Zod schema/);
        // @ts-expect-error schema argument objects are mandatory
        expect(() => Store(null)).toThrow(/schema argument object/);
        const extra = { Value: z.number(), Other: z.string() };
        expect(() => Store(extra)).toThrow(/unknown parameter/);
    });

    it('reflects recursive generic factory schemas and recursive checked error arguments', () => {
        type Tree<V> = { value: V; children: Tree<V>[] };
        const Trees = defineInterfaceTemplate({ id: 'trees', parameters: ['Value'] },
            <V>({ Value }: { Value: Schema<V> }) => {
                const tree: z.ZodType<Tree<V>> = z.lazy(() => z.object({
                    value: Value, children: z.array(tree),
                }));
                return { get: requestType(z.object({}), tree).withErrors([applicationError('tree', { data: tree })]) };
            });
        const trees = Trees({ Value: z.number() });
        expectTypeOf(trees.members.get._result).toEqualTypeOf<Tree<number>>();
        expect(trees.members.get.errors[0].is(trees.members.get.errors[0].create({
            value: 1, children: [{ value: 2, children: [] }],
        }))).toBe(true);
        expect(Object.keys(trees.template.components?.schemas ?? {}).length).toBeGreaterThan(0);
        const schema = defineInterface({ id: 'trees.api' }, { trees }).toSchema();
        expect(interfaceFromSchema(schema).toSchema()).toEqual(schema);
        const tree: z.ZodType<Tree<number>> = z.lazy(() => z.object({ value: z.number(), children: z.array(tree) }));
        const recursiveStore = Store({ Value: tree });
        const error = recursiveStore.members.set.errors[0];
        expect(error.is(error.create({ current: { value: 1, children: [] } }))).toBe(true);
        expect(interfaceFromSchema(defineInterface({ id: 'trees.store' }, { recursiveStore }).toSchema()).toSchema()
            ['x-interface-templates']).toBeDefined();
    });

    it('rejects specialization that changes reflected method or checked error structure', () => {
        const Bad = defineInterfaceTemplate({ id: 'bad.specialization', parameters: ['Value'] },
            <V>({ Value }: { Value: Schema<V> }) => {
                const result: Schema<number | string> = Value._zod.def.type === 'never' ? z.number() : z.string();
                return { get: requestType(Value, result) };
            });
        expect(() => Bad({ Value: z.number() })).toThrow(/does not match/);
        const BadErrors = defineInterfaceTemplate({ id: 'bad.errors', parameters: ['Value'] },
            <V>({ Value }: { Value: Schema<V> }) => {
                const data: Schema<number | string> = Value._zod.def.type === 'never' ? z.number() : z.string();
                return { get: requestType(Value, Value).withErrors([applicationError('conflict', { data })]) };
            });
        expect(() => BadErrors({ Value: z.number() })).toThrow(/does not match/);
    });

    it('snapshots metadata and mapping without freezing or cloning concrete schema validators', () => {
        const info = { id: 'snapshotted', parameters: ['Value'] as 'Value'[] };
        const docs = { annotations: { readOnly: true } };
        const Factory = defineInterfaceTemplate(info, <V>({ Value }: { Value: Schema<V> }) => ({
            get: requestType(Value, Value, docs),
        }));
        info.id = 'changed';
        info.parameters.push('Value');
        const value = z.number();
        const bound = Factory({ Value: value });
        expect(bound.template.id).toBe('snapshotted');
        expect(bound.template.parameters).toEqual(['Value']);
        expect(bound.members.get.resultSchema).toBe(value);
        expect(Object.isFrozen(value)).toBe(false);
        const mapping = { get: 'read' };
        const mapped = bound.mapMembers(mapping);
        mapping.get = 'changed';
        expect(mapped.mapping.get).toBe('read');
        expect(Object.isFrozen(bound.template)).toBe(true);
        expect(Object.isFrozen(bound.arguments.Value.schema)).toBe(true);
        expect(Object.isFrozen(docs.annotations)).toBe(false);
        docs.annotations.readOnly = false;
        expect(bound.template.methods.get.annotations?.readOnly).toBe(true);
        expect(() => Factory({ Value: value })).toThrow(/does not match/);
    });
});
