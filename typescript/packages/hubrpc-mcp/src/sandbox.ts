import {
    getQuickJS,
    QuickJSHandle,
    Scope,
    type QuickJSContext,
    type QuickJSDeferredPromise,
    type QuickJSRuntime,
} from "quickjs-emscripten";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { CONNECTION_DTS } from "./connectionDts";

/**
 * The guest runtime (`src/guest/guestMain.ts`) bundled to plain JS, evaluated
 * inside QuickJS before any user code. Authoring it as real TypeScript that is
 * type-checked against `connection.d.ts` is what keeps `con` from drifting out
 * of sync with its declarations.
 *
 * `@vscode/rollup-plugin-esm-url` rewrites the `?esm` URL at build time to the
 * emitted (already-transpiled) chunk next to this module, so the production
 * read returns JS. In dev/test (vite serve, no rewrite) the URL still points
 * at the `.ts` source, so we transpile it on the fly with the `typescript`
 * devDependency — that branch never runs in the shipped `dist`.
 */
function _loadGuestRuntime(): string {
    const filePath = fileURLToPath(new URL("./guest/guestMain.ts?esm", import.meta.url));
    const code = readFileSync(filePath, "utf8");
    if (!filePath.endsWith(".ts")) {
        return code;
    }
    const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
    return ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
}

const GUEST_RUNTIME_JS = _loadGuestRuntime();

/**
 * Async host functions exposed to the guest. Each returns either:
 *   - a JSON-stringified value (the guest will `JSON.parse` it), or
 *   - the empty string for `undefined` results (used for `notify`).
 *
 * Host rejections become guest `Error`s with a bounded snapshot of every
 * serializable own data property preserved.
 */
export interface SandboxHostApi {
    call(
        method: string,
        paramsJson: string,
        optsJson: string,
        onStreamMessage: (payloadJson: string) => void,
        signal: AbortSignal,
    ): Promise<string>;
    notify(method: string, paramsJson: string): Promise<string>;
    explore(argsJson: string): Promise<string>;
    requestAccess(argsJson: string): Promise<string>;
    grants(argsJson: string): Promise<string>;
}

export type SandboxLog = { level: "log" | "warn" | "error"; text: string };

/** Legacy options for {@link runSandboxed} (run-to-completion, no parking). */
export interface SandboxOptions {
    /** Foreground budget in ms. Defaults to {@link DEFAULT_FOREGROUND_MS}. */
    readonly timeoutMs?: number;
    readonly memoryLimitBytes?: number;
}

/** Options for {@link startSandbox} (parking-capable). */
export interface StartSandboxOptions {
    /**
     * How long the call may run synchronously before it is parked as a
     * background task. Defaults to {@link DEFAULT_FOREGROUND_MS}.
     */
    readonly foregroundMs?: number;
    /**
     * Absolute lifetime cap for a parked task. After this the task is
     * soft-aborted and settled with an error. Defaults to
     * {@link DEFAULT_MAX_LIFETIME_MS}. Must be `> foregroundMs` for parking
     * to be possible.
     */
    readonly maxLifetimeMs?: number;
    readonly memoryLimitBytes?: number;
    /**
     * Human-readable debug name for the parked task. When omitted, the name
     * is inferred from the in-flight RPC(s) at park time, falling back to the
     * first line of `code`.
     */
    readonly label?: string;
}

/** Legacy result shape for {@link runSandboxed}. */
export interface SandboxRunResult {
    readonly resultJson: string;
    readonly logs: readonly SandboxLog[];
}

/** Terminal state of a parked task. */
export type TaskOutcome =
    | { readonly status: "completed"; readonly result: unknown; readonly logs: readonly SandboxLog[] }
    | { readonly status: "error"; readonly error: string; readonly logs: readonly SandboxLog[] }
    | { readonly status: "cancelled"; readonly logs: readonly SandboxLog[] };

