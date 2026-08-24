import {
    createJsonPatch,
    type JsonPatchOperation,
    type JsonValue,
} from "./jsonPatch";

export type StateJsonlLine =
    | {
        readonly type: "snapshot";
        readonly revision: number;
        readonly value: JsonValue;
    }
    | {
        readonly type: "patch";
        readonly revision: number;
        readonly patch: readonly JsonPatchOperation[];
    };

/**
 * Serializes changing state as one initial value followed by atomic RFC 6902
 * patches. Await {@link whenIdle} before closing the destination.
 */
export class StateJsonlWriter {
    private _current: JsonValue | undefined;
    private _queue = Promise.resolve();

    public constructor(
        private readonly _emitLine: (line: string) => void | Promise<void>,
    ) {}

    public write(value: unknown, revision: number): void {
        const next = toJsonValue(value);
        this._queue = this._queue.then(async () => {
            if (this._current === undefined) {
                const line: StateJsonlLine = { type: "snapshot", revision, value: next };
                this._current = next;
                await this._emitLine(JSON.stringify(line));
                return;
            }
            const patch = createJsonPatch(this._current, next);
            this._current = next;
            if (patch.length === 0) return;
            const line: StateJsonlLine = { type: "patch", revision, patch };
            await this._emitLine(JSON.stringify(line));
        });
    }

    public async whenIdle(): Promise<void> {
        await this._queue;
    }
}

export function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}
