import { describe, expect, it } from "vitest";
import {
    MemoryRecordingStore,
    RecordingCache,
    type RecordableFunction,
} from "./recordingCache";

describe("RecordingCache", () => {
    it("reuses any historical recording whose evidence still validates", async () => {
        const store = new MemoryRecordingStore();
        const cache = new RecordingCache(store);
        let currentDependency = "first";
        let runCount = 0;

        const fn: RecordableFunction<{ seed: number }, string, string> = {
            id: "example",
            version: "1",
            async run({ seed }) {
                runCount++;
                return {
                    output: `${seed}:${currentDependency}`,
                    evidence: currentDependency,
                };
            },
            async validate(_input, evidence) {
                return evidence === currentDependency
                    ? { valid: true }
                    : { valid: false, reason: "dependency changed" };
            },
        };

        expect(await cache.resolve(fn, { seed: 7 })).toMatchObject({
            kind: "computed",
            output: "7:first",
        });

        currentDependency = "second";
        expect(await cache.resolve(fn, { seed: 7 })).toMatchObject({
            kind: "computed",
            output: "7:second",
        });

        currentDependency = "first";
        expect(await cache.resolve(fn, { seed: 7 })).toMatchObject({
            kind: "reused",
            output: "7:first",
        });
        expect(runCount).toBe(2);
    });

    it("includes the complete input in recording lookup", async () => {
        const cache = new RecordingCache(new MemoryRecordingStore());
        let runCount = 0;
        const fn: RecordableFunction<{ llmSeed: number }, number, undefined> = {
            id: "seeded",
            version: "1",
            async run(input) {
                runCount++;
                return { output: input.llmSeed, evidence: undefined };
            },
            async validate() {
                return { valid: true };
            },
        };

        await cache.resolve(fn, { llmSeed: 0 });
        await cache.resolve(fn, { llmSeed: 1 });
        await cache.resolve(fn, { llmSeed: 0 });
        expect(runCount).toBe(2);
    });
});