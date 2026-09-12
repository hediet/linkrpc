import type { LinkRpcJsonSchema } from "./linkRpcJsonSchema";

export interface MaterializedJsonSchema {
    $schema: "https://json-schema.org/draft/2020-12/schema";
    $defs?: Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * Export a LinkRPC schema and its components as standalone JSON Schema
 * draft 2020-12. Node-local `x-json-schema` constraints are conjoined via
 * `allOf`, so a refinement cannot accidentally override the wire contract.
 *
 * References are rewritten rather than dereferenced. Consequently recursive
 * and mutually-recursive component graphs are materialized in finite time.
 */
export function materializeJsonSchema(
    root: LinkRpcJsonSchema,
    components: Record<string, LinkRpcJsonSchema> = {},
): MaterializedJsonSchema {
    const materialized = materializeNode(root);
    const rootObject: Record<string, unknown> =
        typeof materialized === "boolean" ? { allOf: [materialized] } : materialized;
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...rootObject,
        ...(Object.keys(components).length === 0 ? {} : {
            $defs: Object.fromEntries(
                Object.entries(components).map(([name, schema]) => [name, materializeNode(schema)]),
            ),
        }),
    };
}

function materializeNode(value: unknown): boolean | Record<string, unknown> {
    if (typeof value === "boolean") return value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("materializeJsonSchema: expected a JSON Schema node");
    }
    const input = value as Record<string, unknown>;
    const refinement = input["x-json-schema"];
    const base: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
        if (key === "x-json-schema") continue;
        if (key === "$ref" && typeof child === "string") {
            base.$ref = rewriteRef(child);
        } else if (key === "properties" && isRecord(child)) {
            base.properties = Object.fromEntries(
                Object.entries(child).map(([name, schema]) => [name, materializeNode(schema)]),
            );
        } else if (key === "items" || key === "additionalProperties") {
            base[key] = typeof child === "boolean" ? child : materializeNode(child);
        } else if (key === "prefixItems" || key === "anyOf" || key === "oneOf") {
            const outputKey = key === "oneOf" ? "anyOf" : key;
            base[outputKey] = Array.isArray(child) ? child.map(materializeNode) : child;
        } else {
            base[key] = child;
        }
    }
    if (input.type === "array" && Array.isArray(input.prefixItems)) {
        base.minItems = input.prefixItems.length;
        if (input.items === undefined || input.items === false) {
            base.maxItems = input.prefixItems.length;
        }
    }
    if (refinement === undefined) return base;
    if (typeof refinement !== "boolean" && !isRecord(refinement)) {
        throw new Error("materializeJsonSchema: x-json-schema must be a boolean or object");
    }
    return { allOf: [base, materializeGeneralSchema(refinement)] };
}

function materializeGeneralSchema(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === "$ref" && typeof child === "string") {
            result[key] = rewriteRef(child);
        } else if (key === "x-json-schema") {
            result[key] = materializeGeneralSchema(child);
        } else if (schemaMapKeywords.has(key) && isRecord(child)) {
            result[key] = Object.fromEntries(
                Object.entries(child).map(([name, schema]) => [name, materializeGeneralSchema(schema)]),
            );
        } else if (schemaArrayKeywords.has(key) && Array.isArray(child)) {
            result[key] = child.map(materializeGeneralSchema);
        } else if (schemaKeywords.has(key)) {
            result[key] = materializeGeneralSchema(child);
        } else {
            // Keywords such as const/default/examples carry JSON payloads.
            result[key] = child;
        }
    }
    return result;
}

const schemaMapKeywords = new Set([
    "$defs", "definitions", "properties", "patternProperties", "dependentSchemas",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaKeywords = new Set([
    "additionalProperties", "contains", "contentSchema", "else", "if", "items",
    "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties",
]);

function rewriteRef(ref: string): string {
    const prefix = "#/components/schemas/";
    return ref.startsWith(prefix) ? `#/$defs/${ref.slice(prefix.length)}` : ref;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
