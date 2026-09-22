import { defineInterface, requestType } from '@hediet/linkrpc';
import { resolve } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    loadStaticHubSchema,
    parseStaticHubSchema,
    resolveStaticHubSchemaSource,
    type StaticHubSchemaDocument,
} from './staticHubSchema';

const greeterInterface = defineInterface(
    { id: 'example.greeter' },
    {
        hello: requestType(
            z.object({ name: z.string() }),
            z.object({ greeting: z.string() }),
        ),
    },
);

function validDocument(): StaticHubSchemaDocument {
    const schema = greeterInterface.toSchema();
    const ref = {
        interfaceId: schema.id,
        interfaceHash: schema.hash,
    };
    return {
        services: [],
        defaultInterface: ref,
        interfaceSchemas: [schema],
    };
}

describe('parseStaticHubSchema', () => {
    it('keeps schema definitions separate from service and default references', () => {
        const parsed = parseStaticHubSchema(validDocument());

        expect(parsed.services).toEqual(validDocument().services);
        expect(parsed.defaultInterface).toEqual(validDocument().defaultInterface);
        expect(parsed.interfaceSchemas).toEqual([greeterInterface.toSchema()]);
    });

    it('rejects an interface schema whose declared hash is stale', () => {
        const document = validDocument();
        document.interfaceSchemas[0] = {
            ...document.interfaceSchemas[0],
            hash: '0000000000000000',
        };

        expect(() => parseStaticHubSchema(document)).toThrow(/hash mismatch/);
    });

    it('rejects unresolved service interface references', () => {
        const document = validDocument();
        document.services!.push({
            serviceId: 'nested',
            interfaces: [{
                interfaceId: 'missing.interface',
                interfaceHash: '0000000000000000',
            }],
        });

        expect(() => parseStaticHubSchema(document)).toThrow(/does not resolve/);
    });

    it('allows the default interface without exposing a directory service', () => {
        const parsed = parseStaticHubSchema(validDocument());

        expect(parsed.services).toEqual([]);
        expect(parsed.defaultInterface).toEqual(validDocument().defaultInterface);
    });
});

describe('loadStaticHubSchema', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('fetches an HTTP schema URL', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify(validDocument()), { status: 200 }),
        );

        await expect(loadStaticHubSchema('https://example.test/ahp-schema.json'))
            .resolves.toEqual(parseStaticHubSchema(validDocument()));
        expect(fetchMock).toHaveBeenCalledWith('https://example.test/ahp-schema.json');
    });

    it('reports unsuccessful HTTP responses', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('not found', { status: 404, statusText: 'Not Found' }),
        );

        await expect(loadStaticHubSchema('https://example.test/missing.json'))
            .rejects.toThrow(/404 Not Found/);
    });

    it('preserves HTTP URLs and resolves filesystem paths', () => {
        expect(resolveStaticHubSchemaSource('https://example.test/schema.json'))
            .toBe('https://example.test/schema.json');
        expect(resolveStaticHubSchemaSource('schemas/example.json'))
            .toBe(resolve('schemas/example.json'));
    });
});