/** Result of the foreground phase of {@link startSandbox}. */
export type SandboxOutcome =
    | { readonly status: "completed"; readonly result: unknown; readonly logs: readonly SandboxLog[] }
    | { readonly status: "error"; readonly error: string; readonly logs: readonly SandboxLog[] }
    | { readonly status: "parked"; readonly debugName: string; readonly task: ParkedTask };

/**
 * A live sandbox execution that did not settle within the foreground budget
 * and is now pumping in the background until its in-flight work resolves, it
 * is cancelled, or it hits the max-lifetime guard.
 */
export interface ParkedTask {
    /** Labels of the RPC(s) currently in flight (snapshot). */
    inFlight(): string[];
    /** Live view of logs captured so far. */
    readonly logs: readonly SandboxLog[];
    /** Resolves when the task reaches a terminal state. Never rejects. */
    readonly done: Promise<TaskOutcome>;
    /**
     * Soft-abort the task and settle it. Resolves with the terminal outcome
     * (`cancelled`, or `completed`/`error` if the guest settled cleanly
     * within its grace window).
     */
    cancel(): Promise<TaskOutcome>;
}

const DEFAULT_FOREGROUND_MS = 5_000;
const DEFAULT_MAX_LIFETIME_MS = 120_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
/**
 * Grace window granted to the guest after a soft abort (cancel / max
 * lifetime) so it can run `catch`/`finally` and return a partial result
 * before the task is force-settled.
 */
const SOFT_CANCEL_GRACE_MS = 200;

let _quickjsPromise: ReturnType<typeof getQuickJS> | undefined;
function _qjs() {
    if (!_quickjsPromise) _quickjsPromise = getQuickJS();
    return _quickjsPromise;
}

const _delay = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Internal mutable VM state shared with host-fn callbacks.
 *   - `alive` flips false during teardown so late RPC replies don't touch
 *     freed memory.
 *   - `softAborted` flips true when cancelled / max-lifetime; pending RPCs
 *     are rejected with `AbortError` and the guest sees
 *     `con.abortSignal.aborted = true`. Subsequent host-fn calls reject
 *     immediately while the guest still has its grace window.
 */
interface VmState {
    alive: boolean;
    softAborted: boolean;
    softAbortReason: string | undefined;
}

/**
 * Run-to-completion entry point preserved for callers that just want a result
 * and treat the timeout as a hard wall (the original behaviour). Throws on
 * guest error or deadline; never parks.
 */
export async function runSandboxed(
    userCode: string,
    host: SandboxHostApi,
    lastResultVal: unknown,
    options: SandboxOptions = {},
): Promise<SandboxRunResult> {
    const budget = options.timeoutMs ?? DEFAULT_FOREGROUND_MS;
    const exec = await SandboxExecution.create(userCode, host, lastResultVal, {
        foregroundMs: budget,
        // maxLifetime === foreground disables parking.
        maxLifetimeMs: budget,
        memoryLimitBytes: options.memoryLimitBytes,
    });
    const outcome = await exec.runForeground();
    if (outcome.status === "completed") {
        return {
            resultJson: outcome.result === undefined ? "" : JSON.stringify(outcome.result),
            logs: outcome.logs,
        };
    }
    if (outcome.status === "error") {
        throw new Error(outcome.error);
    }
    // Parking is disabled here, so this branch is unreachable in practice;
    // defend against it anyway so a stray parked task can't leak a VM.
    const final = await outcome.task.cancel();
    throw new Error(
        final.status === "error" ? final.error : "sandbox deadline exceeded",
    );
}

/**
 * Parking-capable entry point. Runs `userCode` for up to `foregroundMs`; if it
 * settles in that window the result is returned inline, otherwise the live VM
 * is detached into a {@link ParkedTask} that keeps pumping in the background.
 */
