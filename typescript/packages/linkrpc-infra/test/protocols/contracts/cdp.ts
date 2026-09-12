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
    ProtocolMethodBinding,
} from "./types";

interface CdpDomain {
    raw: Record<string, unknown>;
    name: string;
}

export function importCdpProtocol(browser: unknown, js: unknown): ProtocolContractImport {
    const diagnostics: ContractImportDiagnostic[] = [];
    const bindings: ProtocolMethodBinding[] = [];
    const domains: CdpDomain[] = [];
    const allSchemas: Record<string, LinkRpcJsonSchema> = {};
    const versions: unknown[] = [];

    for (const [documentName, input] of [["browser", browser], ["js", js]] as const) {
        const document = asRecord(input, documentName);
        versions.push(document.version);
        for (const [index, item] of asArray(document.domains, `${documentName}.domains`).entries()) {
            const raw = asRecord(item, `${documentName}.domains[${index}]`);
            const name = requiredString(raw, "domain", `${documentName}.domains[${index}]`);
            if (domains.some((domain) => domain.name === name)) {
                throw new Error(`duplicate CDP domain ${name}`);
            }
            domains.push({ raw, name });
            for (const [typeIndex, typeValue] of optionalArray(raw.types).entries()) {
                const type = asRecord(typeValue, `${name}.types[${typeIndex}]`);
                const typeName = requiredString(type, "id", `${name}.types[${typeIndex}]`);
                const qualified = `${name}.${typeName}`;
                if (allSchemas[qualified] !== undefined) throw new Error(`duplicate CDP type ${qualified}`);
                allSchemas[qualified] = convertCdpSchema(type, name, diagnostics, qualified);
            }
        }
    }

    const interfaces: ProtocolContractImport["interfaces"] = {};
    for (const { raw, name: domain } of domains) {
        const interfaceId = `cdp.${domain.toLowerCase()}`;
        if (interfaces[interfaceId] !== undefined) {
            throw new Error(`CDP domains collide after normalization: ${interfaceId}`);
        }
        const methods: Record<string, MethodSchema> = {};
        const roots: LinkRpcJsonSchema[] = [];
        for (const [kind, entries] of [
            ["request", optionalArray(raw.commands)],
            ["notification", optionalArray(raw.events)],
        ] as const) {
            for (const [index, entryValue] of entries.entries()) {
                const entry = asRecord(entryValue, `${domain}.${kind}[${index}]`);
                const member = requiredString(entry, "name", `${domain}.${kind}[${index}]`);
                if (member.includes(".") || member.includes("/")) {
                    throw new Error(`CDP member must be local: ${domain}.${member}`);
                }
                if (methods[member] !== undefined) {
                    throw new Error(`duplicate CDP member ${domain}.${member}`);
                }
                const params = fieldsObject(
                    optionalArray(entry.parameters),
                    domain,
                    diagnostics,
                    `${domain}.${member}.params`,
                );
                const method: MethodSchema & Record<string, unknown> = {
                    params,
                    ...(kind === "request" ? {
                        result: fieldsObject(
                            optionalArray(entry.returns),
                            domain,
                            diagnostics,
                            `${domain}.${member}.result`,
                        ),
                    } : {}),
                    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
                    ...(entry.deprecated === true ? { deprecated: true } : {}),
                    "x-protocol": {
                        wireMethod: `${domain}.${member}`,
                        domain,
                        experimental: entry.experimental === true,
                        redirect: entry.redirect,
                    },
                };
                methods[member] = method;
                roots.push(params);
                if (method.result !== undefined) roots.push(method.result);
                bindings.push({
                    wireMethod: `${domain}.${member}`,
                    interfaceId,
                    member,
                    kind,
                    direction: kind === "request" ? "clientToServer" : "serverToClient",
                    source: "cdp",
                });
            }
        }
        const ownTypes = optionalArray(raw.types).map((type, index) =>
            `${domain}.${requiredString(asRecord(type, `${domain}.types[${index}]`), "id", `${domain}.types[${index}]`)}`,
        );
        const schemas = componentClosure(
            allSchemas,
            roots,
            diagnostics,
            interfaceId,
            ownTypes,
        );
        interfaces[interfaceId] = finishInterface({
            id: interfaceId,
            description: typeof raw.description === "string"
                ? raw.description
                : `Chrome DevTools Protocol ${domain} domain.`,
            methods,
            components: { schemas },
            ...({
                "x-protocol": {
                    protocol: "cdp",
                    domain,
                    ...metadataOf(raw, ["experimental", "deprecated", "dependencies"]),
                },
            } as Record<string, unknown>),
        } as Omit<import("@hediet/linkrpc").LinkRpcInterfaceSchema, "hash">);
    }

    return {
        interfaces,
        bindings,
        diagnostics,
        metadata: { protocol: "cdp", versions },
    };
}

