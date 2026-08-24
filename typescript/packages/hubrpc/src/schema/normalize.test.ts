import { describe, it, expect } from "vitest";
import { z } from "zod";
import { normalizeJsonSchema } from "./normalize";
import { requestType, zodToSvcJsonSchema } from "./memberTypes";
import { defineInterface } from "../connection/interfaceDefinition";

describe("normalizeJsonSchema", () => {
    it("collapses {} to true", () => {
        expect(normalizeJsonSchema({})).toBe(true);
    });

    it("treats {not: {}} as bottom (false)", () => {
        expect(normalizeJsonSchema({ not: {} })).toBe(false);
    });

    it("strips out-of-subset refinement keys", () => {
        const raw = {
            type: "string",
            pattern: "^x",
            minLength: 1,
            maxLength: 99,
            format: "email",
        };
        expect(normalizeJsonSchema(raw)).toEqual({ type: "string", format: "email" });
    });

    it("strips annotation-only keys", () => {
        const raw = {
            type: "integer",
            examples: [1, 2],
            default: 0,
            $comment: "hi",
        };
        expect(normalizeJsonSchema(raw)).toEqual({ type: "integer" });
    });

    it("defaults additionalProperties to false on objects", () => {
        const raw = { type: "object", properties: { a: { type: "string" } } };
        expect(normalizeJsonSchema(raw)).toEqual({
            type: "object",
            properties: { a: { type: "string" } },
            additionalProperties: false,
        });
    });

    it("sorts `required` for canonical output", () => {
        const raw = {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "string" } },
            required: ["b", "a"],
            additionalProperties: false,
        };
        const n = normalizeJsonSchema(raw) as { required: string[] };
        expect(n.required).toEqual(["a", "b"]);
    });

    it("recurses into anyOf, items, properties, prefixItems", () => {
        const raw = {
            anyOf: [
                {},
                { type: "string", pattern: "x" },
                { type: "array", items: { type: "number", multipleOf: 2 } },
                {
                    type: "array",
                    prefixItems: [{ type: "string" }, {}],
                    items: false,
                },
            ],
        };
        expect(normalizeJsonSchema(raw)).toEqual({
            anyOf: [
                true,
                { type: "string" },
                { type: "array", items: { type: "number" } },
                { type: "array", prefixItems: [{ type: "string" }, true], items: false },
            ],
        });
    });
});

