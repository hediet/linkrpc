import { describe, expect, it } from "vitest";
import type { LinkRpcJsonSchema } from "./linkRpcJsonSchema";
import { componentSchemaRef } from "./assertSchemaReferences";
import { createSchemaToZod, schemaToZod } from "./schemaToZod";

describe("schemaToZod", () => {
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
