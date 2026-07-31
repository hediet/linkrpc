import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRecordingStore } from "./fileRecordingStore";
import type { Recording, RecordingQuery } from "./recordingCache";

describe("FileRecordingStore", () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        await Promise.all(temporaryDirectories.splice(0).map(
            (directory) => rm(directory, { recursive: true, force: true }),
        ));
    });

    it("persists immutable recordings newest first", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "eval-recordings-"));
        temporaryDirectories.push(directory);
        const query: RecordingQuery = {
            functionId: "example/function",
            functionVersion: "1",
            inputHash: "input-hash",
        };
        const older = recording(query, "older", "2026-01-01T00:00:00.000Z");
        const newer = recording(query, "newer", "2026-01-02T00:00:00.000Z");

        const writer = new FileRecordingStore(directory);
        await writer.append(older);
        await writer.append(newer);

        const reader = new FileRecordingStore(directory);
        const found = [];
        for await (const item of reader.find(query)) {
            found.push(item);
        }
        expect(found.map((item) => item.id)).toEqual(["newer", "older"]);
        await expect(writer.append(older)).rejects.toMatchObject({ code: "EEXIST" });
    });
});

function recording(
    query: RecordingQuery,
    id: string,
    createdAt: string,
): Recording<{ value: number }, string, readonly string[]> {
    return {
        ...query,
        id,
        input: { value: 1 },
        output: id,
        evidence: [id],
        createdAt,
    };
}