import { describe, expect, it } from "vitest";
import { GraphTimings, type GraphTiming } from "./inspectGraphTiming";
import { GraphLoader } from "./inspectGraphModel";

describe("graph timing", () => {
    it("records fetch waiting separately from local cache work without payload contents", async () => {
        const records: GraphTiming[] = [];
        const timings = new GraphTimings(record => records.push(record));
        const loader = new GraphLoader(async ({ needs }) => {
            await new Promise(resolve => setTimeout(resolve, 20));
            return { objects: needs.map(({ ref }) => ({ ref, value: "private message" })), missing: [], complete: true };
        }, undefined, { timings });
        await loader.load([{ ref: { kind: "node", id: "private-id" }, paths: ["/"] }]);
        expect(records.map(record => record.phase)).toEqual(["fetch", "cache"]);
        expect(records[0].wallMs).toBeGreaterThanOrEqual(10);
        expect(records[0].detail).toEqual({ needs: 1, round: 0 });
        for (const record of records) {
            expect(record.cpuUserMs).toBeGreaterThanOrEqual(0);
            expect(record.cpuSystemMs).toBeGreaterThanOrEqual(0);
            expect(record.ok).toBe(true);
        }
        expect(JSON.stringify(records)).not.toContain("private");
    });

    it("reports failed spans while preserving the original errors", async () => {
        const records: GraphTiming[] = [];
        const timings = new GraphTimings(record => records.push(record));
        const error = new Error("failed");
        expect(() => timings.measureSync("tree", () => { throw error; })).toThrow(error);
        await expect(timings.measureAsync("fetch", async () => { throw error; })).rejects.toBe(error);
        expect(records.map(record => [record.phase, record.ok])).toEqual([["tree", false], ["fetch", false]]);
    });
});
