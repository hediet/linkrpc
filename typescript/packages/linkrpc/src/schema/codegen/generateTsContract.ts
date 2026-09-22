import { parseStaticHubSchema, type InterfaceRef, type StaticHubSchemaDocument } from '../staticHubSchema';
import { generateTsInterface } from './generateTsInterface';

export interface GenerateContractOptions {
    linkRpcImport?: string;
    /** Exact `interfaceId@interfaceHash` keys; required when derived names collide. */
    interfaceNames?: Readonly<Record<string, string>>;
    /** Keys: `root:id@hash`, `service:serviceId:id@hash`, `default`, or `bare:prefix`. */
    bindingNames?: Readonly<Record<string, string>>;
}

/** Generate one reusable definition per schema and immutable, typed route descriptors. */
export function generateTsContract(
    document: StaticHubSchemaDocument,
    options: GenerateContractOptions = {},
): string {
    const contract = parseStaticHubSchema(document);
    const imports = options.linkRpcImport ?? '@hediet/linkrpc';
    const chunks = [
        `import { applicationError, rpcError, bareInterfaceTarget, defaultInterfaceTarget, interfaceTarget, InterfaceDefinition, notificationType, requestType, type BareInterfaceTarget, type DefaultInterfaceTarget, type QualifiedInterfaceTarget, type LinkRpcInterfaceSchema } from ${JSON.stringify(imports)};`,
        'import { z } from "zod";',
        '',
    ];
    const names = new Set<string>([
        'applicationError', 'rpcError', 'bareInterfaceTarget', 'defaultInterfaceTarget', 'interfaceTarget',
        'InterfaceDefinition', 'notificationType', 'requestType', 'LinkRpcInterfaceSchema', 'z',
        'BareInterfaceTarget', 'DefaultInterfaceTarget', 'QualifiedInterfaceTarget',
    ]);
    const usedInterfaceKeys = new Set<string>();
    const usedBindingKeys = new Set<string>();
    const definitionNames = new Map<string, string>();
    function allocate(name: string, key: string): string {
        if (!/^[$A-Z_a-z][$\w]*$/.test(name) || reservedWords.has(name) || name.startsWith('$contract')) {
            throw new Error(`Invalid TypeScript export name '${name}' for '${key}'`);
        }
        if (names.has(name)) {
            throw new Error(`Generated name '${name}' collides for '${key}'; provide explicit naming overrides`);
        }
        names.add(name);
        return name;
    }
    const schemas = [...contract.interfaceSchemas].sort((a, b) => compare(`${a.id}@${a.hash}`, `${b.id}@${b.hash}`));
    for (const [index, schema] of schemas.entries()) {
        const key = `${schema.id}@${schema.hash}`;
        usedInterfaceKeys.add(key);
        const name = allocate(options.interfaceNames?.[key] ?? `${identifier(schema.id)}Interface`, key);
        definitionNames.set(key, name);
        const source = generateTsInterface(schema, {
            exportName: 'definition',
            preserveWireSchema: true,
            omitImports: true,
        });
        chunks.push(`namespace $contract${index} {`, source.trimEnd().split('\n').map((line) => `    ${line}`).join('\n'), '}');
        chunks.push(`export const ${name}: typeof $contract${index}.definition = $contract${index}.definition;`, '');
    }
    function binding(
        ref: InterfaceRef, key: string, derived: string, type: string, expression: (name: string) => string,
    ): void {
        usedBindingKeys.add(key);
        const name = allocate(options.bindingNames?.[key] ?? derived, key);
        const definition = definitionNames.get(`${ref.interfaceId}@${ref.interfaceHash}`)!;
        chunks.push(`export const ${name}: ${type}<typeof ${definition}> = ${expression(definition)};`);
    }
    for (const service of [...contract.services ?? []].sort((a, b) => compare(a.serviceId, b.serviceId))) {
        for (const ref of [...service.interfaces].sort((a, b) => compare(a.interfaceId, b.interfaceId))) {
            const key = `${ref.interfaceId}@${ref.interfaceHash}`;
            const base = identifier(ref.interfaceId);
            binding(ref, service.serviceId === '' ? `root:${key}` : `service:${service.serviceId}:${key}`,
                service.serviceId === '' ? `${base}Root` : `${identifier(service.serviceId)}${upper(base)}Service`,
                'QualifiedInterfaceTarget',
                (name) => `interfaceTarget(${name}, { serviceId: ${JSON.stringify(service.serviceId)} })`);
        }
    }
    if (contract.defaultInterface) {
        binding(contract.defaultInterface, 'default', `${identifier(contract.defaultInterface.interfaceId)}Default`,
            'DefaultInterfaceTarget',
            (name) => `defaultInterfaceTarget(${name})`);
    }
    for (const bare of [...contract.bareInterfaces ?? []].sort((a, b) => compare(a.prefix, b.prefix))) {
        binding(bare.interface, `bare:${bare.prefix}`,
            `${identifier(bare.prefix || bare.interface.interfaceId)}Bare`,
            'BareInterfaceTarget',
            (name) => `bareInterfaceTarget(${name}, { prefix: ${JSON.stringify(bare.prefix)} })`);
    }
    for (const [overrides, used] of [
        [options.interfaceNames, usedInterfaceKeys],
        [options.bindingNames, usedBindingKeys],
    ] as const) {
        for (const key of Object.keys(overrides ?? {})) {
            if (!used.has(key)) throw new Error(`Unknown naming override '${key}'`);
        }
    }
    return `${chunks.join('\n')}\n`;
}

function identifier(value: string): string {
    const words = value.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
    const name = words.map((word, index) => index === 0
        ? word[0]!.toLowerCase() + word.slice(1) : upper(word)).join('') || 'interface';
    return /^[0-9]/.test(name) ? `_${name}` : name;
}

function upper(value: string): string { return value[0]!.toUpperCase() + value.slice(1); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
const reservedWords = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with implements interface let package private protected public static yield await'.split(' '));
