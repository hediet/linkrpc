import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineInterface, defineInterfaceTemplate, requestType, type Schema } from '@hediet/linkrpc';
import {
    GraphObjects, GraphRoot, graphRefSchema, validateGraphInterfaceSchema,
    IMMUTABLE_GRAPH_INTERFACE_ID, ROOT_WATCH_INTERFACE_ID, GRAPH_INTERFACE_TAG, defineLiveResourceWatchInterface,
} from './index';

describe('graph templates and reflection', () => {
    it('retains generic values, references, parameters and stream types', () => {
        const objects = GraphObjects({ ref: z.number(), value: z.object({ label: z.string() }) });
        const root = GraphRoot({ params: z.object({ filter: z.string() }), ref: z.number() });
        type Params = typeof objects.members.batchObjGet._params;
        type Result = typeof objects.members.batchObjGet._result;
        expectTypeOf<Params['needs'][number]['ref']>().toEqualTypeOf<number>();
        expectTypeOf<Result['objects'][number]['value']>().toEqualTypeOf<{ label: string }>();
        expectTypeOf(root.members.watch._params).toEqualTypeOf<{ filter: string }>();
        expectTypeOf(root.members.watch._clientStream).toEqualTypeOf<{ accept: number }>();
        expectTypeOf(root.members.watch._serverStream).toEqualTypeOf<{ version: number; ref: number }>();
        expectTypeOf(objects.members.batchObjGet.errors).toEqualTypeOf<readonly []>();
    });

    it('supports grouped declarations with mapped members and multiple compatible roots', () => {
        const definition = defineInterface({ id: 'graph.test' }, {
            objects: GraphObjects({ ref: graphRefSchema, value: z.json() })
                .mapMembers({ batchObjGet: 'fetch' }),
            root: GraphRoot({ params: z.object({}), ref: graphRefSchema }),
            filtered: GraphRoot({ params: z.object({ filter: z.string() }), ref: graphRefSchema }),
        });
        const schema = definition.toSchema();
        expect(schema.tags).toEqual([GRAPH_INTERFACE_TAG]);
        expect(Object.keys(schema.methods)).toEqual(['fetch', 'root$watch', 'filtered$watch']);
        expect(schema['x-interface-templates']).toMatchObject({
            templates: {
                [IMMUTABLE_GRAPH_INTERFACE_ID]: { parameters: ['ref', 'value'] },
                [ROOT_WATCH_INTERFACE_ID]: { parameters: ['params', 'ref'] },
            },
            instances: [
                { name: 'objects', members: { batchObjGet: 'fetch' } },
                { name: 'root', members: { watch: 'root$watch' } },
                { name: 'filtered', members: { watch: 'filtered$watch' } },
            ],
        });
        expect(() => validateGraphInterfaceSchema(schema)).not.toThrow();
    });

    it('applies the one-store/same-ref policy without constraining ordinary core interfaces', () => {
        const objects = GraphObjects({ ref: z.string(), value: z.json() });
        const root = GraphRoot({ params: z.object({}), ref: z.string() });
        for (const schema of [
            defineInterface({ id: 'no.store' }, { root }).toSchema(),
            defineInterface({ id: 'two.stores' }, { objects, extra: objects }).toSchema(),
        ]) {
            expect(() => validateGraphInterfaceSchema(schema)).toThrow();
        }
        const mismatch = defineInterface({ id: 'mismatched.graph' }, {
            objects, root: GraphRoot({ params: z.object({}), ref: z.number() }),
        });
        expect(() => validateGraphInterfaceSchema(mismatch.toSchema())).toThrow('compatible objects');
        expect(() => validateGraphInterfaceSchema(defineInterface({ id: 'ordinary' }, {}).toSchema())).not.toThrow();
    });

    it('rejects a structurally valid template reusing the canonical ID with another contract', () => {
        const wrong = defineInterfaceTemplate(
            { id: IMMUTABLE_GRAPH_INTERFACE_ID, parameters: ['ref', 'value'] },
            <R, V>({ ref, value }: { ref: Schema<R>; value: Schema<V> }) => ({
                read: requestType(ref, value),
            }),
        );
        const schema = defineInterface({ id: 'wrong.graph' }, {
            objects: wrong({ ref: z.string(), value: z.json() }),
        }).toSchema();
        expect(() => validateGraphInterfaceSchema(schema)).toThrow('Unsupported graph template');
    });

    it('keeps mutable live events separate from immutable references', () => {
        const live = defineLiveResourceWatchInterface({
            paramsSchema: z.object({ id: z.string() }), eventSchema: z.object({ progress: z.number() }),
        });
        expect(live.toSchema().id).toBe('linkrpc.graph.live.v1');
        expect(live.toSchema()['x-interface-templates']).toBeUndefined();
        expectTypeOf(live.members.watch._serverStream).toEqualTypeOf<{ progress: number }>();
    });
});
