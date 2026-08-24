import {
    Disposable,
    ObservableLazyPromise,
    ObservablePromise,
    autorun,
    derived,
    observableValue,
} from "@vscode/observables";
import type {
    MethodSchema,
    HubRpcInterfaceSchema as SvcInterfaceSchema,
    HubRpcJsonSchema as SvcJsonSchema,
} from "@vscode/hubrpc";
import {
    type CliChannel,
    fetchDefaults,
    fetchSchema,
    walkHubDetailed,
} from "@vscode/hubrpc-client";
import { validateValueAgainstSchema } from "../validation";

export interface MethodKey {
    /** "" means the root (no `serviceId::` prefix on the wire). */
    readonly serviceId: string;
    readonly interfaceId: string;
    /** The synthetic default entry invokes methods in bare form. */
    readonly isDefault?: boolean;
    /** `undefined` => no method picked yet; the view shows the method list. */
    readonly methodName: string | undefined;
}

export interface UiServiceListing {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly hash?: string;
    readonly discoveredFrom: string;
    readonly path?: string;
    readonly isDefault?: boolean;
}

export interface CallOutcome {
    readonly result: unknown;
    readonly latencyMs: number;
}

export interface HistoryEntry {
    readonly method: string;
    readonly params: unknown;
    readonly result: unknown | undefined;
    readonly error: unknown | undefined;
    readonly latencyMs: number;
    readonly timestamp: number;
}

export type SchemaState =
    | { kind: "none" }
    | { kind: "loading" }
    | { kind: "error"; error: unknown }
    | { kind: "loaded"; schema: SvcInterfaceSchema; method: MethodSchema | undefined };

export interface FieldDesc {
    readonly name: string;
    readonly required: boolean;
    readonly schema: SvcJsonSchema;
}

export type MethodListItem = MethodSchema & { readonly name: string };

/**
 * View model for the TUI. Owns the live channel and an in-memory schema cache
 * keyed by interface id. Loading state for every async lookup is expressed as
 * an `ObservablePromise` from `@vscode/observables` — no ad-hoc loading flags.
 */
export class UiModel extends Disposable {
    /** Initial directory fetch — kicked off in the constructor. */
    public readonly servicesPromise: ObservablePromise<UiServiceListing[]>;

    /** Non-fatal discovery failures for services that could not be inspected. */
    public readonly discoveryWarnings = observableValue<readonly string[]>(
        "UiModel.discoveryWarnings",
        [],
    );

    public readonly selection = observableValue<MethodKey | undefined>(
        "UiModel.selection",
        undefined,
    );

    public readonly formValues = observableValue<Record<string, unknown>>(
        "UiModel.formValues",
        {},
    );

    /** Index of the currently-focused form field (clamped at render time). */
    public readonly formCursor = observableValue<number>(
        "UiModel.formCursor",
        0,
    );

    /** True when the focused field is in input mode (text being typed). */
    public readonly formEditing = observableValue<boolean>(
        "UiModel.formEditing",
        false,
    );

    /** Which Miller column currently owns keyboard focus. */
    public readonly focusedColumn = observableValue<0 | 1 | 2>(
        "UiModel.focusedColumn",
        0,
    );

    public readonly rawJsonMode = observableValue<boolean>(
        "UiModel.rawJsonMode",
        false,
    );

    public readonly rawJsonText = observableValue<string>(
        "UiModel.rawJsonText",
        "{}",
    );

    public readonly history = observableValue<HistoryEntry[]>(
        "UiModel.history",
        [],
    );

    /**
     * Wraps the in-flight call (if any). `undefined` until the user first
     * submits, then re-assigned on each submit. The view reads
     * `promiseResult` to render loading / result / error.
     */
    public readonly lastCall = observableValue<ObservablePromise<CallOutcome> | undefined>(
        "UiModel.lastCall",
        undefined,
    );

    /**
     * Server→client stream messages received during the in-flight call.
     * Reset to `[]` on each `submit()`, then appended to as `$stream::send`
     * notifications arrive. The view renders these live below the result.
     */
    public readonly streamChunks = observableValue<readonly unknown[]>(
        "UiModel.streamChunks",
        [],
    );

    /**
     * One-line, human-readable description of the identity signing outbound
     * calls (e.g. `managed (node abcd012345…)`). Rendered in the header.
     * `undefined` until `runUi` resolves the principal.
     */
    public readonly identity = observableValue<string | undefined>(
        "UiModel.identity",
        undefined,
    );

    /**
     * Per-interface schema cache. `ObservableLazyPromise` defers the actual
     * fetch until something asks for it; the autorun below makes "something
     * asks" happen whenever a method on that interface is selected.
     */
    private readonly _schemas = new Map<string, ObservableLazyPromise<SvcInterfaceSchema>>();

