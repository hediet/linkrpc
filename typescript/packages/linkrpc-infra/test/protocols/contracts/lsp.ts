import type { LinkRpcJsonSchema, MethodSchema } from "@hediet/linkrpc";
import {
    asArray,
    asRecord,
    componentClosure,
    finishInterface,
    localRef,
    metadataOf,
    requiredString,
} from "./common";
import type {
    ContractImportDiagnostic,
    ProtocolContractImport,
    ProtocolDirection,
    ProtocolMethodBinding,
} from "./types";

type ObjectMap = Record<string, Record<string, unknown>>;

export function importLspProtocol(metaModel: unknown): ProtocolContractImport {
    const model = asRecord(metaModel, "metaModel");
    const diagnostics: ContractImportDiagnostic[] = [];
    const definitions: ObjectMap = {};
    for (const category of ["structures", "enumerations", "typeAliases"] as const) {
        for (const [index, value] of asArray(model[category], `metaModel.${category}`).entries()) {
            const raw = asRecord(value, `${category}[${index}]`);
            const name = requiredString(raw, "name", `${category}[${index}]`);
            if (definitions[name] !== undefined) throw new Error(`duplicate LSP definition ${name}`);
            definitions[name] = raw;
        }
    }

    const allSchemas: Record<string, LinkRpcJsonSchema> = {};
    const converting = new Set<string>();
    const convertDefinition = (name: string): LinkRpcJsonSchema => {
        const cached = allSchemas[name];
        if (cached !== undefined) return cached;
        const raw = definitions[name];
        if (raw === undefined) {
            diagnostics.push({
                severity: "error",
                path: `definitions.${name}`,
                message: `missing LSP definition ${name}`,
            });
            return true;
        }
        if (converting.has(name)) return localRef(name);
        converting.add(name);
        let schema: LinkRpcJsonSchema;
        if ("properties" in raw) {
            schema = structureSchema(raw, name, definitions, convertDefinition, diagnostics);
        } else if ("values" in raw) {
            const values = asArray(raw.values, `${name}.values`).map((value, index) =>
                asRecord(value, `${name}.values[${index}]`).value,
            ) as import("@hediet/linkrpc").JsonValue[];
            schema = raw.supportsCustomValues === true
                ? {
                    anyOf: [
                        { enum: values },
                        convertLspType(asRecord(raw.type, `${name}.type`), `${name}.type`, diagnostics),
                    ],
                }
                : { enum: values };
        } else {
            schema = convertLspType(asRecord(raw.type, `${name}.type`), `${name}.type`, diagnostics);
        }
        converting.delete(name);
        if (schema !== true && schema !== false) {
            Object.assign(schema, {
                title: name,
                ...(typeof raw.documentation === "string" ? { description: raw.documentation } : {}),
                "x-protocol": metadataOf(raw, [
                    "since", "proposed", "deprecated", "supportsCustomValues",
                    "extends", "mixins", "values",
                ]),
            });
        }
        allSchemas[name] = schema;
        return schema;
    };
    for (const name of Object.keys(definitions)) convertDefinition(name);

    const grouped = new Map<string, {
        methods: Record<string, MethodSchema>;
        roots: LinkRpcJsonSchema[];
    }>();
    const bindings: ProtocolMethodBinding[] = [];
    for (const [kind, entries] of [
        ["request", asArray(model.requests, "metaModel.requests")],
        ["notification", asArray(model.notifications, "metaModel.notifications")],
    ] as const) {
        for (const [index, value] of entries.entries()) {
            const raw = asRecord(value, `${kind}s[${index}]`);
            const wireMethod = requiredString(raw, "method", `${kind}s[${index}]`);
            const target = lspTarget(wireMethod);
            const group = grouped.get(target.interfaceId) ?? { methods: {}, roots: [] };
            if (group.methods[target.member] !== undefined) {
                throw new Error(`duplicate LSP member ${target.interfaceId}.${target.member}`);
            }
            const params = raw.params === undefined
                ? true
                : convertLspType(asRecord(raw.params, `${wireMethod}.params`), `${wireMethod}.params`, diagnostics);
            const method: MethodSchema & Record<string, unknown> = {
                params,
                ...(kind === "request" ? {
                    result: convertLspType(
                        asRecord(raw.result, `${wireMethod}.result`),
                        `${wireMethod}.result`,
                        diagnostics,
                    ),
                } : {}),
                ...(typeof raw.documentation === "string" ? { description: raw.documentation } : {}),
                "x-protocol": {
                    wireMethod,
                    messageDirection: raw.messageDirection,
                    ...metadataOf(raw, [
                        "since", "proposed", "deprecated", "registrationMethod",
                        "registrationOptions", "partialResult", "errorData",
                    ]),
                },
            };
            group.methods[target.member] = method;
            group.roots.push(params);
            if (method.result !== undefined) group.roots.push(method.result);
            grouped.set(target.interfaceId, group);
            for (const direction of directions(raw.messageDirection, wireMethod)) {
                bindings.push({
                    wireMethod,
                    interfaceId: target.interfaceId,
                    member: target.member,
                    kind,
                    direction,
                    source: "lsp",
                });
            }
        }
    }

    const interfaces: ProtocolContractImport["interfaces"] = {};
    for (const [interfaceId, group] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
        interfaces[interfaceId] = finishInterface({
            id: interfaceId,
            description: `Language Server Protocol ${interfaceId.slice(4)} method group.`,
            methods: group.methods,
            components: {
                schemas: componentClosure(allSchemas, group.roots, diagnostics, interfaceId),
            },
            ...({ "x-protocol": { protocol: "lsp", version: model.metaData } } as Record<string, unknown>),
        } as Omit<import("@hediet/linkrpc").LinkRpcInterfaceSchema, "hash">);
    }
    return {
        interfaces,
        bindings,
        diagnostics,
        metadata: { protocol: "lsp", metaData: model.metaData },
    };
}

