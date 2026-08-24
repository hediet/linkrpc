import { describe, expect, it } from "vitest";
import {
    createJsonPatch,
    type JsonPatchOperation,
    type JsonValue,
} from "./jsonPatch";

describe("createJsonPatch", () => {
    it("produces deterministic RFC 6902 operations that converge the document", () => {
        const initial: JsonValue = {
            root: { state: "unexplored" },
            directories: {},
            stale: true,
        };
        const complete: JsonValue = {
            root: { state: "explored", target: "" },
            directories: {
                "de.hediet/cloud": {
                    state: "explored",
                    listings: ["auth"],
                },
            },
        };

        const operations = createJsonPatch(initial, complete);

        expect(operations).toEqual([
            { op: "remove", path: "/stale" },
            {
                op: "add",
                path: "/directories/de.hediet~1cloud",
                value: { state: "explored", listings: ["auth"] },
            },
            { op: "replace", path: "/root/state", value: "explored" },
            { op: "add", path: "/root/target", value: "" },
        ]);
        expect(applyPatch(initial, operations)).toEqual(complete);
    });

    it("replaces arrays and scalar roots instead of emitting invalid child operations", () => {
        expect(createJsonPatch([1, 2], [1, 3])).toEqual([
            { op: "replace", path: "", value: [1, 3] },
        ]);
        expect(createJsonPatch("unexplored", { state: "explored" })).toEqual([
            { op: "replace", path: "", value: { state: "explored" } },
        ]);
    });
});

function applyPatch(initial: JsonValue, operations: readonly JsonPatchOperation[]): JsonValue {
    let document = structuredClone(initial);
    for (const operation of operations) {
        if (operation.path === "") {
            if (operation.op === "remove") {
                throw new Error("The test helper does not remove a document root");
            }
            document = structuredClone(operation.value);
            continue;
        }
        const segments = operation.path
            .slice(1)
            .split("/")
            .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
        let parent = document as { [key: string]: JsonValue };
        for (const segment of segments.slice(0, -1)) {
            parent = parent[segment] as { [key: string]: JsonValue };
        }
        const key = segments.at(-1)!;
        if (operation.op === "remove") {
            delete parent[key];
        } else {
            parent[key] = structuredClone(operation.value);
        }
    }
    return document;
}
