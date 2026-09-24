import { computeInterfaceHash } from './hash';
import type { LinkRpcInterfaceSchema } from './linkRpcInterfaceSchema';
import { validateBarePrefix } from '../connection/bareInterfaceTarget';
import { validateInterfaceErrors } from './validateInterfaceErrors';

export interface InterfaceRef {
    interfaceId: string;
    interfaceHash: string;
}

export type StaticInterfaceReference = InterfaceRef;

export interface StaticService {
    serviceId: string;
    interfaces: StaticInterfaceReference[];
}

export interface StaticHubSchemaDocument {
    services?: StaticService[];
    defaultInterface?: StaticInterfaceReference;
    bareInterfaces?: { interface: InterfaceRef; prefix: string }[];
    interfaceSchemas: LinkRpcInterfaceSchema[];
}

export type StaticHubSchema = StaticHubSchemaDocument;

export function parseStaticHubSchema(value: unknown): StaticHubSchema {
    const root = expectRecord(value, 'hub schema');
    const rawServices = root.services === undefined ? [] : expectArray(root.services, 'services');
    const rawSchemas = expectArray(root.interfaceSchemas, 'interfaceSchemas');

    const interfaceSchemas = rawSchemas.map((schema, index) =>
        parseInterfaceSchema(schema, `interfaceSchemas[${index}]`));
    const schemasByKey = new Map<string, LinkRpcInterfaceSchema>();
    for (const schema of interfaceSchemas) {
        const key = interfaceKey(schema.id, schema.hash);
        if (schemasByKey.has(key)) {
            throw new Error(`interfaceSchemas contains duplicate ${schema.id}@${schema.hash}`);
        }
        schemasByKey.set(key, schema);
    }

    const services = rawServices.map((service, index) =>
        parseService(service, `services[${index}]`));
    const serviceIds = new Set<string>();
    for (const [serviceIndex, service] of services.entries()) {
        if (serviceIds.has(service.serviceId)) throw new Error(`Duplicate serviceId '${service.serviceId}'`);
        serviceIds.add(service.serviceId);
        const interfaceIds = new Set<string>();
        for (const [interfaceIndex, ref] of service.interfaces.entries()) {
            if (interfaceIds.has(ref.interfaceId)) {
                throw new Error(`Duplicate interface '${ref.interfaceId}' in service '${service.serviceId}'`);
            }
            interfaceIds.add(ref.interfaceId);
            requireResolvedReference(
                ref,
                schemasByKey,
                `services[${serviceIndex}].interfaces[${interfaceIndex}]`,
            );
        }
    }

    const defaultInterface = root.defaultInterface === undefined
        ? undefined
        : parseInterfaceReference(root.defaultInterface, 'defaultInterface');
    if (defaultInterface !== undefined) {
        requireResolvedReference(defaultInterface, schemasByKey, 'defaultInterface');
        const rootInterface = services.find((service) => service.serviceId === '')?.interfaces
            .find((ref) => ref.interfaceId === defaultInterface.interfaceId);
        if (rootInterface !== undefined && rootInterface.interfaceHash !== defaultInterface.interfaceHash) {
            throw new Error(`defaultInterface conflicts with root '${defaultInterface.interfaceId}'`);
        }
    }

    const prefixes = new Set<string>();
    const bareInterfaces = root.bareInterfaces === undefined ? undefined
        : expectArray(root.bareInterfaces, 'bareInterfaces').map((value, index) => {
            const path = `bareInterfaces[${index}]`;
            const binding = expectRecord(value, path);
            if (typeof binding.prefix !== 'string') throw new Error(`${path}.prefix must be a string`);
            validateBarePrefix(binding.prefix);
            if (prefixes.has(binding.prefix)) throw new Error(`Duplicate bare prefix '${binding.prefix}'`);
            prefixes.add(binding.prefix);
            const ref = parseInterfaceReference(binding.interface, `${path}.interface`);
            requireResolvedReference(ref, schemasByKey, `${path}.interface`);
            if (binding.prefix === '' && defaultInterface !== undefined
                && interfaceKey(ref.interfaceId, ref.interfaceHash)
                !== interfaceKey(defaultInterface.interfaceId, defaultInterface.interfaceHash)) {
                throw new Error('Empty bare prefix conflicts with defaultInterface');
            }
            return { interface: ref, prefix: binding.prefix };
        });

    return {
        ...(root.services === undefined ? {} : { services }),
        ...(defaultInterface === undefined ? {} : { defaultInterface }),
        ...(bareInterfaces === undefined ? {} : { bareInterfaces }),
        interfaceSchemas,
    };
}

