import { describe, it, expect } from "vitest";
import { jcsCanonicalize, jcsCanonicalizeBytes } from "./jcs";

describe("jcsCanonicalize", () => {
    it("sorts object keys recursively", () => {
        expect(jcsCanonicalize({ b: 1, a: { d: 4, c: 3 } }))
            .toBe('{"a":{"c":3,"d":4},"b":1}');
    });

    it("preserves array order", () => {
        expect(jcsCanonicalize([3, 1, 2])).toBe("[3,1,2]");
    });

    it("omits undefined and symbol-valued properties", () => {
        expect(jcsCanonicalize({ a: 1, b: undefined, c: 3, d: Symbol("x") } as Record<string, unknown>))
            .toBe('{"a":1,"c":3}');
    });

    it("emits null as null (not omitted)", () => {
        expect(jcsCanonicalize({ a: null })).toBe('{"a":null}');
    });

    it("replaces undefined / symbol array elements with null", () => {
        expect(jcsCanonicalize([1, undefined, Symbol("x"), 2] as unknown[]))
            .toBe("[1,null,null,2]");
    });

    it("is deterministic across differently-ordered inputs", () => {
        expect(jcsCanonicalize({ a: 1, b: 2 })).toBe(jcsCanonicalize({ b: 2, a: 1 }));
    });

    it("sorts keys by UTF-16 code unit (RFC 8785 ordering)", () => {
        expect(jcsCanonicalize({ "\u00e9": 1, a: 2, A: 3, "1": 4 }))
            .toBe('{"1":4,"A":3,"a":2,"é":1}');
    });

    it("serializes primitives at the top level", () => {
        expect(jcsCanonicalize(42)).toBe("42");
        expect(jcsCanonicalize("hi")).toBe('"hi"');
        expect(jcsCanonicalize(true)).toBe("true");
        expect(jcsCanonicalize(null)).toBe("null");
    });

    it("honours a custom toJSON()", () => {
        const value = {
            x: 1,
            toJSON() {
                return { b: 2, a: 1 };
            },
        };
        expect(jcsCanonicalize(value)).toBe('{"a":1,"b":2}');
    });

    it("serializes Date via its toJSON()", () => {
        const d = new Date("2020-01-02T03:04:05.678Z");
        expect(jcsCanonicalize({ at: d })).toBe('{"at":"2020-01-02T03:04:05.678Z"}');
    });

    it("formats numbers per the RFC 8785 worked example", () => {
        const value = {
            numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
            literals: [null, true, false],
        };
        expect(jcsCanonicalize(value)).toBe(
            '{"literals":[null,true,false],'
            + '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
        );
    });

    it("escapes strings the way JSON.stringify does (printable non-ASCII stays literal)", () => {
        const value = { string: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"/" };
        expect(jcsCanonicalize(value)).toBe(
            '{"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
        );
    });

    it("throws on NaN / Infinity", () => {
        expect(() => jcsCanonicalize(Number.NaN)).toThrow();
        expect(() => jcsCanonicalize({ x: Number.POSITIVE_INFINITY })).toThrow();
        expect(() => jcsCanonicalize(Number.NEGATIVE_INFINITY)).toThrow();
    });

    it("throws on a value that is not JSON-representable", () => {
        expect(() => jcsCanonicalize(undefined)).toThrow();
        expect(() => jcsCanonicalize(() => 1)).toThrow();
    });

    it("throws on circular references", () => {
        const a: Record<string, unknown> = {};
        a.self = a;
        expect(() => jcsCanonicalize(a)).toThrow("Circular reference detected");
    });
});

describe("jcsCanonicalizeBytes", () => {
    it("round-trips to jcsCanonicalize via UTF-8", () => {
        const bytes = jcsCanonicalizeBytes({ b: 1, a: "\u03a9" });
        expect(new TextDecoder().decode(bytes)).toBe('{"a":"Ω","b":1}');
    });

    it("produces byte-identical output for differently-ordered inputs", () => {
        const left = jcsCanonicalizeBytes({ a: 1, b: 2 });
        const right = jcsCanonicalizeBytes({ b: 2, a: 1 });
        expect(left).toEqual(right);
    });
});
