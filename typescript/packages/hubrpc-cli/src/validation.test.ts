import { describe, it, expect } from "vitest";
import {
    describeObjectParams,
    describeSchema,
    explainValidation,
    validateValueAgainstSchema,
    valueToConstSchema,
} from "./validation";
import type { HubRpcJsonSchema as SvcJsonSchema } from "@vscode/hubrpc";

describe("validateValueAgainstSchema", () => {
    it("accepts a value that matches the target schema", () => {
        expect(validateValueAgainstSchema("hi", { type: "string" })).toBeUndefined();
        expect(validateValueAgainstSchema(42, { type: "integer" })).toBeUndefined();
        expect(validateValueAgainstSchema(false, { type: "boolean" })).toBeUndefined();
    });

    it("rejects a value that doesn't match", () => {
        expect(validateValueAgainstSchema(42, { type: "string" })).toMatch(/does not match/);
        expect(validateValueAgainstSchema("nope", { type: "boolean" })).toMatch(/does not match/);
    });

    it("resolves component references", () => {
        const components = {
            Input: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
                additionalProperties: false,
            },
        } satisfies Record<string, SvcJsonSchema>;
        const ref: SvcJsonSchema = { $ref: "#/components/schemas/Input" };

        expect(validateValueAgainstSchema({ name: "alice" }, ref, components)).toBeUndefined();
        expect(validateValueAgainstSchema({ name: 42 }, ref, components)).toMatch(/does not match/);
    });

    it("checks object property types and required-ness", () => {
        const schema = {
            type: "object" as const,
            properties: { name: { type: "string" } as const, age: { type: "integer" } as const },
            required: ["name"],
            additionalProperties: false,
        };
        expect(validateValueAgainstSchema({ name: "alice" }, schema)).toBeUndefined();
        expect(validateValueAgainstSchema({ name: "alice", age: 30 }, schema)).toBeUndefined();
        expect(validateValueAgainstSchema({ age: 30 }, schema)).toMatch(/does not match/);
        expect(validateValueAgainstSchema({ name: 42 }, schema)).toMatch(/does not match/);
    });
});

describe("valueToConstSchema", () => {
    it("produces a const schema for primitives", () => {
        expect(valueToConstSchema("hi")).toEqual({ const: "hi" });
        expect(valueToConstSchema(42)).toEqual({ const: 42 });
        expect(valueToConstSchema(null)).toEqual({ const: null });
    });

    it("produces a closed object schema for records", () => {
        expect(valueToConstSchema({ a: 1, b: "x" })).toEqual({
            type: "object",
            properties: { a: { const: 1 }, b: { const: "x" } },
            required: ["a", "b"],
            additionalProperties: false,
        });
    });

    it("produces an exact-length tuple for arrays", () => {
        expect(valueToConstSchema([1, "a"])).toEqual({
            type: "array",
            prefixItems: [{ const: 1 }, { const: "a" }],
            items: false,
        });
    });
});

// ---------------------------------------------------------------------------
// explainValidation
// ---------------------------------------------------------------------------

const SEARCH_PARAMS: SvcJsonSchema = {
    type: "object",
    properties: {
        query: { type: "string", description: "The text to search for" },
        limit: { type: "integer", description: "Maximum results (default 30)" },
        state: { enum: ["open", "closed", "all"] },
        labels: { type: "array", items: { type: "string" } },
    },
    required: ["query"],
    additionalProperties: false,
};

