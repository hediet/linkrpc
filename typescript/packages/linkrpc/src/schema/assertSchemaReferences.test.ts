import { describe, expect, it } from 'vitest';
import type { LinkRpcJsonSchema } from './linkRpcJsonSchema';
import {
    assertSchemaReferences,
    componentSchemaName,
    componentSchemaRef,
} from './assertSchemaReferences';

describe('guarded schema reference graphs', () => {
    it('accepts guarded self-recursion even without a finite base case', () => {
        const node: LinkRpcJsonSchema = {
            type: 'object',
            properties: { next: { $ref: '#/components/schemas/Node' } },
            required: ['next'],
            additionalProperties: false,
        };
        expect(() => assertSchemaReferences([node], { Node: node })).not.toThrow();
    });

    it('accepts mutually recursive arrays and object values', () => {
        const components: Record<string, LinkRpcJsonSchema> = {
            Array: { type: 'array', items: { $ref: '#/components/schemas/Map' } },
            Map: {
                type: 'object',
                properties: {},
                additionalProperties: { $ref: '#/components/schemas/Array' },
            },
        };
        expect(() => assertSchemaReferences([], components)).not.toThrow();
    });

    it('rejects unguarded recursion through unions even with a base branch', () => {
        const components: Record<string, LinkRpcJsonSchema> = {
            A: { anyOf: [{ type: 'null' }, { $ref: '#/components/schemas/B' }] },
            B: { oneOf: [{ $ref: '#/components/schemas/A' }] },
        };
        expect(() => assertSchemaReferences([], components)).toThrow('Unguarded');
    });

    it('rejects unguarded cycles nested below a guarded edge', () => {
        const components: Record<string, LinkRpcJsonSchema> = {
            Root: {
                type: 'array',
                items: { $ref: '#/components/schemas/Loop' },
            },
            Loop: { $ref: '#/components/schemas/Loop' },
        };
        expect(() => assertSchemaReferences([], components)).toThrow('Unguarded');
    });

    it('rejects dangling references but resolves boolean false', () => {
        const root = { $ref: '#/components/schemas/None' };
        expect(() => assertSchemaReferences([root])).toThrow('Unresolved');
        expect(() => assertSchemaReferences([root], { None: false })).not.toThrow();
    });

    it('leaves literals and non-normative metadata opaque', () => {
        const literal = { $ref: '#/components/schemas/DoesNotExist' };
        expect(() => assertSchemaReferences([
            { const: literal },
            { enum: [literal] },
            { type: 'string', 'x-json-schema': literal },
        ])).not.toThrow();
    });

    it('uses exact JSON Pointer tokens without treating names as subpaths', () => {
        const name = 'a/~b%20';
        const ref = componentSchemaRef(name);
        expect(ref).toBe('#/components/schemas/a~1~0b%20');
        expect(componentSchemaName(ref)).toBe(name);
        expect(() => assertSchemaReferences([{ $ref: ref }], { [name]: true })).not.toThrow();
        for (const invalid of ['#/components/schemas/a/b', '#/components/schemas/a~2', '#/$defs/A']) {
            expect(() => componentSchemaName(invalid)).toThrow('Invalid component reference');
        }
    });
});
