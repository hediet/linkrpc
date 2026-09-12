import {
    assertSchemaReferences,
    componentSchemaName,
    componentSchemaRef,
    computeInterfaceHash,
    type LinkRpcInterfaceSchema,
    type LinkRpcJsonSchema,
} from "@hediet/linkrpc";
import type { ContractImportDiagnostic } from "./types";

export function asRecord(value: unknown, path: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path}: expected object`);
    }
    return value as Record<string, unknown>;
}

export function asArray(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
    return value;
}

export function requiredString(
    value: Record<string, unknown>,
    key: string,
    path: string,
): string {
    const result = value[key];
    if (typeof result !== "string" || result.length === 0) {
        throw new Error(`${path}.${key}: expected non-empty string`);
    }
    return result;
}

export function finishInterface(
    value: Omit<LinkRpcInterfaceSchema, "hash">,
): LinkRpcInterfaceSchema {
    const roots: LinkRpcJsonSchema[] = [];
    for (const method of Object.values(value.methods)) {
        roots.push(method.params);
        if (method.result !== undefined) roots.push(method.result);
        if (method.clientStream !== undefined) roots.push(method.clientStream);
        if (method.serverStream !== undefined) roots.push(method.serverStream);
        for (const error of method.errors ?? []) {
            if (error.data !== undefined) roots.push(error.data);
        }
    }
    assertSchemaReferences(roots, value.components?.schemas);
    const result: LinkRpcInterfaceSchema = { ...value, hash: "" };
    result.hash = computeInterfaceHash(result);
    return result;
}

export function localRef(name: string): LinkRpcJsonSchema {
    return { $ref: componentSchemaRef(name) };
}

function refName(ref: string): string | undefined {
    try {
        return componentSchemaName(ref);
    } catch {
        return undefined;
    }
}

/** Return the transitive component closure needed by the supplied roots. */
export function componentClosure(
    all: Record<string, LinkRpcJsonSchema>,
    roots: Iterable<LinkRpcJsonSchema>,
    diagnostics: ContractImportDiagnostic[],
    diagnosticPath: string,
    seedNames: Iterable<string> = [],
): Record<string, LinkRpcJsonSchema> {
    const needed = new Set(seedNames);
    const pending: LinkRpcJsonSchema[] = [...roots];
    for (const seed of needed) {
        const schema = all[seed];
        if (schema !== undefined) pending.push(schema);
    }
    const visit = (value: LinkRpcJsonSchema): void => {
        if (typeof value === "boolean") return;
        if ("$ref" in value) {
            const name = refName(value.$ref);
            if (name === undefined || all[name] === undefined) {
                diagnostics.push({
                    severity: "error",
                    path: diagnosticPath,
                    message: `dangling or external reference ${value.$ref}`,
                });
            } else if (!needed.has(name)) {
                needed.add(name);
                pending.push(all[name]);
            }
        }
        if ("anyOf" in value) value.anyOf.forEach(visit);
        if ("oneOf" in value) value.oneOf.forEach(visit);
        if ("type" in value && value.type === "object") {
            Object.values(value.properties).forEach(visit);
            if (value.additionalProperties !== false) visit(value.additionalProperties);
        }
        if ("type" in value && value.type === "array") {
            if ("prefixItems" in value) value.prefixItems.forEach(visit);
            if (value.items !== undefined && value.items !== false) visit(value.items);
        }
    };
    while (pending.length > 0) visit(pending.pop()!);
    return Object.fromEntries([...needed].sort().map((name) => [name, all[name]!]));
}

export function metadataOf(raw: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    return Object.fromEntries(keys.flatMap((key) => raw[key] === undefined ? [] : [[key, raw[key]]]));
}