describe("zodToSvcJsonSchema (post-normalization)", () => {
    it("produces a normalized object schema", () => {
        const s = zodToSvcJsonSchema(z.object({ name: z.string(), age: z.number().optional() }));
        expect(s).toEqual({
            type: "object",
            properties: { name: { type: "string" }, age: { type: "number" } },
            required: ["name"],
            additionalProperties: false,
        });
    });

    it("normalizes z.unknown to top (true)", () => {
        expect(zodToSvcJsonSchema(z.unknown())).toBe(true);
    });

    it("normalizes z.union into anyOf", () => {
        const s = zodToSvcJsonSchema(z.union([z.string(), z.number()]));
        expect(s).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
    });

    it("preserves oneOf from z.discriminatedUnion and synthesizes a discriminator", () => {
        const s = zodToSvcJsonSchema(z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("a"), x: z.number() }),
            z.object({ kind: z.literal("b"), y: z.string() }),
        ]));
        expect(s).toEqual({
            oneOf: [
                {
                    type: "object",
                    properties: {
                        kind: { type: "string", const: "a" },
                        x: { type: "number" },
                    },
                    required: ["kind", "x"],
                    additionalProperties: false,
                },
                {
                    type: "object",
                    properties: {
                        kind: { type: "string", const: "b" },
                        y: { type: "string" },
                    },
                    required: ["kind", "y"],
                    additionalProperties: false,
                },
            ],
            discriminator: { propertyName: "kind" },
        });
    });

    it("does not synthesize a discriminator when no property is a distinct const on every branch", () => {
        const s = normalizeJsonSchema({
            oneOf: [
                {
                    type: "object",
                    properties: { kind: { type: "string", const: "a" } },
                    required: ["kind"],
                    additionalProperties: false,
                },
                {
                    type: "object",
                    // Same const => not a real discriminator.
                    properties: { kind: { type: "string", const: "a" } },
                    required: ["kind"],
                    additionalProperties: false,
                },
            ],
        });
        expect(s).not.toHaveProperty("discriminator");
    });

    it("strips an orphan discriminator (no oneOf)", () => {
        const s = normalizeJsonSchema({
            type: "string",
            discriminator: { propertyName: "kind" },
        });
        expect(s).toEqual({ type: "string" });
    });

    it("preserves an explicit discriminator and drops openapi `mapping` extras", () => {
        const s = normalizeJsonSchema({
            oneOf: [
                {
                    type: "object",
                    properties: { tag: { type: "string", const: "x" } },
                    required: ["tag"],
                    additionalProperties: false,
                },
                {
                    type: "object",
                    properties: { tag: { type: "string", const: "y" } },
                    required: ["tag"],
                    additionalProperties: false,
                },
            ],
            discriminator: { propertyName: "tag", mapping: { x: "#/X" } },
        });
        expect((s as { discriminator: unknown }).discriminator).toEqual({ propertyName: "tag" });
    });

    it("hoists recursive Zod definitions into interface components", () => {
        const definition = defineInterface(
            { id: "test.json" },
            {
                echo: requestType(
                    z.object({ value: z.json() }),
                    z.object({ value: z.json() }),
                ),
            },
        );
        const schema = definition.toSchema();

        expect({
            methods: schema.methods,
            components: schema.components,
        }).toMatchInlineSnapshot(`
          {
            "components": {
              "schemas": {
                "method=echo&schema=params&def=__schema0": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "number",
                    },
                    {
                      "type": "boolean",
                    },
                    {
                      "type": "null",
                    },
                    {
                      "items": {
                        "$ref": "#/components/schemas/method=echo&schema=params&def=__schema0",
                      },
                      "type": "array",
                    },
                    {
                      "additionalProperties": {
                        "$ref": "#/components/schemas/method=echo&schema=params&def=__schema0",
                      },
                      "type": "object",
                    },
                  ],
                },
                "method=echo&schema=result&def=__schema0": {
                  "anyOf": [
                    {
                      "type": "string",
                    },
                    {
                      "type": "number",
                    },
                    {
                      "type": "boolean",
                    },
                    {
                      "type": "null",
                    },
                    {
                      "items": {
                        "$ref": "#/components/schemas/method=echo&schema=result&def=__schema0",
                      },
                      "type": "array",
                    },
                    {
                      "additionalProperties": {
                        "$ref": "#/components/schemas/method=echo&schema=result&def=__schema0",
                      },
                      "type": "object",
                    },
                  ],
                },
              },
            },
            "methods": {
              "echo": {
                "params": {
                  "additionalProperties": false,
                  "properties": {
                    "value": {
                      "$ref": "#/components/schemas/method=echo&schema=params&def=__schema0",
                    },
                  },
                  "required": [
                    "value",
                  ],
                  "type": "object",
                },
                "result": {
                  "additionalProperties": false,
                  "properties": {
                    "value": {
                      "$ref": "#/components/schemas/method=echo&schema=result&def=__schema0",
                    },
                  },
                  "required": [
                    "value",
                  ],
                  "type": "object",
                },
              },
            },
          }
        `);
    });

    it("hoists a recursive schema root into an interface component", () => {
        type Node = {
            readonly value: string;
            readonly child?: Node;
        };
        const nodeSchema: z.ZodType<Node> = z.lazy(() => z.object({
            value: z.string(),
            child: nodeSchema.optional(),
        }));
        const definition = defineInterface(
            { id: "test.node" },
            { read: requestType(nodeSchema, z.string()) },
        );
        const schema = definition.toSchema();

        expect({
            method: schema.methods.read,
            components: schema.components,
        }).toMatchInlineSnapshot(`
          {
            "components": {
              "schemas": {
                "method=read&schema=params&root": {
                  "additionalProperties": false,
                  "properties": {
                    "child": {
                      "$ref": "#/components/schemas/method=read&schema=params&root",
                    },
                    "value": {
                      "type": "string",
                    },
                  },
                  "required": [
                    "value",
                  ],
                  "type": "object",
                },
              },
            },
            "method": {
              "params": {
                "$ref": "#/components/schemas/method=read&schema=params&root",
              },
              "result": {
                "type": "string",
              },
            },
          }
        `);
    });
});
