import { describe, it, expect } from "vitest";
import { isAssignable, matchesJsonSchema, validateJsonSchema } from "./assignability";
import type { LinkRpcJsonSchema } from "./linkRpcJsonSchema";

describe("JSON schema diagnostics", () => {
    it("reports nested union issues as JSON Pointers without leaking failed alternatives on success", () => {
        const schema: LinkRpcJsonSchema = { anyOf: [
            { type: "object", properties: { "a/b": { type: "number" } },
                required: ["a/b"], additionalProperties: false },
            { type: "null" },
        ] };
        expect(validateJsonSchema({ "a/b": false }, schema)).toEqual([
            { path: "/a~1b", message: "Expected number" },
            { path: "", message: "Expected null" },
        ]);
        expect(validateJsonSchema(null, schema)).toEqual([]);
        expect(matchesJsonSchema(null, schema)).toBe(true);
    });

    it("supports escaped references, type arrays, and annotation-only schemas", () => {
        expect(validateJsonSchema(3, { $ref: "#/components/schemas/a~1b~0c" },
            { schemas: { "a/b~c": { type: "number" } } })).toEqual([]);
        const nullable = { type: ["string", "null"] } as unknown as LinkRpcJsonSchema;
        expect(validateJsonSchema(null, nullable)).toEqual([]);
        expect(matchesJsonSchema(null, nullable)).toBe(true);
        expect(validateJsonSchema(3, { description: "any JSON" } as LinkRpcJsonSchema)).toEqual([]);
    });

    it("requires tuple prefix items and explicitly required unknown object properties", () => {
        const tuple: LinkRpcJsonSchema = { type: "array", prefixItems: [true], items: true };
        expect(validateJsonSchema([], tuple)).toEqual([{ path: "", message: "Expected at least 1 items" }]);
        expect(matchesJsonSchema([], tuple)).toBe(false);
        const object: LinkRpcJsonSchema = { type: "object", properties: { data: true },
            required: ["data"], additionalProperties: false };
        expect(validateJsonSchema({}, object)).toEqual([{ path: "/data", message: "Required property is missing" }]);
        expect(validateJsonSchema({ data: null }, object)).toEqual([]);
    });
});

describe("isAssignable — primitives & top/bottom", () => {
    it("anything <: true", () => {
        expect(isAssignable({ type: "string" }, true)).toBe(true);
        expect(isAssignable(false, true)).toBe(true);
    });
    it("false <: anything", () => {
        expect(isAssignable(false, { type: "string" })).toBe(true);
    });
    it("true </: non-top", () => {
        expect(isAssignable(true, { type: "string" })).toBe(false);
    });
    it("integer <: number", () => {
        expect(isAssignable({ type: "integer" }, { type: "number" })).toBe(true);
        expect(isAssignable({ type: "number" }, { type: "integer" })).toBe(false);
    });
    it("type mismatch", () => {
        expect(isAssignable({ type: "string" }, { type: "number" })).toBe(false);
    });
});

describe("isAssignable — strings + format", () => {
    it("dropping format widens", () => {
        expect(isAssignable({ type: "string", format: "email" }, { type: "string" })).toBe(true);
    });
    it("adding format narrows", () => {
        expect(isAssignable({ type: "string" }, { type: "string", format: "email" })).toBe(false);
    });
    it("different formats are incomparable", () => {
        expect(isAssignable(
            { type: "string", format: "email" },
            { type: "string", format: "uri" },
        )).toBe(false);
    });
});

describe("isAssignable — const & enum", () => {
    it("matches recursive JSON values and terminates on unguarded references", () => {
        const reference = { $ref: "#/components/schemas/Node" };
        const components = { schemas: { Node: {
            type: "object",
            properties: { children: { type: "array", items: reference } },
            required: ["children"],
            additionalProperties: false,
        } } } satisfies import("./assignability").Components;
        expect(matchesJsonSchema({ children: [{ children: [] }] }, reference, components)).toBe(true);
        expect(matchesJsonSchema({ children: [{ extra: true }] }, reference, components)).toBe(false);
        expect(matchesJsonSchema(null, reference, { schemas: { Node: reference } })).toBe(false);
    });
    it("matches object values using own JSON properties, not prototypes", () => {
        expect(isAssignable({ const: {} }, {
            type: "object",
            properties: { constructor: true },
            required: ["constructor"],
            additionalProperties: false,
        })).toBe(false);
        expect(isAssignable({ const: { toString: "value" } }, {
            type: "object",
            properties: {},
            additionalProperties: true,
        })).toBe(true);
    });
    it("const <: enum containing it", () => {
        expect(isAssignable({ const: "a" }, { enum: ["a", "b"] })).toBe(true);
    });
    it("enum subset <: enum superset", () => {
        expect(isAssignable({ enum: ["a"] }, { enum: ["a", "b"] })).toBe(true);
        expect(isAssignable({ enum: ["a", "c"] }, { enum: ["a", "b"] })).toBe(false);
    });
    it("const <: matching primitive type", () => {
        expect(isAssignable({ const: "hi" }, { type: "string" })).toBe(true);
        expect(isAssignable({ const: 1 }, { type: "integer" })).toBe(true);
        expect(isAssignable({ const: 1.5 }, { type: "integer" })).toBe(false);
    });
});

