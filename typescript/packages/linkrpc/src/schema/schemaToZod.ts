import { z } from "zod";
import {
    assertSchemaReferences,
    componentSchemaName,
} from "./assertSchemaReferences";
import type { LinkRpcJsonSchema } from "./linkRpcJsonSchema";

export interface SchemaToZodContext {
    readonly toZod: (schema: LinkRpcJsonSchema) => z.ZodType<unknown>;
}

/**
 * Create a recursive LinkRPC-schema validator materializer. Component
 * references are lazy, so self and mutual recursion remain guarded.
 */
export function createSchemaToZod(
    components: Record<string, LinkRpcJsonSchema> = {},
): SchemaToZodContext {
    assertSchemaReferences([], components);
    const refs = new Map<string, z.ZodType<unknown>>();
    const component = (name: string): z.ZodType<unknown> => {
        const existing = refs.get(name);
        if (existing !== undefined) return existing;
        const source = components[name];
        if (source === undefined) throw new Error(`schemaToZod: dangling component reference "${name}"`);
        const lazy: z.ZodType<unknown> = z.lazy(() => compile(source));
        refs.set(name, lazy);
        return lazy;
    };

    const compile = (schema: LinkRpcJsonSchema): z.ZodType<unknown> => {
        if (schema === true) return z.unknown();
        if (schema === false) return z.never();
        const raw = schema as unknown as Record<string, unknown>;
        if (Array.isArray(raw.type)) {
            return union(raw.type.map((type) =>
                compile({ ...raw, type } as unknown as LinkRpcJsonSchema)
            ));
        }
        let base: z.ZodType<unknown>;
        if ("$ref" in schema) {
            base = component(componentSchemaName(schema.$ref));
        } else if ("const" in schema) {
            base = valueSchema(schema.const);
        } else if ("enum" in schema) {
            base = union(schema.enum.map(valueSchema));
        } else if ("anyOf" in schema) {
            base = union(schema.anyOf.map(compile));
        } else if ("oneOf" in schema) {
            // LinkRPC's normative structural semantics treat oneOf as a union;
            // exclusivity is only available through rich JSON Schema export.
            base = union(schema.oneOf.map(compile));
        } else if (isAnnotationOnlySchema(raw)) {
            base = z.unknown();
        } else {
            switch (schema.type) {
                case "null":
                    base = z.null();
                    break;
                case "boolean":
                    base = z.boolean();
                    break;
                case "string":
                    base = stringSchema(schema.format);
                    break;
                case "integer":
                    base = z.number().int();
                    break;
                case "number":
                    base = z.number();
                    break;
                case "array":
                    if ("prefixItems" in schema) {
                        const tuple = z.tuple(schema.prefixItems.map(compile) as [
                            z.ZodType<unknown>,
                            ...z.ZodType<unknown>[],
                        ]);
                        base = schema.items !== undefined && schema.items !== false
                            ? tuple.rest(compile(schema.items))
                            : tuple;
                    } else {
                        base = z.array(compile(schema.items));
                    }
                    break;
                case "object": {
                    const required = new Set(schema.required ?? []);
                    const shape: Record<string, z.ZodType<unknown>> = {};
                    for (const [name, property] of Object.entries(schema.properties)) {
                        const validator = compile(property);
                        shape[name] = required.has(name) ? validator : validator.optional();
                    }
                    const object = z.object(shape);
                    if (schema.additionalProperties === false) {
                        base = object.strict();
                    } else if (schema.additionalProperties === true) {
                        base = object.loose();
                    } else {
                        base = object.catchall(compile(schema.additionalProperties));
                    }
                    break;
                }
            }
        }
        return base;
    };
    return {
        toZod(schema): z.ZodType<unknown> {
            assertSchemaReferences([schema], components);
            return compile(schema);
        },
    };
}

function isAnnotationOnlySchema(schema: Record<string, unknown>): boolean {
    const structuralKeys = [
        "$ref", "const", "enum", "anyOf", "oneOf", "type",
        "properties", "items", "prefixItems", "additionalProperties",
    ];
    return !structuralKeys.some((key) => Object.hasOwn(schema, key));
}

export function schemaToZod(
    schema: LinkRpcJsonSchema,
    components: Record<string, LinkRpcJsonSchema> = {},
): z.ZodType<unknown> {
    return createSchemaToZod(components).toZod(schema);
}

function union(items: z.ZodType<unknown>[]): z.ZodType<unknown> {
    if (items.length === 0) return z.never();
    if (items.length === 1) return items[0]!;
    return z.union(items as [z.ZodType<unknown>, z.ZodType<unknown>, ...z.ZodType<unknown>[]]);
}

function valueSchema(expected: import("../protocol/jsonValue").JsonValue): z.ZodType<unknown> {
    return z.unknown().refine((actual) => jsonValueEqual(actual, expected), {
        message: `Expected ${JSON.stringify(expected)}`,
    });
}

function jsonValueEqual(actual: unknown, expected: unknown): boolean {
    if (Object.is(actual, expected)) return true;
    if (Array.isArray(actual) && Array.isArray(expected)) {
        return actual.length === expected.length &&
            actual.every((value, index) => jsonValueEqual(value, expected[index]));
    }
    if (
        actual !== null && expected !== null &&
        typeof actual === "object" && typeof expected === "object" &&
        !Array.isArray(actual) && !Array.isArray(expected)
    ) {
        const actualRecord = actual as Record<string, unknown>;
        const expectedRecord = expected as Record<string, unknown>;
        const keys = Object.keys(actualRecord);
        return keys.length === Object.keys(expectedRecord).length &&
            keys.every((key) =>
                Object.hasOwn(expectedRecord, key) &&
                jsonValueEqual(actualRecord[key], expectedRecord[key])
            );
    }
    return false;
}

function stringSchema(format: string | undefined): z.ZodType<unknown> {
    switch (format) {
        case "email": return z.email();
        case "uri":
        case "url": return z.url();
        case "uuid": return z.uuid();
        case "date-time": return z.iso.datetime();
        default: return z.string();
    }
}
