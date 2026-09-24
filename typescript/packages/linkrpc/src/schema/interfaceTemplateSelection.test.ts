import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    computeInterfaceHash, defaultsInterface, defineInterface, defineInterfaceTemplate,
    directoryInterface, interfaceFromSchema, LinkRpcConnection, requestType,
    schemasInterface, TransportPair, type Schema,
} from '../index';
import { exportStaticHubSchema } from './exportStaticHubSchema';
import { getInterfaceTags, interfaceTemplatesEqual, preferRicherInterfaceSchema, validateInterfaceTemplates, type InterfaceTemplatesMetadata } from './interfaceTemplates';
import { SchemaValidationError } from './schemaValidationError';

const Store = defineInterfaceTemplate({ id: 'selection.store', parameters: ['Value'] },
    <V>({ Value }: { Value: Schema<V> }) => ({ get: requestType(Value, Value) }));
const numbers = Store({ Value: z.number() });
const rich = defineInterface({ id: 'selection' }, { numbers, backup: numbers });
const plain = defineInterface(rich.info, rich.members);
const partial = defineInterface(rich.info, rich.members, {
    templates: { numbers: numbers.mapMembers({ get: 'numbers$get' }) },
});
const incompatible = defineInterface(rich.info, rich.members, {
    templates: { renamed: numbers.mapMembers({ get: 'numbers$get' }) },
});

function fixture() {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    return { server, client, close() { server.close(); client.close(); } };
}

