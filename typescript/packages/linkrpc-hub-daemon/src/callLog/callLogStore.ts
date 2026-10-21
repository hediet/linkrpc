import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CallLogRotation } from './callLogConfig';
import { type CallFilter, type CallRecord, createCallMatcher } from './callRecord';

const SEGMENT = /^calls-[0-9TZ-]+\.ndjson$/;
const DAY_MS = 24 * 60 * 60_000;

export interface CallQueryResult {
    /** Newest first; one record per call id (the latest one written). */
    readonly calls: readonly CallRecord[];
    /** More records match beyond `limit`. */
    readonly truncated: boolean;
}

/**
 * The call log on disk: NDJSON segments `calls-<UTC start>.ndjson` in one
 * directory. Appends are buffered and written in order; a segment is closed
 * at `maxFileSizeMb`, and old segments beyond `maxFiles` or `maxAgeDays` are
 * deleted. The files are the source of truth for queries.
 */
export class CallLogStore {
    private readonly _queue: string[] = [];
    private readonly _listeners = new Set<(record: CallRecord) => void>();
    private _segment: { readonly file: string; readonly handle: fs.promises.FileHandle; size: number; } | undefined;
    private _drain: Promise<void> | undefined;
    private _lastStamp = 0;
    private _error: string | undefined;

    constructor(
        public readonly directory: string,
        private _rotation: CallLogRotation,
        private readonly _now: () => number = Date.now,
    ) { }

    /** The last write failure, if the latest write failed. */
    public get error(): string | undefined {
        return this._error;
    }

    public setRotation(rotation: CallLogRotation): void {
        this._rotation = rotation;
    }

    /** Queue `record` for writing and notify live listeners. */
    public append(record: CallRecord): void {
        this._queue.push(`${JSON.stringify(record)}\n`);
        this._schedule();
        for (const listener of [...this._listeners]) listener(record);
    }

    public onRecord(listener: (record: CallRecord) => void): { dispose(): void; } {
        this._listeners.add(listener);
        return { dispose: () => this._listeners.delete(listener) };
    }

    /** Resolves once every appended record is written. */
    public async flush(): Promise<void> {
        while (this._drain) await this._drain;
    }

    public async query(filter: CallFilter = {}, limit = 200): Promise<CallQueryResult> {
        await this.flush();
        const matches = createCallMatcher(filter);
        const calls: CallRecord[] = [];
        const seen = new Set<string>();
        for (const name of (await this._segments()).reverse()) {
            const file = path.join(this.directory, name);
            let text: string;
            try {
                if (filter.since !== undefined && (await fs.promises.stat(file)).mtimeMs < filter.since) break;
                text = await fs.promises.readFile(file, 'utf8');
            } catch {
                continue; // deleted by retention meanwhile
            }
            const lines = text.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const record = _parseLine(lines[i]!);
                if (!record || seen.has(record.id)) continue;
                seen.add(record.id);
                if (!matches(record)) continue;
                if (calls.length === limit) return { calls, truncated: true };
                calls.push(record);
            }
        }
        return { calls, truncated: false };
    }

    public async close(): Promise<void> {
        await this.flush();
        this._listeners.clear();
        await this._closeSegment();
    }

    private _schedule(): void {
        this._drain ??= this._write().finally(() => {
            this._drain = undefined;
            if (this._queue.length > 0) this._schedule();
        });
    }

    private async _write(): Promise<void> {
        while (this._queue.length > 0) {
            const chunk = this._queue.splice(0).join('');
            try {
                const segment = this._segment ?? await this._openSegment();
                await segment.handle.write(chunk);
                segment.size += Buffer.byteLength(chunk);
                if (segment.size >= this._rotation.maxFileSizeMb * 1024 * 1024) await this._closeSegment();
                this._error = undefined;
            } catch (error) {
                this._error = `cannot write the call log: ${error instanceof Error ? error.message : String(error)}`;
                await this._closeSegment().catch(() => { /* reopened on the next write */ });
            }
        }
    }

    /** Continue the newest segment while it has room; otherwise start one and apply retention. */
    private async _openSegment(): Promise<NonNullable<CallLogStore['_segment']>> {
        await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const newest = (await this._segments()).at(-1);
        if (newest !== undefined) {
            const file = path.join(this.directory, newest);
            const { size } = await fs.promises.stat(file);
            if (size < this._rotation.maxFileSizeMb * 1024 * 1024) {
                this._segment = { file, handle: await fs.promises.open(file, 'a', 0o600), size };
                return this._segment;
            }
        }
        const file = path.join(this.directory, `calls-${this._stamp()}.ndjson`);
        this._segment = { file, handle: await fs.promises.open(file, 'a', 0o600), size: 0 };
        await this._prune(file);
        return this._segment;
    }

    private async _closeSegment(): Promise<void> {
        const segment = this._segment;
        this._segment = undefined;
        await segment?.handle.close();
    }

    private async _prune(current: string): Promise<void> {
        const names = await this._segments();
        const expired = this._now() - this._rotation.maxAgeDays * DAY_MS;
        for (const [index, name] of names.entries()) {
            const file = path.join(this.directory, name);
            if (file === current) continue;
            const beyondCount = index < names.length - this._rotation.maxFiles;
            try {
                if (beyondCount || (await fs.promises.stat(file)).mtimeMs < expired) await fs.promises.rm(file, { force: true });
            } catch { /* already gone */ }
        }
    }

    /** Segment names, oldest first. */
    private async _segments(): Promise<string[]> {
        try {
            return (await fs.promises.readdir(this.directory)).filter(name => SEGMENT.test(name)).sort();
        } catch {
            return [];
        }
    }

    /** Sortable and unique: `2026-10-21T12-37-35-123Z`. */
    private _stamp(): string {
        this._lastStamp = Math.max(this._now(), this._lastStamp + 1);
        return new Date(this._lastStamp).toISOString().replace(/[:.]/g, '-');
    }
}

function _parseLine(line: string): CallRecord | undefined {
    if (line === '') return undefined;
    try {
        const value: unknown = JSON.parse(line);
        if (value === null || typeof value !== 'object' || !('v' in value) || value.v !== 1) return undefined;
        return value as CallRecord;
    } catch {
        return undefined; // a line cut short by a crash
    }
}