describe("isAssignable — union distribution", () => {
    it("union sub: all branches must <: sup", () => {
        expect(isAssignable(
            { anyOf: [{ type: "string" }, { type: "number" }] },
            { anyOf: [{ type: "string" }, { type: "number" }] },
        )).toBe(true);
        expect(isAssignable(
            { anyOf: [{ type: "string" }, { type: "boolean" }] },
            { anyOf: [{ type: "string" }, { type: "number" }] },
        )).toBe(false);
    });
    it("union sup: at least one branch must accept", () => {
        expect(isAssignable(
            { type: "string" },
            { anyOf: [{ type: "string" }, { type: "number" }] },
        )).toBe(true);
    });
    it("oneOf is treated identically to anyOf for assignability", () => {
        expect(isAssignable(
            { oneOf: [{ type: "string" }, { type: "number" }] },
            { anyOf: [{ type: "string" }, { type: "number" }] },
        )).toBe(true);
        expect(isAssignable(
            { type: "string" },
            { oneOf: [{ type: "string" }, { type: "number" }] },
        )).toBe(true);
        expect(isAssignable(
            { oneOf: [{ type: "string" }, { type: "boolean" }] },
            { anyOf: [{ type: "string" }, { type: "number" }] },
        )).toBe(false);
    });
});

describe("isAssignable — arrays & tuples", () => {
    it("array items widening", () => {
        expect(isAssignable(
            { type: "array", items: { type: "integer" } },
            { type: "array", items: { type: "number" } },
        )).toBe(true);
    });
    it("tuple <: tuple element-wise", () => {
        const sub: LinkRpcJsonSchema = { type: "array", prefixItems: [{ type: "integer" }, { type: "string" }], items: false };
        const sup: LinkRpcJsonSchema = { type: "array", prefixItems: [{ type: "number" }, { type: "string" }], items: false };
        expect(isAssignable(sub, sup)).toBe(true);
    });
    it("bounded tuple <: unbounded array of widening type", () => {
        const sub: LinkRpcJsonSchema = { type: "array", prefixItems: [{ type: "integer" }], items: false };
        const sup: LinkRpcJsonSchema = { type: "array", items: { type: "number" } };
        expect(isAssignable(sub, sup)).toBe(true);
    });
});

describe("isAssignable — objects", () => {
    const open = (props: Record<string, LinkRpcJsonSchema>, req?: string[]): LinkRpcJsonSchema => ({
        type: "object", properties: props, required: req, additionalProperties: true,
    });
    const closed = (props: Record<string, LinkRpcJsonSchema>, req?: string[]): LinkRpcJsonSchema => ({
        type: "object", properties: props, required: req, additionalProperties: false,
    });

    it("matching closed objects", () => {
        expect(isAssignable(
            closed({ a: { type: "string" } }, ["a"]),
            closed({ a: { type: "string" } }, ["a"]),
        )).toBe(true);
    });

    it("sub adds extra required prop, sup is closed => not assignable", () => {
        expect(isAssignable(
            closed({ a: { type: "string" }, b: { type: "string" } }, ["a", "b"]),
            closed({ a: { type: "string" } }, ["a"]),
        )).toBe(false);
    });

    it("sub adds extra required prop, sup is open with compatible additionalProperties", () => {
        expect(isAssignable(
            closed({ a: { type: "string" }, b: { type: "string" } }, ["a", "b"]),
            open({ a: { type: "string" } }, ["a"]),
        )).toBe(true);
    });

    it("sup requires a prop that sub doesn't => not assignable", () => {
        expect(isAssignable(
            closed({ a: { type: "string" } }),
            closed({ a: { type: "string" } }, ["a"]),
        )).toBe(false);
    });

    it("prop value widening", () => {
        expect(isAssignable(
            closed({ x: { type: "integer" } }, ["x"]),
            closed({ x: { type: "number" } }, ["x"]),
        )).toBe(true);
    });
});

describe("isAssignable — refs & cycles", () => {
    it("resolves $ref", () => {
        const components = {
            schemas: {
                Foo: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } as LinkRpcJsonSchema,
            },
        };
        expect(isAssignable(
            { $ref: "#/components/schemas/Foo" },
            { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false },
            components,
        )).toBe(true);
    });

    it("breaks cycles", () => {
        const components = {
            schemas: {
                Node: {
                    type: "object",
                    properties: { next: { $ref: "#/components/schemas/Node" } },
                    additionalProperties: false,
                } as LinkRpcJsonSchema,
            },
        };
        expect(isAssignable(
            { $ref: "#/components/schemas/Node" },
            { $ref: "#/components/schemas/Node" },
            components,
        )).toBe(true);
    });
});