function structureSchema(
    raw: Record<string, unknown>,
    name: string,
    definitions: ObjectMap,
    convertDefinition: (name: string) => LinkRpcJsonSchema,
    diagnostics: ContractImportDiagnostic[],
    seen = new Set<string>(),
): LinkRpcJsonSchema {
    if (seen.has(name)) {
        diagnostics.push({
            severity: "warning",
            path: `structures.${name}`,
            message: "cyclic inheritance represented as a guarded reference",
            approximation: "structural",
        });
        return localRef(name);
    }
    const nextSeen = new Set(seen).add(name);
    const properties: Record<string, LinkRpcJsonSchema> = {};
    const required = new Set<string>();
    for (const parentValue of [
        ...optionalArray(raw.extends),
        ...optionalArray(raw.mixins),
    ]) {
        const parentType = asRecord(parentValue, `${name}.parent`);
        if (parentType.kind === "reference" && typeof parentType.name === "string") {
            const parent = definitions[parentType.name];
            if (parent !== undefined && "properties" in parent) {
                const inherited = structureSchema(
                    parent,
                    parentType.name,
                    definitions,
                    convertDefinition,
                    diagnostics,
                    nextSeen,
                );
                if (inherited !== true && inherited !== false && "properties" in inherited) {
                    for (const [propertyName, propertySchema] of Object.entries(inherited.properties)) {
                        mergeProperty(
                            properties,
                            propertyName,
                            propertySchema,
                            diagnostics,
                            `structures.${name}.${propertyName}`,
                        );
                    }
                    for (const key of inherited.required ?? []) required.add(key);
                    continue;
                }
            }
        }
        diagnostics.push({
            severity: "warning",
            path: `structures.${name}`,
            message: "non-object inheritance retained as x-json-schema allOf",
            approximation: "structural",
        });
    }
    for (const [index, value] of optionalArray(raw.properties).entries()) {
        const property = asRecord(value, `${name}.properties[${index}]`);
        const propertyName = requiredString(property, "name", `${name}.properties[${index}]`);
        mergeProperty(
            properties,
            propertyName,
            decorateLspSchema(convertLspType(
                asRecord(property.type, `${name}.${propertyName}.type`),
                `${name}.${propertyName}`,
                diagnostics,
            ), property),
            diagnostics,
            `structures.${name}.${propertyName}`,
        );
        if (property.optional !== true) required.add(propertyName);
    }
    // Force parent conversion so all inherited references are available to closures.
    for (const parent of [...optionalArray(raw.extends), ...optionalArray(raw.mixins)]) {
        const p = asRecord(parent, `${name}.parent`);
        if (p.kind === "reference" && typeof p.name === "string") convertDefinition(p.name);
    }
    return {
        type: "object",
        properties,
        ...(required.size > 0 ? { required: [...required] } : {}),
        additionalProperties: false,
    };
}

