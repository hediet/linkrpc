import { describe, expect, it } from "vitest";
import type { LinkRpcJsonSchema } from "./linkRpcJsonSchema";
import { componentSchemaRef } from "./assertSchemaReferences";
import { createSchemaToZod, schemaToZod } from "./schemaToZod";
import { z } from "zod";
import { defineInterface } from "../connection/interfaceDefinition";
import { requestType, type Schema } from "./memberTypes";
import { defineInterfaceTemplate } from "./defineInterfaceTemplate";

describe("schemaToZod", () => {
    it("validates reflected recursive JSON template arguments with property-less record schemas", () => {
        const Store = defineInterfaceTemplate({ id: "json", parameters: ["Value"] },
            <V>({ Value }: { Value: Schema<V> }) => ({ get: requestType(z.object({}), Value) }));
        const schema = defineInterface({ id: "json-store" }, {
            json: Store({ Value: z.json() }),
        }).toSchema();
        const validator = createSchemaToZod(schema.components?.schemas).toZod(schema.methods["json$get"]!.result!);
        expect(validator.parse({ sessions: [{ title: "Hello", data: null }], flags: { ready: true } }))
            .toEqual({ sessions: [{ title: "Hello", data: null }], flags: { ready: true } });
        expect(validator.safeParse({ invalid: undefined }).success).toBe(false);
    });

    it("supports nullable primitive type arrays and annotation-only schemas", () => {
        const nullableString = schemaToZod(
            { type: ["string", "null"] } as unknown as LinkRpcJsonSchema,
        );
        expect(nullableString.safeParse("value").success).toBe(true);
        expect(nullableString.safeParse(null).success).toBe(true);
        expect(nullableString.safeParse(1).success).toBe(false);

        const arbitraryJson = schemaToZod(
            { title: "Arbitrary JSON", description: "Any JSON value." } as LinkRpcJsonSchema,
        );
        expect(arbitraryJson.safeParse({ open: ["shape"] }).success).toBe(true);
    });

    it("validates recursive structural components", () => {
        const components: Record<string, LinkRpcJsonSchema> = {
            Node: {
                type: "object",
                properties: {
                    value: {
                        type: "integer",
                        "x-json-schema": { minimum: 0 },
                    },
                    next: { $ref: "#/components/schemas/Node" },
                },
                required: ["value"],
                additionalProperties: false,
            },
        };
        const validator = schemaToZod({ $ref: "#/components/schemas/Node" }, components);
        expect(validator.safeParse({ value: 1, next: { value: 2 } }).success).toBe(true);
        expect(validator.safeParse({ value: -1 }).success).toBe(true);
        expect(validator.safeParse({ value: 1, extra: true }).success).toBe(false);
    });

    it("ignores non-normative rich JSON Schema refinements", () => {
        const impossible = schemaToZod({ type: "string", "x-json-schema": false });
        expect(impossible.safeParse("still structural").success).toBe(true);

        const patterned = schemaToZod({
            type: "string",
            "x-json-schema": { pattern: "^[a-z]+$" },
        });
        expect(patterned.safeParse("NOT-A-MATCH").success).toBe(true);

        const conjunction = schemaToZod({
            type: "integer",
            "x-json-schema": { allOf: [{ type: "string" }] },
        });
        expect(conjunction.safeParse(3).success).toBe(true);
        expect(conjunction.safeParse("3").success).toBe(false);
    });

    it("validates component references at public compilation boundaries", () => {
        expect(() => schemaToZod({ $ref: "#/components/schemas/Missing" })).toThrow(
            "Unresolved component reference",
        );
        expect(() => createSchemaToZod({
            Loop: { $ref: "#/components/schemas/Loop" },
        })).toThrow("Unguarded recursive schema");

        const name = "path/with~token";
        const validator = schemaToZod(
            { $ref: componentSchemaRef(name) },
            { [name]: { type: "string" } },
        );
        expect(validator.safeParse("ok").success).toBe(true);
    });
});
