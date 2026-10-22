import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultsInterface, directoryInterface } from "./reflection.interfaces";

function fixture(name: string): { hash: string; schema: Record<string, unknown> } {
    return JSON.parse(readFileSync(
        new URL(`../../../../../../conformance/vectors/${name}`, import.meta.url),
        "utf8",
    ));
}

describe("reflection interface parity", () => {
    it("matches the shared hubrpc.defaults schema and hash", () => {
        const expected = fixture("reflection_defaults.json");
        const { hash: _generatedHash, ...schema } = defaultsInterface.toSchema();
        expect(schema).toEqual(expected.schema);
        expect(defaultsInterface.schemaHash).toBe(expected.hash);
    });

    it("matches the shared hubrpc.directory schema and hash", () => {
        const expected = fixture("reflection_directory.json");
        const { hash: _generatedHash, ...schema } = directoryInterface.toSchema();
        expect(schema).toEqual(expected.schema);
        expect(directoryInterface.schemaHash).toBe(expected.hash);
    });
});