export async function startSandbox(
    userCode: string,
    host: SandboxHostApi,
    lastResultVal: unknown,
    options: StartSandboxOptions = {},
): Promise<SandboxOutcome> {
    const exec = await SandboxExecution.create(userCode, host, lastResultVal, {
        foregroundMs: options.foregroundMs ?? DEFAULT_FOREGROUND_MS,
        maxLifetimeMs: options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS,
        memoryLimitBytes: options.memoryLimitBytes,
        label: options.label,
    });
    return exec.runForeground();
}

interface ResolvedExecOptions {
    foregroundMs: number;
    maxLifetimeMs: number;
    memoryLimitBytes?: number;
    label?: string;
}

interface PendingTimer {
    readonly handle: ReturnType<typeof setTimeout>;
    readonly repeat: boolean;
    readonly delayMs: number;
}

/**
 * Encapsulates one QuickJS context and drives it through a foreground phase
 * and (optionally) a background phase. Only one driver loop runs at a time:
 * `runForeground` runs first and, if it parks, hands off to `_runBackground`.
 * `cancel` cooperates with the background loop rather than starting its own.
 */
class SandboxExecution {
    public static async create(
        userCode: string,
        host: SandboxHostApi,
        lastResultVal: unknown,
        options: ResolvedExecOptions,
    ): Promise<SandboxExecution> {
        const QuickJS = await _qjs();
        const exec = new SandboxExecution(userCode, host, lastResultVal, options);
        try {
            exec._init(QuickJS);
        } catch (e) {
            exec._dispose();
            throw e;
        }
        return exec;
    }

    private readonly _scope = new Scope();
    private readonly _logs: SandboxLog[] = [];
    /** In-flight host->guest deferreds keyed by a human-readable call label. */
    private readonly _pendingDeferreds = new Map<QuickJSDeferredPromise, string>();
    private readonly _pendingTimers = new Map<number, PendingTimer>();
    private readonly _vmState: VmState = { alive: true, softAborted: false, softAbortReason: undefined };
    private readonly _abortController = new AbortController();
    private readonly _cpuBurstMs: number;
    private readonly _startedAt = Date.now();

    private _runtime!: QuickJSRuntime;
    private _vm!: QuickJSContext;
    private _promiseH: QuickJSHandle | undefined;
    /** Deadline for the current synchronous burst; read by the interrupt handler. */
    private _cpuDeadline = 0;
    private _disposed = false;
    private _settled: TaskOutcome | undefined;
    private _backgroundDone: Promise<TaskOutcome> | undefined;
    private _cancelGraceDeadline: number | undefined;

    private constructor(
        private readonly _userCode: string,
        private readonly _host: SandboxHostApi,
        private readonly _lastResultVal: unknown,
        private readonly _options: ResolvedExecOptions,
    ) {
        this._cpuBurstMs = Math.max(_options.foregroundMs, 50);
    }

    private get _allowPark(): boolean {
        return this._options.maxLifetimeMs > this._options.foregroundMs;
    }

    private _init(QuickJS: Awaited<ReturnType<typeof getQuickJS>>): void {
        const runtime = this._scope.manage(QuickJS.newRuntime());
        runtime.setMemoryLimit(this._options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES);
        // Per-burst CPU guard: any single synchronous chunk that runs past
        // `_cpuDeadline` is interrupted. `_cpuDeadline` is refreshed before
        // every entry into the VM, so cooperative code that yields to I/O can
        // run indefinitely while a `while(true){}` is killed within one burst.
        runtime.setInterruptHandler(() => Date.now() > this._cpuDeadline);
        this._runtime = runtime;
        this._vm = this._scope.manage(runtime.newContext());
        // Arm the CPU budget before any guest code (prelude) runs.
        this._cpuDeadline = Date.now() + this._cpuBurstMs;
        this._installHostApi();
        _evalPrelude(this._vm, this._lastResultVal);
    }

