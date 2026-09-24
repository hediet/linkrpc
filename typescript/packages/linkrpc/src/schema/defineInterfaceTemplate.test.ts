import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import * as mini from 'zod/mini';
import { defineInterface, interfaceFromSchema, InterfaceDefinition, type InterfaceHandlers } from '../connection/interfaceDefinition';
import { requestType, notificationType, type Schema } from './memberTypes';
import { defineInterfaceTemplate } from './defineInterfaceTemplate';
import { validateInterfaceTemplates } from './interfaceTemplates';
import { generateTsInterface } from './codegen/generateTsInterface';

const Store = defineInterfaceTemplate({ id: 'generic.store', parameters: ['Value'] }, <V>({ Value }: { Value: Schema<V> }) => ({
    get: requestType(z.object({}), z.object({ items: z.array(Value), last: z.optional(Value) })),
    set: requestType(Value, z.object({})).withStream({ client: Value, server: z.object({ value: Value }) }),
}));

describe('Zod generic interface authoring', () => {
    it('reflects once, calls the generic factory per binding, and retains exact validators and types', () => {
        let authored = 0;
        const Echo = defineInterfaceTemplate({ id: 'echo', parameters: ['Value'] }, <V>({ Value }: { Value: Schema<V> }) => {
            authored++;
            return { echo: requestType(mini.object({ value: Value }), Value) };
        });
        const number = z.number().min(10);
        const numeric = Echo({ Value: number });
        const text = Echo({ Value: z.string() });
        expect(authored).toBe(3);
        expect(numeric.template.methods.echo.params).toMatchObject({ properties: { value: { $parameter: 'Value' } } });
        expect(numeric.members.echo.resultSchema).toBe(number);
        expect(z.safeParse(numeric.members.echo.paramsSchema, { value: 3 }).success).toBe(false);
        expect(z.safeParse(numeric.members.echo.paramsSchema, { value: 12 }).success).toBe(true);
        expectTypeOf(numeric.members.echo._params).toEqualTypeOf<{ value: number }>();
        expectTypeOf(numeric.members.echo._result).toEqualTypeOf<number>();
        expectTypeOf(text.members.echo._result).toEqualTypeOf<string>();
        const bound = Store({ Value: z.number() });
        expectTypeOf(bound.members.get._result).toEqualTypeOf<{ items: number[]; last?: number }>();
        expectTypeOf(bound.members.set._clientStream).toEqualTypeOf<number>();
        expectTypeOf(bound.members.set._serverStream).toEqualTypeOf<{ value: number }>();
    });

    it('maps independently authored members, leaves ordinary methods alone, and round trips', () => {
        const store = Store({ Value: z.number() });
        const existing = defineInterface({ id: 'concrete' }, {
            fetch: requestType(z.object({}), z.object({ items: z.array(z.number()), last: z.optional(z.number()) })),
            write: store.members.set,
            ping: notificationType(z.object({})),
        });
        const mapped = defineInterface(existing.info, existing.members, { templates: {
            numbers: store.mapMembers({ get: 'fetch', set: 'write' }),
        } });
        expect(mapped.members).toBe(existing.members);
        expect(mapped.schemaHash).toBe(existing.schemaHash);
        expect(mapped.ref.fetch.interfaceHash).toBe(mapped.schemaHash);
        expect(defineInterface({ ...existing.info, hash: mapped.schemaHash }, existing.members, {
            templates: { numbers: store.mapMembers({ get: 'fetch', set: 'write' }) },
        }).schemaHash).toBe(mapped.schemaHash);
        const schema = mapped.toSchema();
        expect(interfaceFromSchema(schema).toSchema()).toEqual(schema);
        const serialized = generateTsInterface(schema).match(/JSON\.parse\((.*)\);/)![1]!;
        expect(JSON.parse(JSON.parse(serialized))).toEqual(schema);
        expect(schema['x-interface-templates']).toMatchObject({ instances: [{ members: { get: 'fetch', set: 'write' } }] });
    });

    it('supports identity maps and rejects collisions, missing/extra keys and mismatch', () => {
        const store = Store({ Value: z.number() });
        const existing = defineInterface({ id: 'identity' }, store.members);
        expect(() => defineInterface(existing.info, existing.members, { templates: { store: store.mapMembers({ get: 'get', set: 'set' }) } })).not.toThrow();
        expect(() => store.mapMembers({ get: 'get', set: 'get' })).toThrow(/collision/);
        // @ts-expect-error missing template member
        expect(() => store.mapMembers({ get: 'get' })).toThrow(/Missing/);
        // @ts-expect-error extra template member
        expect(() => store.mapMembers({ get: 'get', set: 'set', other: 'get' })).toThrow(/Unknown/);
        expect(() => defineInterface(existing.info, existing.members, { templates: { store: store.mapMembers({ get: 'missing', set: 'set' }) } })).toThrow(/missing/);
        const wrong = defineInterface({ id: 'wrong' }, { ...existing.members, get: requestType(z.object({}), z.string()) });
        expect(() => defineInterface(wrong.info, wrong.members, { templates: { store: store.mapMembers({ get: 'get', set: 'set' }) } })).toThrow(/does not match/);
        const schema = defineInterface(existing.info, existing.members, { templates: { store: store.mapMembers({ get: 'get', set: 'set' }) } }).toSchema();
        const bad = structuredClone(schema);
        (bad['x-interface-templates'] as { instances: { prefix?: string }[] }).instances[0]!.prefix = 'other$';
        expect(() => validateInterfaceTemplates(bad)).toThrow(/explicit member mappings/);
    });

    it('checks arguments and restricts unsupported template behavior explicitly', () => {
        // @ts-expect-error missing schema argument
        expect(() => Store({})).toThrow(/missing parameter/);
        // @ts-expect-error extra schema argument
        expect(() => Store({ Value: z.number(), Extra: z.string() })).toThrow(/unknown parameter/);
        expect(() => Store({ Value: z.optional(z.number()) })).toThrow(/must not be optional/);
        expect(() => defineInterfaceTemplate({ id: 'bad', parameters: ['Value'] }, <V>({ Value }: { Value: Schema<V> }) => ({
            get: requestType(Value, z.string().transform(x => x.length)),
        }))).toThrow(/cannot be represented/);
        expect(() => defineInterfaceTemplate({ id: 'bad', parameters: [] }, () => ({
            get: requestType(z.string().min(3), z.number()),
        }))).not.toThrow();
        expect(() => defineInterfaceTemplate({ id: 'bad', parameters: ['Value'] }, <V>({ Value }: { Value: Schema<V> }) => ({
            get: requestType(z.object({}), z.intersection(Value, z.object({ tag: z.string() }))),
        }))).toThrow(/Unsupported template JSON Schema keyword "allOf"/);
        const recursive = z.object({ get children(): z.ZodArray<typeof recursive> { return z.array(recursive); } });
        expect(() => defineInterfaceTemplate({ id: 'bad', parameters: [] }, () => ({
            get: requestType(z.object({}), recursive),
        }))({})).not.toThrow();
    });

    it('keeps implementation handlers independent and validates constructor options without recursion', () => {
        const store = Store({ Value: z.number() });
        const options = { templates: { numbers: store.mapMembers({ get: 'fetch', set: 'write' }) } };
        const api = defineInterface({ id: 'implementation' }, {
            fetch: store.members.get, write: store.members.set,
        }, options);
        const handlers: InterfaceHandlers<typeof api> = {
            fetch: () => ({ items: [1], last: 1 }),
            write: async (params, _context, stream) => {
                expectTypeOf(params).toEqualTypeOf<number>();
                stream.onMessage(value => { expectTypeOf(value).toEqualTypeOf<number>(); });
                await stream.send({ value: params });
                return {};
            },
        };
        expect(handlers.fetch({}, undefined, {} as never)).toEqual({ items: [1], last: 1 });
        expect(() => defineInterface({ id: api.info.id, hash: 'wrong' }, api.members, options)).toThrow(/hash mismatch/);
        expect(() => new InterfaceDefinition(api.info, api.members, {
            ...options, frozenSchema: api.toSchema(),
        })).toThrow(/Cannot combine/);
        const conflicting = defineInterfaceTemplate({ id: store.template.id, parameters: ['Value'] }, <V>({ Value }: { Value: Schema<V> }) => ({
            get: requestType(z.object({}), Value),
        }))({ Value: z.number() });
        expect(() => defineInterface(api.info, { ...api.members, other: conflicting.members.get }, {
            templates: { ...options.templates, other: conflicting.mapMembers({ get: 'other' }) },
        })).toThrow(/Conflicting definitions/);
    });

    it('retains recursive concrete arguments rather than reconstructing JSON validators', () => {
        type Node = { children: Node[] };
        const node: z.ZodType<Node> = z.lazy(() => z.object({ children: z.array(node) }));
        const store = Store({ Value: node });
        expect(store.members.set.paramsSchema).toBe(node);
        const definition = defineInterface({ id: 'recursive' }, store.members, { templates: {
            tree: store.mapMembers({ get: 'get', set: 'set' }),
        } });
        expect(() => validateInterfaceTemplates(definition.toSchema())).not.toThrow();
        expectTypeOf(store.members.set._params).toEqualTypeOf<Node>();
    });

    it('specializes tuples, unions, nullable schemas and notifications', () => {
        const Events = defineInterfaceTemplate({ id: 'events', parameters: ['Value'] }, <V>({ Value }: { Value: Schema<V> }) => ({
            event: notificationType(z.object({
                pair: z.tuple([Value, z.optional(Value)]),
                choice: z.union([Value, z.literal('none')]),
                nullable: z.nullable(Value),
            })),
        }));
        const bound = Events({ Value: z.number() });
        expectTypeOf(bound.members.event._params).toEqualTypeOf<{
            pair: [number, number?]; choice: number | 'none'; nullable: number | null;
        }>();
        expect(z.safeParse(bound.members.event.paramsSchema, { pair: [1], choice: 'none', nullable: null }).success).toBe(true);
        expect(z.safeParse(bound.members.event.paramsSchema, { pair: ['bad'], choice: 'none', nullable: null }).success).toBe(false);
        expect(() => defineInterface({ id: 'events.bound' }, bound.members, { templates: {
            events: bound.mapMembers({ event: 'event' }),
        } })).not.toThrow();
    });

    it('rejects malformed imported mappings and colliding instances before code generation', () => {
        const store = Store({ Value: z.number() });
        const schema = defineInterface({ id: 'mapped' }, store.members, { templates: {
            store: store.mapMembers({ get: 'get', set: 'set' }),
        } }).toSchema();
        const mappings: Record<string, string>[] = [
            { get: 'get' }, { get: 'get', set: 'set', extra: 'get' }, { get: 'get', set: 'get' },
        ];
        for (const mapping of mappings) {
            const bad = structuredClone(schema);
            const metadata = bad['x-interface-templates'] as { instances: { members: Record<string, string> }[] };
            metadata.instances[0]!.members = mapping;
            expect(() => interfaceFromSchema(bad)).toThrow();
            expect(() => generateTsInterface(bad)).toThrow();
        }
        expect(() => defineInterface({ id: 'mapped' }, store.members, { templates: {
            first: store.mapMembers({ get: 'get', set: 'set' }),
            second: store.mapMembers({ get: 'get', set: 'set' }),
        } })).toThrow(/collision/);
    });
});
