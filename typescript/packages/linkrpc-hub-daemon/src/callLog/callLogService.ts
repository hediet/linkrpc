import type { JsonValue, LinkRpcConnection } from '@hediet/linkrpc';
import { type FlowSummary, formatFlowSummary } from '@hediet/linkrpc-hub';
import type { JsonDocumentEdit } from '@hediet/linkrpc-infra/json-document';
import { type LogDocument, type LogEntry, type LogLevel, type LogStreamEvent, loggingInterface } from '@hediet/linkrpc-infra/logging';
import { stableKey } from '../config';
import type { CallLogStore } from './callLogStore';
import type { CallRecord } from './callRecord';

/** How many of the latest calls the `linkrpc.logging` document holds. */
export const CALL_LOG_WINDOW = 200;

/**
 * The call log as a revisioned `linkrpc.logging` document: the latest
 * {@link CALL_LOG_WINDOW} calls (oldest first) plus the log's state. A call
 * that settles replaces its pending entry in place.
 */
export class CallLogDocument {
    private _entries: Array<{ readonly id: string; readonly entry: LogEntry; }> = [];
    private _state: Readonly<Record<string, unknown>>;
    private _revision = 0;
    private _loaded = false;
    private readonly _patchListeners = new Set<(event: LogStreamEvent) => void>();
    private readonly _subscription: { dispose(): void; };
    /** Resolves once the window holds the latest calls from disk. */
    public readonly ready: Promise<void>;

    constructor(
        private readonly _service: string,
        private readonly _startedAt: number,
        store: CallLogStore,
        state: Readonly<Record<string, unknown>>,
    ) {
        this._state = state;
        const early: CallRecord[] = [];
        this._subscription = store.onRecord(record => this._loaded ? this._add(record) : early.push(record));
        this.ready = store.query({}, CALL_LOG_WINDOW)
            .catch(() => ({ calls: [] }))
            .then(({ calls }) => {
                this._entries = [...calls].reverse().map(record => ({ id: record.id, entry: _toLogEntry(record) }));
                this._loaded = true;
                for (const record of early) this._add(record);
            });
    }

    public snapshot(): { revision: number; document: LogDocument; } {
        return {
            revision: this._revision,
            document: {
                schemaVersion: 1,
                service: this._service,
                startedAt: new Date(this._startedAt).toISOString(),
                state: this._state,
                entries: this._entries.map(({ entry }) => entry),
            },
        };
    }

    public setState(state: Readonly<Record<string, unknown>>): void {
        if (stableKey(state) === stableKey(this._state)) return;
        this._state = state;
        this._publish([{ op: 'set', path: '/state', value: state }]);
    }

    public onPatch(listener: (event: LogStreamEvent) => void): { dispose(): void; } {
        this._patchListeners.add(listener);
        return { dispose: () => this._patchListeners.delete(listener) };
    }

    public dispose(): void {
        this._subscription.dispose();
        this._patchListeners.clear();
    }

    private _add(record: CallRecord): void {
        const entry = _toLogEntry(record);
        const index = this._entries.findIndex(existing => existing.id === record.id);
        if (index >= 0) {
            this._entries[index] = { id: record.id, entry };
            this._publish([{ op: 'set', path: `/entries/${index}`, value: entry }]);
            return;
        }
        const edits: JsonDocumentEdit[] = [{ op: 'insert', path: '/entries', index: this._entries.length, value: entry }];
        this._entries.push({ id: record.id, entry });
        if (this._entries.length > CALL_LOG_WINDOW) {
            this._entries.shift();
            edits.push({ op: 'remove', path: '/entries/0' });
        }
        this._publish(edits);
    }

    private _publish(edits: JsonDocumentEdit[]): void {
        this._revision++;
        const event: LogStreamEvent = { type: 'patch', revision: this._revision, edits };
        for (const listener of [...this._patchListeners]) listener(event);
    }
}

export interface CallLogLevelControl {
    level(): LogLevel;
    /** Persists the level in the daemon config. */
    setLevel(level: LogLevel): Promise<void>;
}

/** Serve `document` as `linkrpc.logging` under `serviceId`. */
export function registerCallLogService(
    connection: LinkRpcConnection,
    serviceId: string,
    document: CallLogDocument,
    control: CallLogLevelControl,
): { dispose(): void; } {
    return connection.register(loggingInterface, {
        getLogLevel: () => ({ level: control.level() }),
        setLogLevel: async ({ level }) => {
            await control.setLevel(level);
            return {};
        },
        getLogSnapshot: async () => {
            await document.ready;
            return document.snapshot();
        },
        watchLog: async (_params, _ctx, stream) => {
            await document.ready;
            const send = (event: LogStreamEvent) => stream.send(event).catch(() => { /* the watcher went away */ });
            void send({ type: 'snapshot', ...document.snapshot() });
            const subscription = document.onPatch(event => void send(event));
            try {
                await new Promise<void>(resolve => {
                    if (stream.signal.aborted) resolve();
                    else stream.signal.addEventListener('abort', () => resolve(), { once: true });
                });
            } finally {
                subscription.dispose();
            }
            return {};
        },
    }, { serviceId });
}

function _toLogEntry(record: CallRecord): LogEntry {
    return {
        timestamp: new Date(record.at).toISOString(),
        level: record.level,
        message: formatFlowSummary(_asFlowSummary(record), 120),
        durationMs: record.durationMs,
        ...(record.error !== undefined ? { error: { name: 'RpcError', message: `${record.error.message} (code ${record.error.code})` } } : {}),
        attributes: record,
    };
}

/** Render a record like the hub's flow log (`--log-messages`, `hub traffic`). */
function _asFlowSummary(record: CallRecord): FlowSummary {
    const params = record.params as JsonValue | undefined;
    const frame = record.kind === 'stream' ? params as { dir?: string; control?: string; payload?: JsonValue; } | undefined : undefined;
    return {
        id: record.id,
        kind: record.kind,
        method: record.method,
        params: frame ? undefined : params,
        status: record.status,
        result: record.result as JsonValue | undefined,
        error: record.error,
        startTs: record.at,
        endTs: record.status === 'pending' ? undefined : record.at + record.durationMs,
        durationMs: record.durationMs,
        path: [record.from.label, ...(record.to ? [record.to.label] : [])],
        partial: record.status === 'pending',
        ...(frame ? {
            stream: [{
                timeMs: record.at + record.durationMs,
                dir: frame.dir === 'toCallee' ? 'toCallee' : 'toCaller',
                ...(frame.control !== undefined ? { control: frame.control } : {}),
                ...(frame.payload !== undefined ? { payload: frame.payload } : {}),
            }],
        } : {}),
    };
}