    public async runForeground(): Promise<SandboxOutcome> {
        // Compile + start the user IIFE. Syntax errors surface here.
        this._cpuDeadline = Date.now() + this._cpuBurstMs;
        const evalRes = this._vm.evalCode(_wrapUserCode(this._userCode));
        if (evalRes.error) {
            const dumped = this._vm.dump(evalRes.error);
            evalRes.error.dispose();
            this._forceSettle({ status: "error", error: _formatGuestError(dumped), logs: this._logs.slice() });
            return this._terminalOutcome();
        }
        this._promiseH = evalRes.value;
        this._pump();

        const phase = await this._loopUntil(Date.now() + this._options.foregroundMs);
        if (phase === "settled") return this._terminalOutcome();

        // Still pending at the foreground deadline.
        if (!this._allowPark) {
            this._triggerSoftAbort("sandbox deadline exceeded");
            await this._loopUntil(Date.now() + SOFT_CANCEL_GRACE_MS);
            if (!this._settled) {
                this._forceSettle({
                    status: "error",
                    error: "sandbox deadline exceeded",
                    logs: this._logs.slice(),
                });
            }
            return this._terminalOutcome();
        }

        const debugName = this._computeDebugName();
        this._backgroundDone = this._runBackground();
        return { status: "parked", debugName, task: this._asParkedTask() };
    }

    private async _runBackground(): Promise<TaskOutcome> {
        const hardDeadline = this._startedAt + this._options.maxLifetimeMs;
        while (true) {
            if (this._settled || this._checkPromise()) break;
            const now = Date.now();
            if (this._cancelGraceDeadline !== undefined && now > this._cancelGraceDeadline) {
                this._forceSettle({ status: "cancelled", logs: this._logs.slice() });
                break;
            }
            if (now > hardDeadline) {
                this._triggerSoftAbort("max lifetime exceeded");
                this._forceSettle({
                    status: "error",
                    error: "sandbox max lifetime exceeded",
                    logs: this._logs.slice(),
                });
                break;
            }
            await _delay();
            this._pump();
        }
        return this._settled as TaskOutcome;
    }

    /** Pump + poll the user promise until it settles or `deadline` passes. */
    private async _loopUntil(deadline: number): Promise<"settled" | "pending"> {
        while (true) {
            if (this._settled || this._checkPromise()) return "settled";
            if (Date.now() > deadline) return "pending";
            await _delay();
            this._pump();
        }
    }

    /** Returns true once the user promise has settled (and disposes the VM). */
    private _checkPromise(): boolean {
        if (this._settled) return true;
        if (!this._vmState.alive || !this._promiseH) return true;
        const state = this._vm.getPromiseState(this._promiseH);
        if (state.type === "fulfilled") {
            let json: string;
            try {
                json = this._vm.getString(state.value);
            } finally {
                state.value.dispose();
            }
            const result = json === "" ? undefined : JSON.parse(json);
            this._forceSettle({ status: "completed", result, logs: this._logs.slice() });
            return true;
        }
        if (state.type === "rejected") {
            const dumped = this._vm.dump(state.error);
            state.error.dispose();
            const e = _toError(dumped);
            this._settleError(e.message, _formatGuestError(dumped));
            return true;
        }
        // Pending: `state.error` is a plain JS placeholder, nothing to dispose.
        return false;
    }

    private _settleError(message: string, detail?: string): void {
        // A rejection that arrives after a soft abort is the guest reacting to
        // our `AbortError`; classify it as a clean cancellation rather than a
        // failure so callers see the intent.
        if (this._vmState.softAborted && /abort/i.test(message)) {
            this._forceSettle({ status: "cancelled", logs: this._logs.slice() });
            return;
        }
        const normalized = /interrupt/i.test(message) ? "sandbox deadline exceeded" : (detail ?? message);
        this._forceSettle({ status: "error", error: normalized, logs: this._logs.slice() });
    }

    private _forceSettle(outcome: TaskOutcome): void {
        if (this._settled) return;
        this._dispose();
        this._settled = outcome;
    }

