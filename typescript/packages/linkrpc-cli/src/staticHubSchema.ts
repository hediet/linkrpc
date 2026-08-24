import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    computeInterfaceHash,
    type LinkRpcInterfaceSchema,
} from '@hediet/linkrpc';

export interface StaticInterfaceReference {
    interfaceId: string;
    interfaceHash: string;
}

export interface StaticService {
    serviceId: string;
    interfaces: StaticInterfaceReference[];
}

export interface StaticHubSchemaDocument {
    services: StaticService[];
    defaultInterface?: StaticInterfaceReference;
    interfaceSchemas: LinkRpcInterfaceSchema[];
}

export type StaticHubSchema = StaticHubSchemaDocument;

export function resolveStaticHubSchemaSource(source: string): string {
    return isHttpUrl(source) ? source : resolve(source);
}

export async function loadStaticHubSchema(source: string): Promise<StaticHubSchema> {
    let raw: unknown;
    try {
        let text: string;
        if (isHttpUrl(source)) {
            const response = await fetch(source);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`.trimEnd());
            }
            text = await response.text();
        } else {
            text = await readFile(source, 'utf8');
        }
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(`Failed to load hub schema '${source}': ${(error as Error).message}`);
    }
    try {
        return parseStaticHubSchema(raw);
    } catch (error) {
        throw new Error(`Invalid hub schema '${source}': ${(error as Error).message}`);
    }
}

function isHttpUrl(source: string): boolean {
    return /^https?:\/\//i.test(source);
}

export function parseStaticHubSchema(value: unknown): StaticHubSchema {
    const root = expectRecord(value, 'hub schema');
    const rawServices = expectArray(root.services, 'services');
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
    for (const [serviceIndex, service] of services.entries()) {
        for (const [interfaceIndex, ref] of service.interfaces.entries()) {
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
    }

    return {
        services,
        ...(defaultInterface === undefined ? {} : { defaultInterface }),
        interfaceSchemas,
    };
}

function parseService(value: unknown, path: string): StaticService {
    const service = expectRecord(value, path);
    if (typeof service.serviceId !== 'string') {
        throw new Error(`${path}.serviceId must be a string`);
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
