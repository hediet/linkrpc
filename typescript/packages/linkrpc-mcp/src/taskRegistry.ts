import type { ParkedTask, SandboxLog, TaskOutcome } from "./sandbox";

/** Snapshot of a live task, returned by {@link TaskRegistry.list}. */
export interface TaskInfo {
    readonly taskId: string;
    readonly debugName: string;
    readonly endpoint: string;
    readonly ageMs: number;
    readonly inFlight: readonly string[];
    readonly logCount: number;
}

/** Result of {@link TaskRegistry.awaitTask} / {@link TaskRegistry.cancel}. */
export type AwaitResult =
    | { readonly status: "running"; readonly taskId: string; readonly debugName: string; readonly inFlight: readonly string[]; readonly logs: readonly SandboxLog[] }
    | { readonly status: "completed"; readonly taskId: string; readonly debugName: string; readonly result: unknown; readonly logs: readonly SandboxLog[] }
    | { readonly status: "error"; readonly taskId: string; readonly debugName: string; readonly error: string; readonly logs: readonly SandboxLog[] }
    | { readonly status: "cancelled"; readonly taskId: string; readonly debugName: string; readonly logs: readonly SandboxLog[] }
    | { readonly status: "unknown"; readonly taskId: string };

/** Info about a task that was superseded by a newer request. */
export interface SupersededInfo {
    readonly taskId: string;
    readonly debugName: string;
    readonly outcome: "cancelled";
}

interface Entry {
    readonly id: string;
    readonly debugName: string;
    readonly endpoint: string;
    readonly startedAt: number;
    readonly task: ParkedTask;
    outcome: TaskOutcome | undefined;
}

/**
 * Tracks parked sandbox tasks. At most one task is "live" at a time across all
 * connections: starting a new one supersedes (cancels) the previous one via
 * {@link cancelLive}. Settled tasks are retained so their result can still be
 * fetched by id, and pruned opportunistically.
 */
export class TaskRegistry {
    private readonly _byId = new Map<string, Entry>();
    private _live: Entry | undefined;
    private _seq = 0;

    public constructor(private readonly _maxSettledAgeMs = 5 * 60_000) {}

    /**
     * Register a freshly parked task. Assigns a task id and wires up settlement
     * bookkeeping. `onComplete` fires with the result when the task completes
     * (used to thread `lastResultVal`).
     */
    public register(
        endpoint: string,
        debugName: string,
        task: ParkedTask,
        onComplete?: (result: unknown) => void,
    ): string {
        this._prune();
        const id = `t${++this._seq}`;
        const entry: Entry = {
            id,
            debugName,
            endpoint,
            startedAt: Date.now(),
            task,
            outcome: undefined,
        };
        this._byId.set(id, entry);
        this._live = entry;
        task.done.then(
            (o) => {
                entry.outcome = o;
                if (this._live === entry) {
                    this._live = undefined;
                }
                if (o.status === "completed") onComplete?.(o.result);
            },
            () => { /* task.done never rejects */ },
        );
        return id;
    }

    /**
     * Cancel the single live task, if any (the supersede path). Resolves once
     * the cancellation settles.
     */
    public async cancelLive(): Promise<SupersededInfo | undefined> {
        const entry = this._live;
        if (!entry) return undefined;
        this._live = undefined;
        await entry.task.cancel();
        return { taskId: entry.id, debugName: entry.debugName, outcome: "cancelled" };
    }

    /**
     * Wait up to `timeoutMs` for `taskId` to settle. Returns `running` (with a
     * progress snapshot) if it is still going, otherwise its terminal result.
     */
    public async awaitTask(taskId: string, timeoutMs: number): Promise<AwaitResult> {
        const entry = this._byId.get(taskId);
        if (!entry) return { status: "unknown", taskId };
        if (!entry.outcome) {
            const timeout = new Promise<"timeout">((r) => {
                setTimeout(() => r("timeout"), timeoutMs).unref?.();
            });
            const res = await Promise.race([entry.task.done, timeout]);
            if (res === "timeout") {
                return {
                    status: "running",
                    taskId,
                    debugName: entry.debugName,
                    inFlight: entry.task.inFlight(),
                    logs: [...entry.task.logs],
                };
            }
        }
        return this._outcomeResult(entry);
    }

    /** Explicitly cancel a task by id. */
    public async cancel(taskId: string): Promise<AwaitResult> {
        const entry = this._byId.get(taskId);
        if (!entry) return { status: "unknown", taskId };
        await entry.task.cancel();
        return this._outcomeResult(entry);
    }

    /** List live (unsettled) tasks. At most one under the global invariant. */
    public list(): TaskInfo[] {
        const out: TaskInfo[] = [];
        for (const e of this._byId.values()) {
            if (e.outcome) continue;
            out.push({
                taskId: e.id,
                debugName: e.debugName,
                endpoint: e.endpoint,
                ageMs: Date.now() - e.startedAt,
                inFlight: e.task.inFlight(),
                logCount: e.task.logs.length,
            });
        }
        return out;
    }

    /** Cancel every live task. */
    public dispose(): void {
        for (const e of this._byId.values()) {
            if (!e.outcome) void e.task.cancel();
        }
        this._byId.clear();
        this._live = undefined;
    }

    private _outcomeResult(entry: Entry): AwaitResult {
        const o = entry.outcome;
        if (!o) {
            return {
                status: "running",
                taskId: entry.id,
                debugName: entry.debugName,
                inFlight: entry.task.inFlight(),
                logs: [...entry.task.logs],
            };
        }
        if (o.status === "completed") {
            return { status: "completed", taskId: entry.id, debugName: entry.debugName, result: o.result, logs: o.logs };
        }
        if (o.status === "cancelled") {
            return { status: "cancelled", taskId: entry.id, debugName: entry.debugName, logs: o.logs };
        }
        return { status: "error", taskId: entry.id, debugName: entry.debugName, error: o.error, logs: o.logs };
    }

    private _prune(): void {
        const cutoff = Date.now() - this._maxSettledAgeMs;
        for (const [id, e] of this._byId) {
            if (e.outcome && e.startedAt < cutoff) this._byId.delete(id);
        }
    }
}