    private _pump(): void {
        if (!this._vmState.alive || this._disposed) return;
        this._cpuDeadline = Date.now() + this._cpuBurstMs;
        const r = this._runtime.executePendingJobs();
        if (r.error) {
            const dumped = this._vm.dump(r.error);
            r.error.dispose();
            const e = _toError(dumped);
            this._settleError(e.message, _formatGuestError(dumped));
        }
    }

    private _computeDebugName(): string {
        if (this._options.label) return this._options.label;
        const inflight = this._inFlight();
        if (inflight.length > 0) return inflight.join(", ");
        return _firstLine(this._userCode);
    }

    private _inFlight(): string[] {
        return [
            ...this._pendingDeferreds.values(),
            ...[...this._pendingTimers.values()].map((timer) =>
                `${timer.repeat ? "setInterval" : "setTimeout"}(${timer.delayMs}ms)`),
        ];
    }

    private _asParkedTask(): ParkedTask {
        return {
            inFlight: () => this._inFlight(),
            logs: this._logs,
            done: this._backgroundDone!,
            cancel: () => this.cancel(),
        };
    }

    public async cancel(): Promise<TaskOutcome> {
        if (this._settled) return this._settled;
        this._triggerSoftAbort("cancelled");
        this._cancelGraceDeadline = Date.now() + SOFT_CANCEL_GRACE_MS;
        // The background loop observes the grace deadline and force-settles.
        if (this._backgroundDone) return this._backgroundDone;
        // No background loop yet (cancelled mid-foreground): settle directly.
        this._forceSettle({ status: "cancelled", logs: this._logs.slice() });
        return this._settled!;
    }

    /**
     * Flip the guest-visible `con.abortSignal.aborted` flag and reject every
     * in-flight host promise with an `AbortError` naming the call.
     */
    private _triggerSoftAbort(reason: string): void {
        if (this._vmState.softAborted || !this._vmState.alive) return;
        this._vmState.softAborted = true;
        this._vmState.softAbortReason = reason;
        this._abortController.abort(reason);
        this._clearAllTimers();

        this._cpuDeadline = Date.now() + this._cpuBurstMs;
        const setFlag = this._vm.evalCode(
            `(() => {
                if (globalThis.con && globalThis.con.abortSignal) {
                    globalThis.con.abortSignal.aborted = true;
                    globalThis.con.abortSignal.reason = ${JSON.stringify(reason)};
                }
            })()`,
        );
        if (setFlag.error) setFlag.error.dispose();
        else setFlag.value.dispose();

        const entries = [...this._pendingDeferreds];
        this._pendingDeferreds.clear();
        for (const [d, label] of entries) {
            if (!d.alive) continue;
            this._vm.newError(`AbortError: ${reason} (cancelled in-flight: ${label})`)
                .consume((errH) => d.reject(errH));
        }
        this._pump();
    }