    constructor(
        private readonly _channel: CliChannel,
    ) {
        super();
        this.servicesPromise = ObservablePromise.fromFn(async () => {
            const result = await loadUiServices(_channel);
            this.discoveryWarnings.set(result.warnings, undefined);
            return result.services;
        });
        // Drain the bare promise so an early close (test teardown, user quit
        // before the call settles) doesn't surface as an unhandled rejection.
        // The error is still observable via `servicesPromise.promiseResult`.
        this.servicesPromise.promise.catch(() => { });

        // When selection changes, kick the lazy schema promise so its
        // observable state starts ticking. The derived below only OBSERVES;
        // it doesn't trigger.
        this._register(autorun((reader) => {
            const sel = this.selection.read(reader);
            if (!sel) return;
            void this._getOrCreateSchema(
                sel.serviceId,
                sel.interfaceId,
                sel.isDefault === true,
            ).getPromise().catch(() => { });
        }));
        // Miller-column convenience: when the methods column gains focus and
        // no method is picked yet, auto-select the first one so the form
        // column shows a preview instead of an empty pane.
        this._register(autorun((reader) => {
            if (this.focusedColumn.read(reader) !== 1) return;
            const sel = this.selection.read(reader);
            if (!sel || sel.methodName !== undefined) return;
            const methods = this.currentMethods.read(reader);
            if (methods.length === 0) return;
            this.selection.set({ ...sel, methodName: methods[0].name }, undefined);
        }));
    }

    public readonly currentSchemaState = derived(this, (reader): SchemaState => {
        const sel = this.selection.read(reader);
        if (!sel) return { kind: "none" };
        const lazy = this._getOrCreateSchema(
            sel.serviceId,
            sel.interfaceId,
            sel.isDefault === true,
        );
        const result = lazy.cachedPromiseResult.read(reader);
        if (!result) return { kind: "loading" };
        if (result.error) return { kind: "error", error: result.error };
        const schema = result.data!;
        const method = sel.methodName !== undefined
            ? schema.methods[sel.methodName]
            : undefined;
        return { kind: "loaded", schema, method };
    });

    /** Flat list of top-level fields for the currently-selected method. */
    public readonly currentFields = derived(this, (reader): readonly FieldDesc[] => {
        const state = this.currentSchemaState.read(reader);
        if (state.kind !== "loaded" || !state.method) return [];
        const paramsSchema = state.method.params;
        return collectTopLevelFields(
            paramsSchema,
            state.schema.components?.schemas ?? {},
        );
    });

    /** All methods on the currently-selected interface (column 2). */
    public readonly currentMethods = derived(this, (reader): readonly MethodListItem[] => {
        const state = this.currentSchemaState.read(reader);
        return state.kind === "loaded"
            ? Object.entries(state.schema.methods).map(([name, method]) => ({ name, ...method }))
            : [];
    });

    /**
     * Whether the currently-selected method declares stream payloads in
     * either direction. Drives the "streaming" affordance in the view.
     */
    public readonly currentMethodStreams = derived(this, (reader): { server: boolean; client: boolean } => {
        const state = this.currentSchemaState.read(reader);
        if (state.kind !== "loaded" || !state.method) return { server: false, client: false };
        return {
            server: state.method.serverStream !== undefined,
            client: state.method.clientStream !== undefined,
        };
    });

    /** Per-field validation errors against the live method schema. */
    public readonly formErrors = derived(this, (reader): ReadonlyMap<string, string> => {
        const state = this.currentSchemaState.read(reader);
        const errors = new Map<string, string>();
        if (state.kind !== "loaded" || !state.method) return errors;
        const paramsSchema = state.method.params;
        const components = state.schema.components?.schemas ?? {};
        const resolvedParamsSchema = resolveSchema(paramsSchema, components);
        if (!isObjectSchema(resolvedParamsSchema)) return errors;
        const values = this.formValues.read(reader);
        const required = new Set(resolvedParamsSchema.required ?? []);
        for (const [name, sub] of Object.entries(resolvedParamsSchema.properties)) {
            const value = values[name];
            if (value === undefined) {
                if (required.has(name)) errors.set(name, "required");
                continue;
            }
            const reason = validateValueAgainstSchema(value, sub, components);
            if (reason !== undefined) errors.set(name, reason);
        }
        return errors;
    });

    public readonly canSubmit = derived(this, (reader): boolean => {
        const sel = this.selection.read(reader);
        if (!sel || sel.methodName === undefined) return false;
        const state = this.currentSchemaState.read(reader);
        if (state.kind !== "loaded" || !state.method) return false;
        return this.formErrors.read(reader).size === 0;
    });