describe('optional template document selection', () => {
    it('aggregates only instantiated template tags, deduplicates, and ranks compatible tag supersets', () => {
        const taggedStore = defineInterfaceTemplate(
            { id: 'selection.tagged', parameters: ['Value'], tags: ['shared', 'store'] },
            <V>({ Value }: { Value: Schema<V> }) => ({ get: requestType(Value, Value) }),
        );
        const unused = defineInterfaceTemplate(
            { id: 'selection.unused', parameters: ['Value'], tags: ['unused'] },
            <V>({ Value }: { Value: Schema<V> }) => ({ get: requestType(Value, Value) }),
        );
        expect(unused).toBeDefined();
        const tagged = defineInterface(
            { id: 'selection.tags', tags: ['shared', 'application', 'shared'] },
            { primary: taggedStore({ Value: z.string() }), backup: taggedStore({ Value: z.number() }) },
        );
        const plain = defineInterface({ id: tagged.info.id }, tagged.members);
        expect(tagged.info.tags).toEqual(['application', 'shared', 'store']);
        expect(getInterfaceTags(tagged.toSchema())).toEqual(['application', 'shared', 'store']);
        expect(tagged.toSchema().tags).toEqual(tagged.info.tags);
        const meta = tagged.toSchema()['x-interface-templates'] as InterfaceTemplatesMetadata;
        const usedTemplate = meta.templates['selection.tagged']!;
        expect(interfaceTemplatesEqual(
            usedTemplate,
            { ...usedTemplate, tags: ['new-label'] },
        )).toBe(true);
        expect(tagged.schemaHash).toBe(plain.schemaHash);
        const restored = interfaceFromSchema(tagged.toSchema());
        expect(restored.info.tags).toEqual(tagged.info.tags);
        expect(restored.toSchema()).toEqual(tagged.toSchema());
        expect(preferRicherInterfaceSchema(plain.toSchema(), tagged.toSchema())).toBe(tagged.toSchema());
        expect(preferRicherInterfaceSchema(tagged.toSchema(), plain.toSchema())).toBe(tagged.toSchema());
        const moreTags = { ...tagged.toSchema(), tags: [...tagged.toSchema().tags!, 'extra'] };
        expect(preferRicherInterfaceSchema(tagged.toSchema(), moreTags)).toBe(moreTags);
        expect(preferRicherInterfaceSchema(moreTags, tagged.toSchema())).toBe(moreTags);
    });

    it('selects whole valid richer documents and keeps incompatible explanations and ties stable', () => {
        for (const definition of [plain, partial, rich, incompatible]) {
            expect(definition.schemaHash).toBe(plain.schemaHash);
        }
        expect(preferRicherInterfaceSchema(plain.toSchema(), rich.toSchema())).toBe(rich.toSchema());
        expect(preferRicherInterfaceSchema(rich.toSchema(), plain.toSchema())).toBe(rich.toSchema());
        expect(preferRicherInterfaceSchema(partial.toSchema(), rich.toSchema())).toBe(rich.toSchema());
        expect(preferRicherInterfaceSchema(rich.toSchema(), partial.toSchema())).toBe(rich.toSchema());
        expect(preferRicherInterfaceSchema(partial.toSchema(), incompatible.toSchema())).toBe(partial.toSchema());
        expect(preferRicherInterfaceSchema(incompatible.toSchema(), partial.toSchema())).toBe(incompatible.toSchema());
        const same = structuredClone(rich.toSchema());
        expect(preferRicherInterfaceSchema(rich.toSchema(), same)).toBe(rich.toSchema());
    });

    it('does not rank malformed metadata or mismatched concrete identities', () => {
        const malformed = { ...plain.toSchema(), 'x-interface-templates': { templates: {}, instances: [{}] } };
        expect(() => validateInterfaceTemplates(malformed)).toThrow();
        expect(preferRicherInterfaceSchema(plain.toSchema(), malformed)).toBe(plain.toSchema());
        expect(preferRicherInterfaceSchema(malformed, rich.toSchema())).toBe(rich.toSchema());
        for (const candidate of [
            { ...rich.toSchema(), id: 'other' },
            { ...rich.toSchema(), hash: 'invalid' },
            { ...rich.toSchema(), methods: {} },
        ]) {
            expect(preferRicherInterfaceSchema(plain.toSchema(), candidate)).toBe(plain.toSchema());
        }
        expect(computeInterfaceHash(malformed)).toBe(plain.schemaHash);
        // This optional ranking boundary does not weaken template-aware imports.
        expect(() => interfaceFromSchema(malformed)).toThrow();
    });

    it('rejects malformed first-class tags while leaving malformed optional templates unranked', () => {
        const invalidTags = { ...plain.toSchema(), tags: [false] as unknown as string[] };
        expect(() => interfaceFromSchema(invalidTags)).toThrow(/tags must be an array of strings/);
        expect(() => preferRicherInterfaceSchema(plain.toSchema(), invalidTags))
            .toThrow(/tags must be an array of strings/);
        expect(() => preferRicherInterfaceSchema(invalidTags, plain.toSchema()))
            .toThrow(/tags must be an array of strings/);
        const invalidTemplates = {
            ...plain.toSchema(), 'x-interface-templates': { unknown: true },
        };
        expect(preferRicherInterfaceSchema(plain.toSchema(), invalidTemplates)).toBe(plain.toSchema());
        expect(preferRicherInterfaceSchema(invalidTemplates, plain.toSchema())).toBe(plain.toSchema());
    });

    it.each([
        ['null errors', ['templates', 'selection.store', 'methods', 'get', 'errors'], null],
        ['non-array errors', ['templates', 'selection.store', 'methods', 'get', 'errors'], {}],
        ['string errors', ['templates', 'selection.store', 'methods', 'get', 'errors'], 'invalid'],
        ['null error entry', ['templates', 'selection.store', 'methods', 'get', 'errors'], [null]],
        ['primitive error entry', ['templates', 'selection.store', 'methods', 'get', 'errors'], [1]],
        ['invalid error schema', ['templates', 'selection.store', 'methods', 'get', 'errors'], [{ code: 1, schema: null }]],
        ['invalid error data', ['templates', 'selection.store', 'methods', 'get', 'errors'], [{ code: 1, message: 'error', data: null }]],
        ['null template components', ['templates', 'selection.store', 'components'], null],
        ['primitive template components', ['templates', 'selection.store', 'components'], 1],
        ['array template components', ['templates', 'selection.store', 'components'], []],
        ['null template component map', ['templates', 'selection.store', 'components'], { schemas: null }],
        ['array template component map', ['templates', 'selection.store', 'components'], { schemas: [] }],
        ['null template component', ['templates', 'selection.store', 'components'], { schemas: { Unused: null } }],
        ['null argument components', ['instances', '0', 'arguments', 'Value', 'components'], null],
        ['invalid argument component map', ['instances', '0', 'arguments', 'Value', 'components'], { schemas: 1 }],
        ['null argument component', ['instances', '0', 'arguments', 'Value', 'components'], { schemas: { Unused: null } }],
        ['invalid referenced argument component', ['instances', '0', 'arguments', 'Value'], {
            schema: { $ref: '#/components/schemas/Bad' }, components: { schemas: { Bad: null } },
        }],
        ['inherited template name', ['instances', '0', 'template'], 'toString'],
    ])('leaves malformed metadata unranked: %s', (_label, path, value) => {
        const malformed = structuredClone(rich.toSchema());
        let target = malformed['x-interface-templates'] as Record<string, unknown>;
        const segments = path as string[];
        for (const segment of segments.slice(0, -1)) target = target[segment] as Record<string, unknown>;
        target[segments[segments.length - 1]] = value;
        expect(() => validateInterfaceTemplates(malformed)).toThrow(SchemaValidationError);
        expect(() => interfaceFromSchema(malformed)).toThrow(SchemaValidationError);
        expect(preferRicherInterfaceSchema(plain.toSchema(), malformed)).toBe(plain.toSchema());
        expect(preferRicherInterfaceSchema(malformed, rich.toSchema())).toBe(rich.toSchema());
    });

    it.each([
        null, 1, [], { $ref: 1 }, { $ref: 'external' },
        { $ref: '#/components/schemas/Bad~2' }, { $ref: '#/components/schemas/Bad/Name' },
        { $ref: '#/components/schemas/Missing' },
        { properties: null }, { properties: [] }, { properties: { child: null } },
        { items: null }, { additionalProperties: 1 },
        { prefixItems: {} }, { anyOf: null }, { oneOf: 'invalid' },
        { prefixItems: [null] }, { anyOf: [1] }, { oneOf: [[]] },
    ])('classifies malformed nested schemas as validation failures: %j', invalidSchema => {
        for (const position of ['template', 'argument']) {
            const malformed = structuredClone(rich.toSchema());
            const metadata = malformed['x-interface-templates'] as {
                templates: Record<string, { methods: Record<string, { params: unknown }> }>;
                instances: { arguments: Record<string, { schema: unknown }> }[];
            };
            if (position === 'template') metadata.templates['selection.store'].methods.get.params = invalidSchema;
            else metadata.instances[0].arguments.Value.schema = invalidSchema;
            expect(() => validateInterfaceTemplates(malformed)).toThrow(SchemaValidationError);
            expect(() => interfaceFromSchema(malformed)).toThrow(SchemaValidationError);
            expect(preferRicherInterfaceSchema(plain.toSchema(), malformed)).toBe(plain.toSchema());
            expect(preferRicherInterfaceSchema(malformed, rich.toSchema())).toBe(rich.toSchema());
        }
    });

    it.each([Error, TypeError, RangeError])('propagates unexpected %s failures during metadata validation', ErrorType => {
        const broken = structuredClone(rich.toSchema());
        const failure = new ErrorType('Unexpected validation failure');
        const metadata = broken['x-interface-templates'] as { templates: Record<string, object> };
        Object.defineProperty(metadata.templates['selection.store'], 'methods', {
            get() { throw failure; },
        });
        expect(() => validateInterfaceTemplates(broken)).toThrow(failure);
        expect(() => preferRicherInterfaceSchema(plain.toSchema(), broken)).toThrow(failure);
        expect(() => preferRicherInterfaceSchema(broken, rich.toSchema())).toThrow(failure);
    });

    it.each([false, true])('prefers metadata regardless of registration order (%s), without changing dispatch', async reverse => {
        const f = fixture();
        try {
            const registerPlain = () => f.server.register(plain, {
                'numbers$get': value => value + 1, 'backup$get': value => value,
            }, { serviceId: 'plain' });
            const registerRich = () => f.server.register(rich, {
                numbers: { get: value => value + 2 }, backup: { get: value => value },
            }, { serviceId: 'rich' });
            if (reverse) { registerRich(); registerPlain(); } else { registerPlain(); registerRich(); }
            expect(f.server.findRegisteredInterface(rich.info.id, rich.schemaHash)).toBe(rich);
            expect(f.server.findRegisteredInterface(rich.info.id)).toBe(rich);
            expect(await f.client.get(rich, { serviceId: 'plain' }).numbers.get(4)).toBe(5);
            expect(await f.client.get(rich, { serviceId: 'rich' }).numbers.get(4)).toBe(6);
        } finally { f.close(); }
    });

    it('keeps the first hash when no hash is requested, but upgrades within that hash', () => {
        const f = fixture();
        try {
            const different = defineInterface(rich.info, { get: requestType(z.string(), z.string()) });
            f.server.register(partial, { 'numbers$get': value => value, 'backup$get': value => value }, { serviceId: 'first' });
            f.server.register(different, { get: value => value }, { serviceId: 'second' });
            f.server.register(rich, { numbers: { get: value => value }, backup: { get: value => value } }, { serviceId: 'third' });
            expect(f.server.findRegisteredInterface(rich.info.id)).toBe(rich);
            expect(f.server.findRegisteredInterface(rich.info.id, different.schemaHash)).toBe(different);
        } finally { f.close(); }
    });

    it('does not reject ordinary RPC or static reflection merely for malformed optional explanations', async () => {
        const f = fixture();
        const schema = { ...plain.toSchema(), 'x-interface-templates': { future: 'unrecognized' } };
        try {
            f.server.register(plain, { 'numbers$get': value => value + 1, 'backup$get': value => value });
            f.server.register(directoryInterface, {
                list: () => ({ items: [{ serviceId: '', interfaceId: plain.info.id, interfaceHash: plain.schemaHash }] }),
                watch: () => ({}),
            });
            f.server.register(defaultsInterface, { get: () => ({}), listBindings: () => ({ bindings: [] }) });
            f.server.register(schemasInterface, { get: () => ({ schema }) });
            expect(await f.client.get(plain)['numbers$get'](4)).toBe(5);
            expect((await exportStaticHubSchema(f.client.channel)).interfaceSchemas).toEqual([schema]);
        } finally { f.close(); }
    });

    it.each([false, true])('exports the richer schema from distinct discovered sources (%s)', async reverse => {
        const f = fixture();
        const fetched: string[] = [];
        try {
            const sources = reverse ? ['rich', 'plain'] : ['plain', 'rich'];
            f.server.register(directoryInterface, {
                list: () => ({ items: sources.map(serviceId => ({
                    serviceId, interfaceId: directoryInterface.info.id, interfaceHash: directoryInterface.schemaHash,
                })) }),
                watch: () => ({}),
            });
            f.server.register(defaultsInterface, { get: () => ({}), listBindings: () => ({ bindings: [] }) });
            f.server.register(schemasInterface, { get: () => ({ schema: directoryInterface.toSchema() }) });
            for (const source of sources) {
                f.server.register(directoryInterface, {
                    list: () => ({ items: [{
                        serviceId: source, interfaceId: rich.info.id, interfaceHash: rich.schemaHash,
                    }] }),
                    watch: () => ({}),
                }, { serviceId: source });
                f.server.register(schemasInterface, {
                    get: () => {
                        fetched.push(source);
                        return { schema: source === 'rich' ? rich.toSchema() : plain.toSchema() };
                    },
                }, { serviceId: source });
            }
            const document = await exportStaticHubSchema(f.client.channel);
            expect(fetched.sort()).toEqual(['plain', 'rich']);
            expect(document.interfaceSchemas.find(schema => schema.id === rich.info.id)).toEqual(rich.toSchema());
        } finally { f.close(); }
    });
});