    private _dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._vmState.alive = false;
        if (!this._abortController.signal.aborted) {
            this._abortController.abort("sandbox disposed");
        }
        this._clearAllTimers();
        for (const d of this._pendingDeferreds.keys()) {
            if (d.alive) d.dispose();
        }
        this._pendingDeferreds.clear();
        if (this._promiseH && this._promiseH.alive) this._promiseH.dispose();
        this._scope.dispose();
    }

    private _terminalOutcome(): SandboxOutcome {
        const o = this._settled;
        if (!o) throw new Error("sandbox: terminal outcome requested before settling");
        if (o.status === "completed") return { status: "completed", result: o.result, logs: o.logs };
        if (o.status === "cancelled") {
            // A foreground (non-parking) run that cancels is reported as an error.
            return { status: "error", error: "sandbox cancelled", logs: o.logs };
        }
        return { status: "error", error: o.error, logs: o.logs };
    }

    private _installHostApi(): void {
        this._registerAsyncHostFn(
            "__hostCall",
            (method, paramsJson, optsJson, emit) =>
                this._host.call(
                    method,
                    paramsJson,
                    optsJson,
                    emit,
                    this._abortController.signal,
                ),
            (method) => `con.call(${JSON.stringify(method)})`,
            "__dispatchHostStream",
        );
        this._registerAsyncHostFn(
            "__hostNotify",
            (m, p) => this._host.notify(m, p),
            (method) => `con.notify(${JSON.stringify(method)})`,
        );
        this._registerAsyncHostFn(
            "__hostExplore",
            (a) => this._host.explore(a),
            () => `con.explore(...)`,
        );

        this._registerAsyncHostFn(
            "__hostRequestAccess",
            (a) => this._host.requestAccess(a),
            () => `con.requestAccess(...)`,
        );

        this._registerAsyncHostFn(
            "__hostGrants",
            (a) => this._host.grants(a),
            () => `con.grants()`,
        );

        this._vm.newFunction("__hostLog", (levelH, textH) => {
            const level = this._vm.getString(levelH) as "log" | "warn" | "error";
            const text = textH ? this._vm.getString(textH) : "";
            this._logs.push({ level, text });
        }).consume((fn) => this._vm.setProp(this._vm.global, "__hostLog", fn));

        this._vm.newFunction("__hostSetTimer", (idH, delayH, repeatH) => {
            this._setTimer(
                this._vm.getNumber(idH),
                this._vm.getNumber(delayH),
                this._vm.getNumber(repeatH) === 1,
            );
        }).consume((fn) => this._vm.setProp(this._vm.global, "__hostSetTimer", fn));

        this._vm.newFunction("__hostClearTimer", (idH) => {
            this._clearTimer(this._vm.getNumber(idH));
        }).consume((fn) => this._vm.setProp(this._vm.global, "__hostClearTimer", fn));
    }

    private _setTimer(timerId: number, delayMs: number, repeat: boolean): void {
        this._clearTimer(timerId);
        if (!this._vmState.alive || this._vmState.softAborted) return;
        const normalizedDelay = Math.min(Math.max(0, Math.floor(delayMs)), 2_147_483_647);
        const callback = () => {
            if (!this._vmState.alive || this._disposed) return;
            if (!repeat) this._pendingTimers.delete(timerId);
            this._dispatchGuestFunction("__dispatchHostTimer", timerId);
        };
        const handle = repeat
            ? setInterval(callback, normalizedDelay)
            : setTimeout(callback, normalizedDelay);
        this._pendingTimers.set(timerId, { handle, repeat, delayMs: normalizedDelay });
    }

    private _clearTimer(timerId: number): void {
        const timer = this._pendingTimers.get(timerId);
        if (!timer) return;
        if (timer.repeat) clearInterval(timer.handle);
        else clearTimeout(timer.handle);
        this._pendingTimers.delete(timerId);
    }

    private _clearAllTimers(): void {
        for (const timerId of [...this._pendingTimers.keys()]) {
            this._clearTimer(timerId);
        }
    }

    private _dispatchGuestFunction(name: string, ...args: readonly (string | number)[]): void {
        if (!this._vmState.alive || this._disposed || this._settled) return;
        this._cpuDeadline = Date.now() + this._cpuBurstMs;
        const result = this._vm.evalCode(
            `globalThis[${JSON.stringify(name)}](...${JSON.stringify(args)})`,
        );
        if (result.error) {
            const dumped = this._vm.dump(result.error);
            result.error.dispose();
            const error = _toError(dumped);
            this._settleError(error.message, _formatGuestError(dumped));
            return;
        }
        result.value.dispose();
        this._pump();
    }

    private _registerAsyncHostFn(
        name: string,
        impl: (
            a: string,
            b: string,
            c: string,
            emit: (payloadJson: string) => void,
        ) => Promise<string>,
        label: (a: string, b: string, c: string) => string,
        guestEventHandler?: string,
    ): void {
        this._vm.newFunction(name, (aH, bH, cH, eventIdH) => {
            const a = aH ? this._vm.getString(aH) : "";
            const b = bH ? this._vm.getString(bH) : "";
            const c = cH ? this._vm.getString(cH) : "";
            const eventId = eventIdH ? this._vm.getString(eventIdH) : "";
            const deferred = this._vm.newPromise();
            if (this._vmState.softAborted) {
                const reason = this._vmState.softAbortReason ?? "soft deadline reached";
                this._vm.newError(`AbortError: ${reason} (refused: ${label(a, b, c)})`)
                    .consume((errH) => deferred.reject(errH));
                deferred.settled.then(() => this._pump());
                return deferred.handle;
            }
            this._pendingDeferreds.set(deferred, label(a, b, c));
            impl(a, b, c, (payloadJson) => {
                if (guestEventHandler && eventId !== "") {
                    this._dispatchGuestFunction(guestEventHandler, eventId, payloadJson);
                }
            }).then(
                (value) => {
                    this._pendingDeferreds.delete(deferred);
                    if (!this._vmState.alive || !deferred.alive) return;
                    this._vm.newString(value).consume((sH) => deferred.resolve(sH));
                },
                (err: unknown) => {
                    this._pendingDeferreds.delete(deferred);
                    if (!this._vmState.alive || !deferred.alive) return;
                    this._newGuestHostError(err).consume((errH) => deferred.reject(errH));
                },
            );
            // Pump once the promise settles so the guest continuation runs.
            deferred.settled.then(() => this._pump());
            return deferred.handle;
        }).consume((fn) => this._vm.setProp(this._vm.global, name, fn));
    }

    private _newGuestHostError(thrown: unknown): QuickJSHandle {
        const snapshot = _snapshotHostRejection(thrown);
        const source = `(() => {
            const error = new Error(${JSON.stringify(snapshot.summary)});
            const properties = JSON.parse(${JSON.stringify(JSON.stringify(snapshot.properties))});
            for (const [key, value] of Object.entries(properties)) {
                Object.defineProperty(error, key, {
                    value,
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            }
            return error;
        })()`;
        const result = this._vm.evalCode(source);
        if (result.error) {
            result.error.dispose();
            return this._vm.newError(snapshot.summary);
        }
        return result.value;
    }
}

