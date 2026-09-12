import { describe, expect, it } from "vitest";
import type { LinkRpcJsonSchema } from "./linkRpcJsonSchema";
import { materializeJsonSchema } from "./materializeJsonSchema";

describe("materializeJsonSchema", () => {
    it("conjoins refinements and rewrites finite recursive component refs", () => {
        const node: LinkRpcJsonSchema = {
            type: "object",
            properties: {
                value: {
                    type: "integer",
                    "x-json-schema": { minimum: 0 },
                },
                next: { $ref: "#/components/schemas/Node" },
            },
            additionalProperties: false,
        };
        const result = materializeJsonSchema(
            { $ref: "#/components/schemas/Node" },
            { Node: node },
        );
        expect(result.$ref).toBe("#/$defs/Node");
        expect(result.$defs).toEqual({
            Node: {
                type: "object",
                properties: {
                    value: {
                        allOf: [{ type: "integer" }, { minimum: 0 }],
                    },
                    next: { $ref: "#/$defs/Node" },
                },
                additionalProperties: false,
            },
        });
    });

    it("only traverses schema-valued positions in refinements", () => {
        const literal = { $ref: "#/components/schemas/Literal" };
        const result = materializeJsonSchema({
            type: "object",
            properties: {},
            additionalProperties: false,
            "x-json-schema": {
                const: literal,
                enum: [literal],
                default: literal,
                examples: [literal],
                allOf: [{ $ref: "#/components/schemas/Actual" }],
                properties: {
                    nested: { $ref: "#/components/schemas/Actual" },
                },
            },
        });
        expect(result.allOf).toEqual([
            { type: "object", properties: {}, additionalProperties: false },
            {
                const: literal,
                enum: [literal],
                default: literal,
                examples: [literal],
                allOf: [{ $ref: "#/$defs/Actual" }],
                properties: { nested: { $ref: "#/$defs/Actual" } },
            },
        ]);
    });

    it("materializes tuple head length and exactness", () => {
        expect(materializeJsonSchema({
            type: "array",
            prefixItems: [{ type: "string" }, { type: "integer" }],
            items: false,
        })).toMatchObject({ minItems: 2, maxItems: 2 });
        expect(materializeJsonSchema({
            type: "array",
            prefixItems: [{ type: "string" }],
            items: { type: "boolean" },
        })).toMatchObject({ minItems: 1 });
    });

    it("exports structural oneOf as a non-exclusive anyOf", () => {
        const result = materializeJsonSchema({
            oneOf: [
                { type: "number" },
                { type: "integer" },
            ],
        });
        expect(result).toEqual({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            anyOf: [{ type: "number" }, { type: "integer" }],
        });
        expect(result).not.toHaveProperty("oneOf");
    });

    it("preserves exclusive unions and tuple semantics inside rich refinements", () => {
        const result = materializeJsonSchema({
            type: "array",
            items: true,
            "x-json-schema": {
                oneOf: [
                    {
                        type: "array",
                        prefixItems: [
                            {
                                type: "string",
                                "x-json-schema": {
                                    minLength: 1,
                                    allOf: [{ $ref: "#/components/schemas/Nested" }],
                                },
                            },
                        ],
                    },
                    { type: "array", maxItems: 0 },
                ],
            },
        });
        expect(result.allOf).toEqual([
            { type: "array", items: true },
            {
                oneOf: [
                    {
                        type: "array",
                        prefixItems: [{
                            type: "string",
                            "x-json-schema": {
                                minLength: 1,
                                allOf: [{ $ref: "#/$defs/Nested" }],
                            },
                        }],
                    },
                    { type: "array", maxItems: 0 },
                ],
            },
        ]);
        const refinement = (result.allOf as Record<string, unknown>[])[1]!;
        const first = (refinement.oneOf as Record<string, unknown>[])[0]!;
        expect(first).not.toHaveProperty("minItems");
        expect(first).not.toHaveProperty("maxItems");
    });
});