function mergeProperty(
    properties: Record<string, LinkRpcJsonSchema>,
    name: string,
    incoming: LinkRpcJsonSchema,
    diagnostics: ContractImportDiagnostic[],
    path: string,
): void {
    const existing = properties[name];
    if (existing === undefined || JSON.stringify(existing) === JSON.stringify(incoming)) {
        properties[name] = incoming;
        return;
    }
    diagnostics.push({
        severity: "warning",
        path,
        message: "inherited property constraints differ; conjunction retained in x-json-schema",
        approximation: "true",
    });
    properties[name] = withJsonSchema({ anyOf: [true] }, {
        allOf: [existing, incoming],
    });
}

function convertLspType(
    type: Record<string, unknown>,
    path: string,
    diagnostics: ContractImportDiagnostic[],
): LinkRpcJsonSchema {
    switch (type.kind) {
        case "base":
            switch (type.name) {
                case "string":
                case "DocumentUri":
                case "URI":
                case "RegExp":
                    return { type: "string" };
                case "integer":
                    return withJsonSchema(
                        { type: "integer", format: "int32" },
                        { minimum: -2147483648, maximum: 2147483647 },
                    );
                case "uinteger":
                    return withJsonSchema(
                        { type: "integer", format: "uint32" },
                        { minimum: 0, maximum: 2147483647 },
                    );
                case "decimal":
                    return { type: "number" };
                case "boolean":
                    return { type: "boolean" };
                case "null":
                    return { type: "null" };
                default:
                    return unsupported(diagnostics, path, `unsupported LSP base type ${String(type.name)}`);
            }
        case "reference":
            return typeof type.name === "string"
                ? localRef(type.name)
                : unsupported(diagnostics, path, "reference without a name");
        case "array":
            return {
                type: "array",
                items: convertLspType(asRecord(type.element, `${path}.element`), `${path}.element`, diagnostics),
            };
        case "tuple":
            return {
                type: "array",
                prefixItems: asArray(type.items, `${path}.items`).map((item, index) =>
                    convertLspType(asRecord(item, `${path}.items[${index}]`), `${path}.items[${index}]`, diagnostics),
                ),
                items: false,
            };
        case "or":
            return {
                anyOf: asArray(type.items, `${path}.items`).map((item, index) =>
                    convertLspType(asRecord(item, `${path}.items[${index}]`), `${path}.items[${index}]`, diagnostics),
                ),
            };
        case "and": {
            const branches = asArray(type.items, `${path}.items`).map((item, index) =>
                convertLspType(asRecord(item, `${path}.items[${index}]`), `${path}.items[${index}]`, diagnostics),
            );
            diagnostics.push({
                severity: "warning",
                path,
                message: "JSON Schema conjunction retained in x-json-schema; normative shape is an overapproximation",
                approximation: "true",
            });
            return withJsonSchema(true, { allOf: branches });
        }
        case "map": {
            const value = convertLspType(
                asRecord(type.value, `${path}.value`),
                `${path}.value`,
                diagnostics,
            );
            const key = asRecord(type.key, `${path}.key`);
            const result: LinkRpcJsonSchema = {
                type: "object",
                properties: {},
                additionalProperties: value,
            };
            if (!(key.kind === "base" && ["string", "DocumentUri", "URI"].includes(String(key.name)))) {
                diagnostics.push({
                    severity: "warning",
                    path: `${path}.key`,
                    message: "map key refinement retained as JSON Schema propertyNames",
                    approximation: "structural",
                });
                return withJsonSchema(result, {
                    propertyNames: convertLspType(key, `${path}.key`, diagnostics),
                });
            }
            return result;
        }
        case "literal":
            return literalObject(asRecord(type.value, `${path}.value`), path, diagnostics);
        case "stringLiteral":
        case "integerLiteral":
        case "booleanLiteral":
            return { const: type.value as import("@hediet/linkrpc").JsonValue };
        default:
            return unsupported(diagnostics, path, `unsupported LSP type kind ${String(type.kind)}`);
    }
}

