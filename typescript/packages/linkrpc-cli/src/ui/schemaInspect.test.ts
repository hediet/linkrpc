import { describe, it, expect } from "vitest";
import {
    classifyField,
    cycleEnum,
    defaultValueFor,
    describeSchema,
    displayValue,
    parseTypedValue,
} from "./schemaInspect";

describe("classifyField", () => {
    it("maps primitive types", () => {
        expect(classifyField({ type: "string" }).kind).toBe("string");
        expect(classifyField({ type: "number" }).kind).toBe("number");
        expect(classifyField({ type: "integer" }).kind).toBe("integer");
        expect(classifyField({ type: "boolean" }).kind).toBe("boolean");
    });

    it("treats enum schemas as enums and surfaces the values", () => {
        const c = classifyField({ enum: ["a", "b", "c"] });
        expect(c.kind).toBe("enum");
        expect(c.enumValues).toEqual(["a", "b", "c"]);
    });

    it("treats const schemas as a single-value enum", () => {
        const c = classifyField({ const: 42 });
        expect(c.kind).toBe("enum");
        expect(c.enumValues).toEqual([42]);
    });

    it("collapses anyOf of consts into an enum", () => {
        const c = classifyField({ anyOf: [{ const: "a" }, { const: "b" }] });
        expect(c.kind).toBe("enum");
        expect(c.enumValues).toEqual(["a", "b"]);
    });

    it("falls back to json for objects, arrays, refs, and `true`", () => {
        expect(classifyField({ type: "object", properties: {}, additionalProperties: false }).kind).toBe("json");
        expect(classifyField({ type: "array", items: true }).kind).toBe("json");
        expect(classifyField({ $ref: "#/components/schemas/X" }).kind).toBe("json");
        expect(classifyField(true).kind).toBe("json");
    });
});

describe("cycleEnum", () => {
    it("steps forward and wraps at the end", () => {
        const values = ["a", "b", "c"];
        expect(cycleEnum(values, "a", 1)).toBe("b");
        expect(cycleEnum(values, "c", 1)).toBe("a");
    });

    it("steps backward and wraps at the start", () => {
        const values = ["a", "b", "c"];
        expect(cycleEnum(values, "a", -1)).toBe("c");
        expect(cycleEnum(values, "b", -1)).toBe("a");
    });

    it("returns the first valid option when the current value isn't in the set", () => {
        // Recovering from an out-of-range value: jump to the canonical first
        // option instead of stepping past the unrecognized value.
        expect(cycleEnum(["a", "b", "c"], "zzz", 1)).toBe("a");
        expect(cycleEnum(["a", "b", "c"], "zzz", -1)).toBe("a");
    });
});

describe("parseTypedValue", () => {
    it("returns the raw string for string fields", () => {
        expect(parseTypedValue("hello", "string")).toEqual({ ok: true, value: "hello" });
    });

    it("parses numbers and rejects non-numeric input", () => {
        expect(parseTypedValue("3.14", "number")).toEqual({ ok: true, value: 3.14 });
        const bad = parseTypedValue("nope", "number");
        expect(bad.ok).toBe(false);
    });

    it("rejects non-integer input for integer fields", () => {
        expect(parseTypedValue("3", "integer")).toEqual({ ok: true, value: 3 });
        const bad = parseTypedValue("3.14", "integer");
        expect(bad.ok).toBe(false);
    });

    it("parses JSON for json fields", () => {
        expect(parseTypedValue('{"a":1}', "json")).toEqual({ ok: true, value: { a: 1 } });
        const bad = parseTypedValue("{not json}", "json");
        expect(bad.ok).toBe(false);
    });

    it("returns undefined on an empty input for nullable kinds", () => {
        expect(parseTypedValue("", "number")).toEqual({ ok: true, value: undefined });
        expect(parseTypedValue("", "json")).toEqual({ ok: true, value: undefined });
    });
});

describe("defaultValueFor / displayValue / describeSchema", () => {
    it("returns sensible defaults per kind", () => {
        expect(defaultValueFor({ kind: "string" })).toBe("");
        expect(defaultValueFor({ kind: "boolean" })).toBe(false);
        expect(defaultValueFor({ kind: "integer" })).toBe(0);
        expect(defaultValueFor({ kind: "enum", enumValues: ["x", "y"] })).toBe("x");
    });

    it("displays values in a kind-appropriate form", () => {
        expect(displayValue("hello", "string")).toBe("hello");
        expect(displayValue(true, "boolean")).toBe("[x]");
        expect(displayValue(false, "boolean")).toBe("[ ]");
        expect(displayValue(undefined, "string")).toBe("(unset)");
    });

    it("describes schemas with short labels", () => {
        expect(describeSchema({ type: "string" })).toBe("string");
        expect(describeSchema({ enum: ["a", "b"] })).toMatch(/enum/);
        expect(describeSchema({ $ref: "#/components/schemas/Foo" })).toMatch(/Foo/);
    });
});
