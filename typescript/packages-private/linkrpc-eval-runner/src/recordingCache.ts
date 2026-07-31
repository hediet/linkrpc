import { createHash, randomUUID } from "node:crypto";

export type ValidationResult =
    | { readonly valid: true }
    | { readonly valid: false; readonly reason: unknown };

export interface RecordableFunction<Input, Output, Evidence> {
    readonly id: string;
    readonly version: string;
    run(input: Input): Promise<{ readonly output: Output; readonly evidence: Evidence }>;
    validate(input: Input, evidence: Evidence): Promise<ValidationResult>;
}

export interface Recording<Input, Output, Evidence> {
    readonly id: string;
    readonly functionId: string;
    readonly functionVersion: string;
    readonly input: Input;
    readonly inputHash: string;
    readonly output: Output;
    readonly evidence: Evidence;
    readonly createdAt: string;
}

export interface RecordingQuery {
    readonly functionId: string;
    readonly functionVersion: string;
    readonly inputHash: string;
}

export interface RecordingStore {
    find<Input, Output, Evidence>(
        query: RecordingQuery,
    ): AsyncIterable<Recording<Input, Output, Evidence>>;
    append<Input, Output, Evidence>(
        recording: Recording<Input, Output, Evidence>,
    ): Promise<void>;
}

export type CacheResolution<Output> =
    | { readonly kind: "reused"; readonly output: Output; readonly recordingId: string }
    | { readonly kind: "computed"; readonly output: Output; readonly recordingId: string };

export class RecordingCache {
    public constructor(private readonly _store: RecordingStore) { }

    public async resolve<Input, Output, Evidence>(
        fn: RecordableFunction<Input, Output, Evidence>,
        input: Input,
    ): Promise<CacheResolution<Output>> {
        const inputHash = hashValue(input);
        for await (const candidate of this._store.find<Input, Output, Evidence>({
            functionId: fn.id,
            functionVersion: fn.version,
            inputHash,
        })) {
            const validation = await fn.validate(input, candidate.evidence);
            if (validation.valid) {
                return {
                    kind: "reused",
                    output: candidate.output,
                    recordingId: candidate.id,
                };
            }
        }

        const result = await fn.run(input);
        const recording: Recording<Input, Output, Evidence> = {
            id: randomUUID(),
            functionId: fn.id,
            functionVersion: fn.version,
            input,
            inputHash,
            output: result.output,
            evidence: result.evidence,
            createdAt: new Date().toISOString(),
        };
        await this._store.append(recording);
        return { kind: "computed", output: result.output, recordingId: recording.id };
    }
}

export class MemoryRecordingStore implements RecordingStore {
    private readonly _recordings: Recording<unknown, unknown, unknown>[] = [];

    public async *find<Input, Output, Evidence>(
        query: RecordingQuery,
    ): AsyncIterable<Recording<Input, Output, Evidence>> {
        const candidates = this._recordings
            .filter((recording) =>
                recording.functionId === query.functionId
                && recording.functionVersion === query.functionVersion
                && recording.inputHash === query.inputHash
            )
            .reverse();
        for (const candidate of candidates) {
            yield candidate as Recording<Input, Output, Evidence>;
        }
    }

    public async append<Input, Output, Evidence>(
        recording: Recording<Input, Output, Evidence>,
    ): Promise<void> {
        this._recordings.push(recording as Recording<unknown, unknown, unknown>);
    }
}

export function hashValue(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, canonicalize(child)]),
        );
    }
    return value;
}