    public select(key: MethodKey): void {
        this.selection.set(key, undefined);
        this.formValues.set({}, undefined);
        this.rawJsonText.set("{}", undefined);
        this.formCursor.set(0, undefined);
        this.formEditing.set(false, undefined);
    }

    /** Pick a concrete method on the currently-selected service/interface. */
    public selectMethod(methodName: string): void {
        const sel = this.selection.get();
        if (!sel) return;
        this.select({ ...sel, methodName });
    }

    public focusColumn(column: 0 | 1 | 2): void {
        this.focusedColumn.set(column, undefined);
    }

    /**
     * Move the column-0 cursor by `delta`. The cursor is implicit: it's the
     * row whose `(serviceId, interfaceId)` matches the current selection.
     * Stepping off the ends clamps; methodName is cleared so the methods
     * column re-previews the new service.
     */
    public moveServiceCursor(delta: -1 | 1): void {
        const services = this.servicesPromise.promiseResult.get()?.data ?? [];
        if (services.length === 0) return;
        const sel = this.selection.get();
        const currentIdx = sel
            ? services.findIndex((s) =>
                s.serviceId === sel.serviceId
                && s.interfaceId === sel.interfaceId
                && (s.isDefault === true) === (sel.isDefault === true))
            : -1;
        const nextIdx = Math.max(0, Math.min(services.length - 1, currentIdx + delta));
        const next = services[nextIdx];
        this.select({
            serviceId: next.serviceId,
            interfaceId: next.interfaceId,
            methodName: undefined,
            ...(next.isDefault === true ? { isDefault: true } : {}),
        });
    }

    /**
     * Move the column-1 cursor by `delta`. Triggers a full `select()` so the
     * form column starts fresh for the newly-previewed method (Miller-style
     * "each cursor move is a new preview").
     */
    public moveMethodCursor(delta: -1 | 1): void {
        const methods = this.currentMethods.get();
        if (methods.length === 0) return;
        const sel = this.selection.get();
        if (!sel) return;
        const currentIdx = sel.methodName !== undefined
            ? methods.findIndex((m) => m.name === sel.methodName)
            : -1;
        const nextIdx = Math.max(0, Math.min(methods.length - 1, currentIdx + delta));
        this.selectMethod(methods[nextIdx].name);
    }

    public setField(name: string, value: unknown): void {
        const current = this.formValues.get();
        if (value === undefined) {
            // Clearing a field — drop the key so required-checks fire and so
            // wire payloads don't carry explicit `undefined`s.
            const { [name]: _drop, ...rest } = current;
            void _drop;
            this.formValues.set(rest, undefined);
            return;
        }
        this.formValues.set({ ...current, [name]: value }, undefined);
    }

    /**
     * Returns the exact `{ method, params }` `submit` would send right
     * now, or `undefined` when no method is fully selected. Lets a host
     * (e.g. the explorer's access-request prompt) preview the concrete
     * call before issuing a one-shot capability bound to it.
     */
    public peekPendingCall(): { method: string; params: unknown } | undefined {
        const sel = this.selection.get();
        if (!sel || sel.methodName === undefined) return undefined;
        const params = this._collectParams();
        const method = sel.isDefault === true
            ? sel.methodName
            : sel.serviceId
            ? `${sel.serviceId}::${sel.interfaceId}::${sel.methodName}`
            : `${sel.interfaceId}::${sel.methodName}`;
        return { method, params };
    }

    public submit(): void {
        const sel = this.selection.get();
        if (!sel || sel.methodName === undefined) return;
        const params = this._collectParams();
        const wireMethod = sel.isDefault === true
            ? sel.methodName
            : sel.serviceId
            ? `${sel.serviceId}::${sel.interfaceId}::${sel.methodName}`
            : `${sel.interfaceId}::${sel.methodName}`;
        const start = performance.now();
        this.streamChunks.set([], undefined);
        const promise = ObservablePromise.fromFn(async () => {
            // Stream-capable send: appends any server→client `$stream::send`
            // messages to `streamChunks` as they arrive, then resolves with
            // the call's final response. Behaves like a plain request when the
            // method does not stream.
            const call = this._channel.sendRequestWithStream(wireMethod, params as never, {
                onStreamMessage: (payload) => {
                    this.streamChunks.set([...this.streamChunks.get(), payload], undefined);
                },
            });
            const result = await call.result;
            return { result, latencyMs: performance.now() - start } satisfies CallOutcome;
        });
        this.lastCall.set(promise, undefined);
        // Record into history once it settles — keep one place that writes
        // the journal, so views don't have to worry about it.
        promise.promise.then(
            (outcome) => {
                this.history.set(
                    [
                        ...this.history.get(),
                        { method: wireMethod, params, result: outcome.result, error: undefined, latencyMs: outcome.latencyMs, timestamp: Date.now() },
                    ],
                    undefined,
                );
            },
            (error) => {
                const latencyMs = performance.now() - start;
                this.history.set(
                    [
                        ...this.history.get(),
                        { method: wireMethod, params, result: undefined, error, latencyMs, timestamp: Date.now() },
                    ],
                    undefined,
                );
            },
        );
    }