interface HostRejectionSnapshot {
    readonly summary: string;
    readonly properties: Readonly<Record<string, unknown>>;
}

const MAX_REJECTION_DEPTH = 8;
const MAX_REJECTION_PROPERTIES = 100;
const MAX_REJECTION_ARRAY_ITEMS = 100;
const MAX_REJECTION_STRING_LENGTH = 20_000;
const MAX_REJECTION_NODES = 1_000;
const MAX_REJECTION_TOTAL_STRING_LENGTH = 100_000;

interface SnapshotBudget {
    nodes: number;
    stringChars: number;
}

function _snapshotHostRejection(thrown: unknown): HostRejectionSnapshot {
    return {
        summary: _rejectionSummary(thrown),
        properties: _snapshotOwnDataProperties(thrown),
    };
}

function _rejectionSummary(thrown: unknown): string {
    if (thrown === null) return "Host operation rejected with null";
    if (typeof thrown !== "object" && typeof thrown !== "function") {
        return `Host operation rejected with ${String(thrown)}`;
    }
    return "Host operation failed";
}

function _snapshotOwnDataProperties(value: unknown): Readonly<Record<string, unknown>> {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return { value: _snapshotBridgeValue(value, new WeakSet(), 0, _newSnapshotBudget()) };
    }
    let descriptors: PropertyDescriptorMap;
    try {
        descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
        return {};
    }
    const seen = new WeakSet<object>();
    seen.add(value as object);
    const budget = _newSnapshotBudget();
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors).slice(0, MAX_REJECTION_PROPERTIES)) {
        if (!("value" in descriptor)) continue;
        result[key] = _snapshotBridgeValue(descriptor.value, seen, 0, budget);
    }
    return result;
}

function _newSnapshotBudget(): SnapshotBudget {
    return {
        nodes: MAX_REJECTION_NODES,
        stringChars: MAX_REJECTION_TOTAL_STRING_LENGTH,
    };
}