function fieldsObject(
    fields: unknown[],
    domain: string,
    diagnostics: ContractImportDiagnostic[],
    path: string,
): LinkRpcJsonSchema {
    const properties: Record<string, LinkRpcJsonSchema> = {};
    const required: string[] = [];
    for (const [index, value] of fields.entries()) {
        const field = asRecord(value, `${path}[${index}]`);
        const name = requiredString(field, "name", `${path}[${index}]`);
        if (properties[name] !== undefined) throw new Error(`duplicate CDP field ${path}.${name}`);
        properties[name] = convertCdpSchema(field, domain, diagnostics, `${path}.${name}`);
        if (field.optional !== true) required.push(name);
    }
    return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
    };
}

function convertCdpSchema(
    raw: Record<string, unknown>,
    domain: string,
    diagnostics: ContractImportDiagnostic[],
    path: string,
): LinkRpcJsonSchema {
    let schema: LinkRpcJsonSchema;
    if (typeof raw.$ref === "string") {
        schema = localRef(raw.$ref.includes(".") ? raw.$ref : `${domain}.${raw.$ref}`);
    } else {
        switch (raw.type) {
            case "object": {
                const props = optionalArray(raw.properties);
                schema = props.length === 0
                    ? { type: "object", properties: {}, additionalProperties: true }
                    : fieldsObject(props, domain, diagnostics, path);
                break;
            }
            case "array":
                schema = {
                    type: "array",
                    items: raw.items === undefined
                        ? approximate(diagnostics, `${path}.items`, "CDP array has no item schema")
                        : convertCdpSchema(asRecord(raw.items, `${path}.items`), domain, diagnostics, `${path}.items`),
                };
                break;
            case "string":
            case "integer":
            case "number":
            case "boolean":
                schema = { type: raw.type };
                break;
            case "any":
            case undefined:
                schema = approximate(diagnostics, path, `CDP ${raw.type ?? "untyped"} value`);
                break;
            default:
                schema = approximate(diagnostics, path, `unsupported CDP type ${String(raw.type)}`);
        }
    }
    if (schema !== true && schema !== false) {
        const result = schema as unknown as Record<string, unknown>;
        if (Array.isArray(raw.enum)) result.enum = raw.enum;
        if (typeof raw.description === "string") result.description = raw.description;
        if (typeof raw.id === "string") result.title = raw.id;
        result["x-protocol"] = {
            ...metadataOf(raw, ["optional", "experimental", "deprecated", "type"]),
            ...(typeof raw.$ref === "string" ? { originalRef: raw.$ref } : {}),
        };
    }
    return schema;
}

function approximate(
    diagnostics: ContractImportDiagnostic[],
    path: string,
    message: string,
): true {
    diagnostics.push({ severity: "warning", path, message, approximation: "true" });
    return true;
}

function optionalArray(value: unknown): unknown[] {
    return value === undefined ? [] : asArray(value, "CDP array");
}