describe("explainValidation", () => {
    it("returns [] when the value is valid", () => {
        expect(explainValidation({ query: "bug" }, SEARCH_PARAMS)).toEqual([]);
    });

    it("flags a missing required property with a type hint", () => {
        expect(explainValidation({}, SEARCH_PARAMS)).toEqual([
            { path: ".query", reason: "required (string), but missing" },
        ]);
    });

    it("flags a wrong primitive type and shows the actual value", () => {
        expect(explainValidation({ query: "bug", limit: "10" }, SEARCH_PARAMS)).toEqual([
            { path: ".limit", reason: `expected integer, got string ("10")` },
        ]);
    });

    it("flags non-matching enum values with the allowed options", () => {
        expect(explainValidation({ query: "bug", state: "weird" }, SEARCH_PARAMS)).toEqual([
            {
                path: ".state",
                reason: `expected one of "open" | "closed" | "all", got string ("weird")`,
            },
        ]);
    });

    it("flags unknown properties when additionalProperties is false", () => {
        expect(explainValidation({ query: "bug", foo: 1 }, SEARCH_PARAMS)).toEqual([
            { path: ".foo", reason: "unknown property" },
        ]);
    });

    it("walks into array items", () => {
        expect(
            explainValidation({ query: "bug", labels: ["a", 1, "c"] }, SEARCH_PARAMS),
        ).toEqual([
            { path: ".labels[1]", reason: `expected string, got number (1)` },
        ]);
    });

    it("reports object-vs-scalar mismatches at root", () => {
        expect(explainValidation("hi", SEARCH_PARAMS)).toEqual([
            { path: "(root)", reason: `expected object, got string ("hi")` },
        ]);
    });

    it("collects multiple issues in one pass", () => {
        const issues = explainValidation({ limit: "10", state: "weird" }, SEARCH_PARAMS);
        expect(issues).toEqual([
            { path: ".query", reason: "required (string), but missing" },
            { path: ".limit", reason: `expected integer, got string ("10")` },
            {
                path: ".state",
                reason: `expected one of "open" | "closed" | "all", got string ("weird")`,
            },
        ]);
    });

    it("picks the best union branch heuristically", () => {
        const schema: SvcJsonSchema = {
            anyOf: [
                {
                    type: "object",
                    properties: { kind: { const: "a" }, n: { type: "number" } },
                    required: ["kind", "n"],
                    additionalProperties: false,
                },
                {
                    type: "object",
                    properties: { kind: { const: "b" }, s: { type: "string" } },
                    required: ["kind", "s"],
                    additionalProperties: false,
                },
            ],
        };
        // closer to branch "a": kind matches, n wrong type
        expect(explainValidation({ kind: "a", n: "x" }, schema)).toEqual([
            { path: ".n", reason: `expected number, got string ("x")` },
        ]);
    });

    it("uses bracket notation for non-identifier keys", () => {
        const schema: SvcJsonSchema = {
            type: "object",
            properties: { "weird key": { type: "string" } },
            required: ["weird key"],
            additionalProperties: false,
        };
        expect(explainValidation({ "weird key": 1 }, schema)).toEqual([
            { path: `["weird key"]`, reason: `expected string, got number (1)` },
        ]);
    });
});

// ---------------------------------------------------------------------------
// describeSchema / describeObjectParams
// ---------------------------------------------------------------------------

describe("describeSchema", () => {
    it("prints primitives", () => {
        expect(describeSchema({ type: "string" })).toBe("string");
        expect(describeSchema({ type: "integer" })).toBe("integer");
        expect(describeSchema({ type: "boolean" })).toBe("boolean");
    });

    it("prints enums and consts", () => {
        expect(describeSchema({ enum: ["a", "b", "c"] })).toBe(`"a" | "b" | "c"`);
        expect(describeSchema({ const: 42 })).toBe("42");
    });

    it("prints array shapes", () => {
        expect(describeSchema({ type: "array", items: { type: "string" } })).toBe("string[]");
        expect(
            describeSchema({
                type: "array",
                prefixItems: [{ type: "string" }, { type: "integer" }],
                items: false,
            }),
        ).toBe("[string, integer]");
    });

    it("prints small object shapes inline", () => {
        expect(
            describeSchema({
                type: "object",
                properties: { a: { type: "string" }, b: { type: "integer" } },
                required: ["a"],
                additionalProperties: false,
            }),
        ).toBe("{ a: string; b?: integer }");
    });
});

describe("describeObjectParams", () => {
    it("renders the params table with descriptions", () => {
        expect(describeObjectParams(SEARCH_PARAMS)).toBe(
            [
                `  query   string                     required  The text to search for`,
                `  limit   integer                    optional  Maximum results (default 30)`,
                `  state   "open" | "closed" | "all"  optional`,
                `  labels  string[]                   optional`,
            ].join("\n"),
        );
    });

    it("returns undefined for non-object schemas", () => {
        expect(describeObjectParams({ type: "string" })).toBeUndefined();
    });

    it("reports `(no params)` for an empty object schema", () => {
        expect(
            describeObjectParams({
                type: "object",
                properties: {},
                additionalProperties: false,
            }),
        ).toBe("(no params)");
    });
});