function _snapshotBridgeValue(
    value: unknown,
    seen: WeakSet<object>,
    depth: number,
    budget: SnapshotBudget,
): unknown {
    if (budget.nodes <= 0) return "[Truncated]";
    budget.nodes--;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
        const available = Math.min(MAX_REJECTION_STRING_LENGTH, budget.stringChars);
        budget.stringChars -= Math.min(value.length, available);
        return value.length <= available ? value : `${value.slice(0, available)}…`;
    }
    if (typeof value === "undefined") return "[undefined]";
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "symbol") return String(value);
    if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`;
    if (depth >= MAX_REJECTION_DEPTH) return "[Truncated]";
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) {
        return value
            .slice(0, MAX_REJECTION_ARRAY_ITEMS)
            .map((item) => _snapshotBridgeValue(item, seen, depth + 1, budget));
    }
    let descriptors: PropertyDescriptorMap;
    try {
        descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
        return "[Uninspectable]";
    }
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors).slice(0, MAX_REJECTION_PROPERTIES)) {
        if (!("value" in descriptor)) continue;
        result[key] = _snapshotBridgeValue(descriptor.value, seen, depth + 1, budget);
    }
    return result;
}

function _evalPrelude(vm: QuickJSContext, lastResultVal: unknown): void {
    // Per-run globals the bundled guest runtime reads by bare name
    // (`__lastResultVal`, `__docs`). Everything else — `con`, `console`, the
    // host marshalling — lives in `GUEST_RUNTIME_JS` (compiled from
    // `src/guest/guestMain.ts`).
    const header =
        `globalThis.__lastResultVal = JSON.parse(${JSON.stringify(JSON.stringify(lastResultVal ?? null))});\n` +
        `globalThis.__docs = ${JSON.stringify(CONNECTION_DTS)};\n`;
    const r = vm.evalCode(header + GUEST_RUNTIME_JS);
    if (r.error) {
        const err = vm.dump(r.error);
        r.error.dispose();
        throw new Error(`sandbox prelude failed: ${JSON.stringify(err)}`);
    }
    r.value.dispose();
}

function _wrapUserCode(userCode: string): string {
    // The user expression must evaluate to a function. We invoke it with
    // `{ con, lastResultVal, mcp }`, await its result, and JSON-stringify so the
    // host sees a plain string.
    return `(async () => {
    const __userFn = (${userCode});
    if (typeof __userFn !== "function") {
        throw new Error("runHubRpcScript: \`code\` must evaluate to a function, got " + typeof __userFn);
    }
    const __r = await __userFn({ con, lastResultVal: __lastResultVal, mcp });
    return __r === undefined ? "" : JSON.stringify(__r);
})()`;
}

function _firstLine(code: string): string {
    const line = code.split("\n", 1)[0].trim();
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function _toError(dumped: unknown): Error {
    let json: string;
    try { json = JSON.stringify(dumped); } catch { json = String(dumped); }
    if (dumped && typeof dumped === "object") {
        const d = dumped as { name?: unknown; message?: unknown; stack?: unknown };
        const hasMsg = typeof d.message === "string" && d.message.length > 0;
        const message = hasMsg ? (d.message as string) : `guest error (raw): ${json}`;
        const e = new Error(message);
        if (typeof d.stack === "string") (e as { stack?: string }).stack = d.stack;
        return e;
    }
    return new Error(`guest error: ${json}`);
}

/**
 * Format a dumped guest error as `message` plus its guest stack (when QuickJS
 * provided one). The host only forwards the `error` string to the caller, so
 * folding the stack in here is the only way the guest trace ever reaches them.
 */
function _formatGuestError(dumped: unknown): string {
    const e = _toError(dumped);
    const stack = (e as { stack?: string }).stack;
    if (typeof stack === "string" && stack.length > 0) {
        return stack.includes(e.message) ? stack : `${e.message}\n${stack}`;
    }
    return e.message;
}
