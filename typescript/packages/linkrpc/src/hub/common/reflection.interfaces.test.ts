import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultsInterface } from "./reflection.interfaces";

const fixture = JSON.parse(readFileSync(
    new URL("../../../../../../conformance/vectors/reflection_defaults.json", import.meta.url),
    "utf8",
)) as {
    hash: string;
    schema: Record<string, unknown>;
};

describe("reflection interface parity", () => {
    it("matches the shared hubrpc.defaults schema and hash", () => {
        const { hash: _generatedHash, ...schema } = defaultsInterface.toSchema();
        expect(schema).toEqual(fixture.schema);
        expect(defaultsInterface.schemaHash).toBe(fixture.hash);
    });
});
