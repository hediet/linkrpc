import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    computeInterfaceHash, defineInterface, generateTsInterface, interfaceFromSchema,
    parseStaticHubSchema, requestType, rpcError, schemaToZod,
    type LinkRpcInterfaceSchema, type LinkRpcJsonSchema,
} from '../index';

describe('raw error schema contract', () => {
    const retryBody: LinkRpcJsonSchema = {
        type: 'object', additionalProperties: false, required: ['data', 'message'],
        properties: {
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: false, required: ['retryAfter'],
                properties: { retryAfter: { type: 'number' } } },
        },
    };
    const document: LinkRpcInterfaceSchema = {
        id: 'test.raw-wire-schema', hash: '',
        methods: { read: { params: true, result: { type: 'string' },
            errors: [{ code: -32001, schema: retryBody }] } },
    };
    document.hash = computeInterfaceHash(document);

    it.each(['type', 'message', 'data'] as const)('rejects a raw schema with a sibling %s at every import boundary', (key) => {
        for (const value of ['legacy', undefined]) {
            const mixed: LinkRpcInterfaceSchema = {
                ...document, methods: { read: { params: true, result: true, errors: [
                    { code: -32001, schema: retryBody, [key]: value },
                ] } },
            };
            mixed.hash = computeInterfaceHash(mixed);
            expect(() => interfaceFromSchema(mixed)).toThrow(/only code and schema/);
            expect(() => generateTsInterface(mixed)).toThrow(/only code and schema/);
            expect(() => parseStaticHubSchema({ interfaceSchemas: [mixed] })).toThrow(/only code and schema/);
        }
    });

    it('rejects raw code overlaps with raw, named, and legacy declarations in either order', () => {
        const raw = { code: 42, schema: retryBody };
        for (const other of [
            { code: 42, schema: true },
            { code: 42, type: 'Named', message: 'diagnostic' },
            { code: 42, message: 'Legacy' },
        ]) {
            for (const errors of [[raw, other], [other, raw]]) {
                const invalid: LinkRpcInterfaceSchema = {
                    ...document, methods: { read: { params: true, result: true, errors } },
                };
                invalid.hash = computeInterfaceHash(invalid);
                expect(() => interfaceFromSchema(invalid)).toThrow(/cannot be shared/);
                expect(() => generateTsInterface(invalid)).toThrow(/cannot be shared/);
                expect(() => parseStaticHubSchema({ interfaceSchemas: [invalid] })).toThrow(/cannot be shared/);
            }
        }
    });

    it('exports the serde-equivalent canonical code and body schema only', () => {
        const authored = defineInterface({ id: document.id }, {
            read: requestType(z.unknown(), z.string()).withErrors([
                rpcError(-32001, { message: z.string(), data: z.object({ retryAfter: z.number() }) }),
            ]),
        });
        expect(authored.toSchema()).toEqual(document);
        expect(interfaceFromSchema(document).toSchema()).toEqual(document);
        const fromBody = defineInterface({ id: document.id }, {
            read: requestType(z.unknown(), z.string()).withErrors([
                rpcError(-32001, schemaToZod(retryBody)),
            ]),
        });
        expect(fromBody.toSchema()).toEqual(document);
    });

    it('preserves arbitrary imported body schemas and references when re-exporting descriptors', () => {
        const components = { body: retryBody };
        const body: LinkRpcJsonSchema = { anyOf: [
            { $ref: '#/components/schemas/body' },
            { type: 'object', properties: { message: { const: 'done' } },
                required: ['message'], additionalProperties: false },
        ] };
        const source = defineInterface({ id: document.id }, {
            read: requestType(z.unknown(), z.string()).withErrors([
                rpcError(-32001, schemaToZod(body, components)),
            ]),
        });
        expect(source.toSchema().methods.read.errors).toEqual([{ code: -32001, schema: body }]);
        expect(source.toSchema().components?.schemas).toEqual(components);
        const imported = interfaceFromSchema(source.toSchema()).members.read;
        if (imported.kind !== 'request') throw new Error('expected request');
        const rebuilt = defineInterface({ id: source.info.id }, {
            read: requestType(z.unknown(), z.string()).withErrors(imported.errors),
        });
        expect(rebuilt.toSchema()).toEqual(source.toSchema());
    });
});
