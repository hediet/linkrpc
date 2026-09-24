import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateTsContract } from './codegen/generateTsContract';
import { parseStaticHubSchema } from './staticHubSchema';
import { computeInterfaceHash } from './hash';
import type { LinkRpcInterfaceSchema } from './linkRpcInterfaceSchema';

describe('shared Rust/TypeScript static contract fixture', () => {
    it('preserves tagged schema metadata without changing its pinned hash', () => {
        const schema: LinkRpcInterfaceSchema = {
            id: 'tagged.static', hash: '', tags: ['search'],
            methods: { read: { params: true, result: true } },
        };
        schema.hash = computeInterfaceHash(schema);
        expect(schema.hash).toBe(computeInterfaceHash({ ...schema, tags: ['other'] }));
        const parsed = parseStaticHubSchema({ interfaceSchemas: [schema] });
        expect(parsed.interfaceSchemas[0]?.tags).toEqual(['search']);
        expect(() => parseStaticHubSchema({
            interfaceSchemas: [{ ...schema, tags: [1] }],
        })).toThrow(/tags must be an array of strings/);
    });

    it('rejects different root/default versions of one interface but permits named-service versions', () => {
        const first: LinkRpcInterfaceSchema = { id: 'versions', hash: '', methods: { read: { params: true, result: true } } };
        first.hash = computeInterfaceHash(first);
        const second: LinkRpcInterfaceSchema = { id: 'versions', hash: '', methods: { read: { params: true, result: false } } };
        second.hash = computeInterfaceHash(second);
        const document = {
            interfaceSchemas: [first, second],
            services: [{ serviceId: '', interfaces: [{ interfaceId: first.id, interfaceHash: first.hash }] }],
            defaultInterface: { interfaceId: second.id, interfaceHash: second.hash },
        };
        expect(() => parseStaticHubSchema(document)).toThrow(/defaultInterface conflicts with root/);
        expect(() => parseStaticHubSchema({
            ...document, defaultInterface: document.services[0]!.interfaces[0],
        })).not.toThrow();
        expect(() => parseStaticHubSchema({
            ...document, services: [{ ...document.services[0], serviceId: 'named' }],
        })).not.toThrow();
    });

    it('validates exact hashes and roundtrips every reference using the shared wire field names', () => {
        const raw = JSON.parse(readFileSync(new URL('./fixtures/static-contract.json', import.meta.url), 'utf8'));
        const document = parseStaticHubSchema(raw);
        expect(JSON.parse(JSON.stringify(document))).toEqual(raw);
        const ref = { interfaceId: 'fixture.echo', interfaceHash: '3f5ed133dd85203a' };
        expect(document.defaultInterface).toEqual(ref);
        expect(document.services!.map((service) => service.interfaces)).toEqual([[ref], [ref]]);
        expect(document.bareInterfaces).toEqual([
            { interface: ref, prefix: '' },
            { interface: ref, prefix: 'Runtime.' },
        ]);
        const generated = generateTsContract(document);
        expect(generated.match(/new InterfaceDefinition\(/g)).toHaveLength(1);
        expect(generated).toContain('fixtureEchoRoot: QualifiedInterfaceTarget<typeof fixtureEchoInterface>');
        expect(generated).toContain('workerFixtureEchoService: QualifiedInterfaceTarget<typeof fixtureEchoInterface>');
        expect(generated).toContain('fixtureEchoDefault: DefaultInterfaceTarget<typeof fixtureEchoInterface>');
        expect(generated).toContain('runtimeBare: BareInterfaceTarget<typeof fixtureEchoInterface>');
    });
});
