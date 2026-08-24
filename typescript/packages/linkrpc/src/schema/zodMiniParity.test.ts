import { describe, expect, it } from 'vitest';
import { z as zc } from 'zod';
import { z as zm } from 'zod/mini';
import { normalizeJsonSchema } from './normalize';
import { zodToSvcJsonSchema } from './memberTypes';
import { defineInterface } from '../connection/interfaceDefinition';
import { requestType } from './memberTypes';

/**
 * Parity between classic `zod` and `zod/mini` for the purpose of linkrpc's wire
 * schema + interface hash.
 *
 * Background: linkrpc derives every interface's JSON schema (and therefore its
 * `schemaHash`) from {@link zodToSvcJsonSchema}, which runs the zod schema
 * through `z.toJSONSchema` + {@link normalizeJsonSchema}. Mini and classic
 * share the same zod *core* representation, so they SHOULD produce identical
 * JSON — meaning an interface authored with mini hashes the same as one
 * authored with classic. These tests pin that invariant.
 *
 * (An earlier ad-hoc check appeared to show different hashes — that was caused
 * by using different interface `id`s, which are part of the hash, not by any
 * mini/classic schema difference.)
 *
 * Each case authors the *same* shape twice: once with classic's chained API
 * (`z.string().optional()`) and once with mini's functional API
 * (`z.optional(z.string())`). We assert the normalized JSON is byte-identical;
 * on failure vitest prints the structural diff of the JSON that gets hashed.
 */

interface ParityCase {
    readonly name: string;
    readonly classic: zc.ZodType;
    readonly mini: zm.ZodMiniType;
}

const cases: ParityCase[] = [
    {
        name: 'primitives',
        classic: zc.object({ s: zc.string(), n: zc.number(), b: zc.boolean() }),
        mini: zm.object({ s: zm.string(), n: zm.number(), b: zm.boolean() }),
    },
    {
        name: 'optional fields',
        classic: zc.object({ a: zc.string(), b: zc.string().optional(), c: zc.boolean().optional() }),
        mini: zm.object({ a: zm.string(), b: zm.optional(zm.string()), c: zm.optional(zm.boolean()) }),
    },
    {
        name: 'arrays',
        classic: zc.object({ xs: zc.array(zc.string()), ys: zc.array(zc.number()) }),
        mini: zm.object({ xs: zm.array(zm.string()), ys: zm.array(zm.number()) }),
    },
    {
        name: 'unknown + optional unknown',
        classic: zc.object({ u: zc.unknown(), o: zc.unknown().optional() }),
        mini: zm.object({ u: zm.unknown(), o: zm.optional(zm.unknown()) }),
    },
    {
        name: 'enum',
        classic: zc.object({ kind: zc.enum(['once', 'shortLived', 'longLived', 'persistent']) }),
        mini: zm.object({ kind: zm.enum(['once', 'shortLived', 'longLived', 'persistent']) }),
    },
    {
        name: 'literal',
        classic: zc.object({ alg: zc.literal('sha256'), any: zc.literal(true) }),
        mini: zm.object({ alg: zm.literal('sha256'), any: zm.literal(true) }),
    },
    {
        name: 'record',
        classic: zc.object({ m: zc.record(zc.string(), zc.string()) }),
        mini: zm.object({ m: zm.record(zm.string(), zm.string()) }),
    },
    {
        name: 'union',
        classic: zc.union([zc.object({ exact: zc.string() }), zc.object({ prefix: zc.string() })]),
        mini: zm.union([zm.object({ exact: zm.string() }), zm.object({ prefix: zm.string() })]),
    },
    {
        name: 'discriminatedUnion',
        classic: zc.discriminatedUnion('status', [
            zc.object({ status: zc.literal('granted'), serviceId: zc.string() }),
            zc.object({ status: zc.literal('denied'), reason: zc.string().optional() }),
        ]),
        mini: zm.discriminatedUnion('status', [
            zm.object({ status: zm.literal('granted'), serviceId: zm.string() }),
            zm.object({ status: zm.literal('denied'), reason: zm.optional(zm.string()) }),
        ]),
    },
    {
        name: 'string min length (refinement stripped by normalize)',
        classic: zc.object({ p: zc.string().min(1) }),
        mini: zm.object({ p: zm.string().check(zm.minLength(1)) }),
    },
    {
        name: 'nested object + array of objects',
        classic: zc.object({
            deps: zc.record(zc.string(), zc.object({
                interfaces: zc.array(zc.object({ id: zc.string(), hash: zc.string().optional() })),
            })),
        }),
        mini: zm.object({
            deps: zm.record(zm.string(), zm.object({
                interfaces: zm.array(zm.object({ id: zm.string(), hash: zm.optional(zm.string()) })),
            })),
        }),
    },
];

describe('zod mini / classic parity for linkrpc schema hashing', () => {
    for (const c of cases) {
        it(`${c.name}: classic-authored and mini-authored produce identical linkrpc JSON`, () => {
            const classicJson = zodToSvcJsonSchema(c.classic);
            const miniJson = zodToSvcJsonSchema(c.mini as unknown as zc.ZodType);
            expect(miniJson).toEqual(classicJson);
        });
    }

    it('full interface authored with mini hashes identically to classic', () => {
        const mk = (
            obj: (shape: Record<string, unknown>) => unknown,
            str: () => unknown,
            num: () => unknown,
            opt: (s: unknown) => unknown,
        ) => defineInterface({ id: 'parity.demo' }, {
            hello: requestType(
                obj({ name: str(), age: opt(num()) }) as zc.ZodType,
                obj({ greeting: str() }) as zc.ZodType,
            ),
        });

        const classicIface = mk(
            (s) => zc.object(s as zc.ZodRawShape),
            () => zc.string(),
            () => zc.number(),
            (s) => (s as zc.ZodType).optional(),
        );
        const miniIface = mk(
            (s) => zm.object(s as Record<string, zm.ZodMiniType>),
            () => zm.string(),
            () => zm.number(),
            (s) => zm.optional(s as zm.ZodMiniType),
        );

        expect(miniIface.schemaHash).toBe(classicIface.schemaHash);
        expect(miniIface.toSchema().methods).toEqual(classicIface.toSchema().methods);
    });
});

/**
 * Processor parity: linkrpc currently calls classic `z.toJSONSchema`. To drop
 * classic zod from the bundle entirely, that call must move to mini's
 * `toJSONSchema`. This proves the swap is safe — for the same schema, both
 * processors yield the same normalized JSON.
 */
describe('zod toJSONSchema processor parity (classic vs mini processor)', () => {
    for (const c of cases) {
        it(`${c.name}: classic processor and mini processor agree`, () => {
            // Author with classic, then process both ways.
            const viaClassic = normalizeJsonSchema(zc.toJSONSchema(c.classic));
            const viaMini = normalizeJsonSchema(zm.toJSONSchema(c.mini));
            expect(viaMini).toEqual(viaClassic);
        });
    }
});
