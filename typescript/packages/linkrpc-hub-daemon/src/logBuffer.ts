import type { LogLine } from './managementInterface';

/** Output without a newline is cut into lines of at most this length. */
const MAX_LINE_LENGTH = 8_192;

/** A bounded, line-oriented log of one service's output. */
export class LogBuffer {
    private readonly _lines: LogLine[] = [];
    private readonly _partial = new Map<LogLine['stream'], string>();

    constructor(private readonly _capacity = 1000) { }

    /** Append a chunk; returns the completed lines. Partial lines wait for their newline (up to a length limit). */
    public append(stream: LogLine['stream'], chunk: string): string[] {
        const parts = ((this._partial.get(stream) ?? '') + chunk).split(/\r?\n/);
        let partial = parts.pop()!;
        while (partial.length > MAX_LINE_LENGTH) {
            parts.push(partial.slice(0, MAX_LINE_LENGTH));
            partial = partial.slice(MAX_LINE_LENGTH);
        }
        this._partial.set(stream, partial);
        for (const text of parts) this._push({ at: Date.now(), stream, text });
        return parts;
    }

    public lines(limit = this._capacity): LogLine[] {
        return this._lines.slice(-limit);
    }

    private _push(line: LogLine): void {
        this._lines.push(line);
        if (this._lines.length > this._capacity) this._lines.splice(0, this._lines.length - this._capacity);
    }
}
