import { describe, expect, it } from 'vitest';
import type { MethodSchema, LinkRpcInterfaceSchema as SvcInterfaceSchema } from '@hediet/linkrpc';
import { renderMethodParamHelp } from './methodHelp';

function makeSchema(method: MethodSchema, components: Record<string, unknown> = {}): SvcInterfaceSchema {
    return {
        id: 'acme.email',
        hash: 'h0',
        methods: { test: method },
        ...(Object.keys(components).length > 0 ? { components: { schemas: components as never } } : {}),
    };
}

describe('renderMethodParamHelp', () => {
    it('renders one line per object property with required mark and type', () => {
        const m: MethodSchema = {
            params: {
                type: 'object',
                properties: {
                    to: { type: 'string' },
                    subject: { type: 'string', description: 'mail subject' },
                    cc: { type: 'array', items: { type: 'string' } },
                },
                required: ['to', 'subject'],
                additionalProperties: false,
            },
        };
        const r = renderMethodParamHelp(m, makeSchema(m));
        expect(r.paramNames).toEqual(['to', 'subject', 'cc']);
        const lines = r.text.split('\n');
        expect(lines[0]).toBe('Method parameters (acme.email@h0):');
        // Each row contains the flag + the required/optional marker
        expect(r.text).toContain('--p:to <string>');
        expect(r.text).toMatch(/--p:to <string>\s+required/);
        expect(r.text).toContain('--p:subject <string>');
        expect(r.text).toMatch(/--p:subject <string>\s+required\s+mail subject/);
        expect(r.text).toContain('--p:cc <string[]>');
        expect(r.text).toMatch(/--p:cc <string\[\]>\s+optional/);
    });

    it('renders enum + const + union types as helpful labels', () => {
        const m: MethodSchema = {
            params: {
                type: 'object',
                properties: {
                    kind: { enum: ['create', 'delete'] },
                    flag: { const: true },
                    any: { anyOf: [{ type: 'string' }, { type: 'number' }] },
                },
                additionalProperties: false,
            },
        };
        const r = renderMethodParamHelp(m, makeSchema(m));
        expect(r.text).toContain('--p:kind <enum("create"|"delete")>');
        expect(r.text).toContain('--p:flag <true>');
        expect(r.text).toContain('--p:any <union>');
        expect(r.paramNames).toEqual(['kind', 'flag', 'any']);
    });

    it('resolves $ref against components.schemas before classifying', () => {
        const m: MethodSchema = {
            params: {
                type: 'object',
                properties: {
                    owner: { $ref: '#/components/schemas/User' },
                },
                required: ['owner'],
                additionalProperties: false,
            },
        };
        const schema = makeSchema(m, {
            User: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
        });
        const r = renderMethodParamHelp(m, schema);
        // The owner property resolves to an object schema; we don't recurse,
        // so the label is the generic `object`.
        expect(r.text).toContain('--p:owner <object>');
    });

    it('renders a coarse fallback when params is not a plain object', () => {
        const m: MethodSchema = {
            params: { type: 'array', items: { type: 'string' } },
        };
        const r = renderMethodParamHelp(m, makeSchema(m));
        expect(r.text).toContain('(params is not a plain object');
        expect(r.paramNames).toEqual([]);
    });

    it('renders "(no parameters)" for an empty object schema', () => {
        const m: MethodSchema = {
            params: { type: 'object', properties: {}, additionalProperties: false },
        };
        const r = renderMethodParamHelp(m, makeSchema(m));
        expect(r.text).toContain('(no parameters)');
        expect(r.paramNames).toEqual([]);
    });

    it('preserves the first line of multi-line descriptions and truncates very long ones', () => {
        const longDesc = 'A'.repeat(200);
        const m: MethodSchema = {
            params: {
                type: 'object',
                properties: {
                    a: { type: 'string', description: 'line one\nline two' },
                    b: { type: 'string', description: longDesc },
                },
                additionalProperties: false,
            },
        };
        const r = renderMethodParamHelp(m, makeSchema(m));
        expect(r.text).toContain('line one');
        expect(r.text).not.toContain('line two');
        // Truncated to 77 + ellipsis
        expect(r.text).toMatch(/A{77}…/);
    });
});