function literalObject(
    literal: Record<string, unknown>,
    path: string,
    diagnostics: ContractImportDiagnostic[],
): LinkRpcJsonSchema {
    const properties: Record<string, LinkRpcJsonSchema> = {};
    const required: string[] = [];
    for (const [index, value] of optionalArray(literal.properties).entries()) {
        const property = asRecord(value, `${path}.properties[${index}]`);
        const name = requiredString(property, "name", `${path}.properties[${index}]`);
        properties[name] = decorateLspSchema(
            convertLspType(asRecord(property.type, `${path}.${name}`), `${path}.${name}`, diagnostics),
            property,
        );
        if (property.optional !== true) required.push(name);
    }
    return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
    };
}

function decorateLspSchema(
    schema: LinkRpcJsonSchema,
    source: Record<string, unknown>,
): LinkRpcJsonSchema {
    const decorated = schema === true || schema === false ? { anyOf: [schema] } : schema;
    Object.assign(decorated, {
        ...(typeof source.documentation === "string" ? { description: source.documentation } : {}),
        "x-protocol": metadataOf(source, ["since", "proposed", "deprecated"]),
    });
    return decorated;
}

function withJsonSchema<T extends LinkRpcJsonSchema>(
    schema: T,
    refinement: Record<string, unknown>,
): T {
    if (schema === true || schema === false) {
        return {
            anyOf: [schema],
            "x-json-schema": refinement,
        } as unknown as T;
    }
    return Object.assign(schema, { "x-json-schema": refinement });
}

function unsupported(
    diagnostics: ContractImportDiagnostic[],
    path: string,
    message: string,
): true {
    diagnostics.push({ severity: "warning", path, message, approximation: "true" });
    return true;
}

function lspTarget(method: string): { interfaceId: string; member: string } {
    const slash = method.indexOf("/");
    if (slash < 0) return { interfaceId: "lsp.lifecycle", member: method };
    const prefix = method.slice(0, slash);
    const suffix = method.slice(slash + 1);
    const group = prefix === "$" ? "protocol" : prefix.replace(/[^A-Za-z0-9_-]/g, "-").toLowerCase();
    return {
        interfaceId: `lsp.${group}`,
        member: suffix.replaceAll("/", "__"),
    };
}

function directions(value: unknown, method: string): ProtocolDirection[] {
    if (value === "both") return ["clientToServer", "serverToClient"];
    if (value === "clientToServer" || value === "serverToClient") return [value];
    throw new Error(`${method}.messageDirection: unsupported direction ${String(value)}`);
}

function optionalArray(value: unknown): unknown[] {
    return value === undefined ? [] : asArray(value, "LSP array");
}