function parseService(value: unknown, path: string): StaticService {
    const service = expectRecord(value, path);
    if (typeof service.serviceId !== 'string') {
        throw new Error(`${path}.serviceId must be a string`);
    }
    if (service.serviceId.includes('::') || !/^[\x20-\x7e]*$/.test(service.serviceId)) {
        throw new Error(`${path}.serviceId must be printable ASCII without "::"`);
    }
    return {
        serviceId: service.serviceId,
        interfaces: expectArray(service.interfaces, `${path}.interfaces`).map((ref, index) =>
            parseInterfaceReference(ref, `${path}.interfaces[${index}]`)),
    };
}

function parseInterfaceReference(value: unknown, path: string): StaticInterfaceReference {
    const ref = expectRecord(value, path);
    if (typeof ref.interfaceId !== 'string' || ref.interfaceId.length === 0) {
        throw new Error(`${path}.interfaceId must be a non-empty string`);
    }
    if (typeof ref.interfaceHash !== 'string' || ref.interfaceHash.length === 0) {
        throw new Error(`${path}.interfaceHash must be a non-empty string`);
    }
    return {
        interfaceId: ref.interfaceId,
        interfaceHash: ref.interfaceHash,
    };
}

function parseInterfaceSchema(value: unknown, path: string): LinkRpcInterfaceSchema {
    const schema = expectRecord(value, path);
    if (typeof schema.id !== 'string' || schema.id.length === 0) {
        throw new Error(`${path}.id must be a non-empty string`);
    }
    if (typeof schema.hash !== 'string' || schema.hash.length === 0) {
        throw new Error(`${path}.hash must be a non-empty string`);
    }
    if (typeof schema.methods !== 'object' || schema.methods === null || Array.isArray(schema.methods)) {
        throw new Error(`${path}.methods must be an object`);
    }
    if (schema.tags !== undefined
        && (!Array.isArray(schema.tags) || schema.tags.some(tag => typeof tag !== 'string'))) {
        throw new Error(`${path}.tags must be an array of strings`);
    }
    for (const [name, method] of Object.entries(schema.methods)) {
        if (name.length === 0) {
            throw new Error(`${path}.methods keys must be non-empty strings`);
        }
        const parsed = expectRecord(method, `${path}.methods.${name}`);
        if (!Object.hasOwn(parsed, 'params')) {
            throw new Error(`${path}.methods.${name}.params is required`);
        }
    }

    const typed = schema as unknown as LinkRpcInterfaceSchema;
    validateInterfaceErrors(typed);
    const computedHash = computeInterfaceHash(typed);
    if (computedHash !== typed.hash) {
        throw new Error(
            `${path} hash mismatch for ${typed.id}: declared ${typed.hash}, computed ${computedHash}`,
        );
    }
    return typed;
}

function requireResolvedReference(
    ref: StaticInterfaceReference,
    schemasByKey: ReadonlyMap<string, LinkRpcInterfaceSchema>,
    path: string,
): void {
    if (!schemasByKey.has(interfaceKey(ref.interfaceId, ref.interfaceHash))) {
        throw new Error(`${path} ${formatReference(ref)} does not resolve to an interface schema`);
    }
}

function formatReference(ref: StaticInterfaceReference): string {
    return `${ref.interfaceId}@${ref.interfaceHash}`;
}

function interfaceKey(interfaceId: string, interfaceHash: string): string {
    return `${interfaceId}\0${interfaceHash}`;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
    return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${path} must be an array`);
    }
    return value;
}
