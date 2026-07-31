import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Recording, RecordingQuery, RecordingStore } from "./recordingCache";

export class FileRecordingStore implements RecordingStore {
    public constructor(private readonly _rootDirectory: string) { }

    public async *find<Input, Output, Evidence>(
        query: RecordingQuery,
    ): AsyncIterable<Recording<Input, Output, Evidence>> {
        const directory = this._queryDirectory(query);
        let files: string[];
        try {
            files = await readdir(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return;
            }
            throw error;
        }

        files.sort().reverse();
        for (const file of files) {
            if (!file.endsWith(".json")) {
                continue;
            }
            const recording = JSON.parse(
                await readFile(path.join(directory, file), "utf8"),
            ) as Recording<Input, Output, Evidence>;
            if (
                recording.functionId === query.functionId
                && recording.functionVersion === query.functionVersion
                && recording.inputHash === query.inputHash
            ) {
                yield recording;
            }
        }
    }

    public async append<Input, Output, Evidence>(
        recording: Recording<Input, Output, Evidence>,
    ): Promise<void> {
        const directory = this._queryDirectory(recording);
        await mkdir(directory, { recursive: true });
        const timestamp = recording.createdAt.replace(/\D/g, "");
        const file = `${timestamp}-${recording.id}.json`;
        await writeFile(
            path.join(directory, file),
            `${JSON.stringify(recording, undefined, 2)}\n`,
            { encoding: "utf8", flag: "wx" },
        );
    }

    private _queryDirectory(query: RecordingQuery): string {
        return path.join(
            this._rootDirectory,
            encodeURIComponent(query.functionId),
            encodeURIComponent(query.functionVersion),
            query.inputHash,
        );
    }
}