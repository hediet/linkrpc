import { describe, it, expect } from "vitest";
import { mergeParams, parseParamOverride } from "./paramParsing";

describe("parseParamOverride", () => {
    it("splits k=v and parses JSON-shaped values", () => {
        expect(parseParamOverride("count=42")).toEqual({ path: ["count"], value: 42 });
        expect(parseParamOverride("flag=true")).toEqual({ path: ["flag"], value: true });
        expect(parseParamOverride('name="alice"')).toEqual({ path: ["name"], value: "alice" });
    });

    it("falls back to raw string when value isn't JSON", () => {
        expect(parseParamOverride("to=a@b.c")).toEqual({ path: ["to"], value: "a@b.c" });
    });

    it("supports nested keys via dot segments", () => {
        expect(parseParamOverride("user.name=x")).toEqual({ path: ["user", "name"], value: "x" });
    });

    it("rejects malformed entries", () => {
        expect(() => parseParamOverride("nope")).toThrow();
        expect(() => parseParamOverride("=v")).toThrow();
        expect(() => parseParamOverride("a..b=v")).toThrow();
    });
});

describe("mergeParams", () => {
    it("applies overrides on top of base", () => {
        const out = mergeParams({
            base: { a: 1, b: 2 },
            overrides: ["b=3", "c=4"],
        });
        expect(out).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("supports nested overrides", () => {
        const out = mergeParams({
            base: undefined,
            overrides: ["user.name=alice", "user.age=30"],
        });
        expect(out).toEqual({ user: { name: "alice", age: 30 } });
    });

    it("returns the base unchanged when no overrides", () => {
        expect(mergeParams({ base: { x: 1 } })).toEqual({ x: 1 });
    });
});