    private _collectParams(): unknown {
        if (this.rawJsonMode.get()) {
            const text = this.rawJsonText.get().trim();
            if (text.length === 0) return undefined;
            try {
                return JSON.parse(text);
            } catch {
                // The view shows the parse error; submit still sends the
                // unparsable text as a string so the wire layer can complain.
                return text;
            }
        }
        return this.formValues.get();
    }

    private _getOrCreateSchema(
        serviceId: string,
        interfaceId: string,
        isDefault: boolean,
    ): ObservableLazyPromise<SvcInterfaceSchema> {
        const key = `${isDefault ? "default" : serviceId}::${interfaceId}`;
        let p = this._schemas.get(key);
        if (!p) {
            // Fetch schemas from the directory that reported the interface.
            const listings = this.servicesPromise.promiseResult.get()?.data ?? [];
            const match = listings.find(
                (s) =>
                    s.serviceId === serviceId
                    && s.interfaceId === interfaceId
                    && (s.isDefault === true) === isDefault,
            );
            const reporter = isDefault ? "" : (match?.discoveredFrom ?? serviceId);
            const target = reporter === "" ? undefined : reporter;
            p = new ObservableLazyPromise(() =>
                fetchSchema(this._channel, interfaceId, match?.hash, target));
            this._schemas.set(key, p);
        }
        return p;
    }
}

interface UiServicesResult {
    readonly services: UiServiceListing[];
    readonly warnings: readonly string[];
}

async function loadUiServices(channel: CliChannel): Promise<UiServicesResult> {
    const [walkResult, defaultsResult] = await Promise.all([
        walkHubDetailed(channel),
        fetchDefaults(channel).then(
            (defaults) => ({ ok: true as const, defaults }),
            (error: unknown) => ({ ok: false as const, error }),
        ),
    ]);

    const warnings = walkResult.inaccessible.map(({ serviceId, reason }) =>
        `Service "${serviceId}" does not offer a usable hubrpc.directory::list: ${reason}`
    );
    if (!defaultsResult.ok) {
        warnings.push(
            `The root service does not offer hubrpc.defaults::get: ${getErrorMessage(defaultsResult.error)}`,
        );
        return { services: walkResult.listings, warnings };
    }

    const { defaults } = defaultsResult;
    if (defaults.interfaceId === undefined) {
        return { services: walkResult.listings, warnings };
    }
    return {
        services: [{
            serviceId: "",
            interfaceId: defaults.interfaceId,
            ...(defaults.hash === undefined ? {} : { hash: defaults.hash }),
            discoveredFrom: "",
            isDefault: true,
        }, ...walkResult.listings],
        warnings,
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function collectTopLevelFields(
    schema: SvcJsonSchema | undefined,
    components: Readonly<Record<string, SvcJsonSchema>>,
): FieldDesc[] {
    const resolved = resolveSchema(schema, components);
    if (!isObjectSchema(resolved)) return [];
    const required = new Set(resolved.required ?? []);
    return Object.entries(resolved.properties).map(([name, sub]) => ({
        name,
        required: required.has(name),
        schema: resolveSchema(sub, components) ?? sub,
    }));
}

function resolveSchema(
    schema: SvcJsonSchema | undefined,
    components: Readonly<Record<string, SvcJsonSchema>>,
    seen: ReadonlySet<string> = new Set(),
): SvcJsonSchema | undefined {
    if (
        schema === undefined
        || typeof schema !== "object"
        || !("$ref" in schema)
    ) {
        return schema;
    }
    const prefix = "#/components/schemas/";
    if (!schema.$ref.startsWith(prefix) || seen.has(schema.$ref)) {
        return schema;
    }
    const target = components[schema.$ref.slice(prefix.length)];
    if (target === undefined) {
        return schema;
    }
    return resolveSchema(target, components, new Set([...seen, schema.$ref]));
}

function isObjectSchema(
    s: SvcJsonSchema | undefined,
): s is Extract<SvcJsonSchema, { type: "object"; properties: Record<string, SvcJsonSchema> }> {
    return !!s
        && typeof s === "object"
        && "type" in s
        && s.type === "object"
        && "properties" in s;
}
