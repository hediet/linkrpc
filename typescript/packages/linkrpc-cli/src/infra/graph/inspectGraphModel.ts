import type {
    JsonValue,
} from "@hediet/linkrpc";
import type {
    GraphBatchRequest as LinkRpcGraphBatchRequest,
    GraphBatchResult as LinkRpcGraphBatchResult,
    GraphHave as LinkRpcGraphHave,
    GraphNeed as LinkRpcGraphNeed,
    GraphObject as LinkRpcGraphObject,
    GraphRef,
    GraphLimits,
    MissingGraphObject,
} from "@hediet/linkrpc-infra/graph";
import { evaluateGraphPresentation, isGraphRef, standardGraphRuntimeOptions, type GraphPresentation } from "@hediet/linkrpc-infra/graph";
import type { GraphTimings } from "./inspectGraphTiming";

export type GraphBatchRequest = LinkRpcGraphBatchRequest<GraphRef>;
export type GraphBatchResult = LinkRpcGraphBatchResult<GraphRef, JsonValue>;
export type GraphHave = LinkRpcGraphHave<GraphRef>;
export type GraphNeed = LinkRpcGraphNeed<GraphRef>;
export type GraphObject = LinkRpcGraphObject<GraphRef, JsonValue>;
export type { GraphRef };

export type GraphBatchFetch = (
    request: GraphBatchRequest,
    signal: AbortSignal,
) => Promise<unknown>;

export interface GraphFetchOptions {
    readonly timings?: GraphTimings;
    readonly signal?: AbortSignal;
    readonly maxObjects?: number;
    readonly maxBytes?: number;
    readonly maxRounds?: number;
    readonly timeoutMs?: number;
}

export class GraphObjectCache {
    private readonly _objects = new Map<string, GraphObject>();

    public get size(): number {
        return this._objects.size;
    }

    public get(ref: GraphRef): GraphObject | undefined {
        return this._objects.get(graphRefKey(ref));
    }

    public has(ref: GraphRef): boolean {
        return this._objects.has(graphRefKey(ref));
    }

    public put(objects: readonly GraphObject[]): void {
        for (const object of objects) {
            const key = graphRefKey(object.ref);
            const previous = this._objects.get(key);
            if (previous !== undefined && !jsonEqual(previous.value, object.value)) {
                throw new Error(`Graph server returned conflicting values for ${formatGraphRef(object.ref)}`);
            }
            this._objects.set(key, object);
        }
    }

    public have(): readonly GraphHave[] {
        return [...this._objects.values()]
            .map(({ ref }) => ({ ref, coverage: "object" as const }))
            .sort((a, b) => graphRefKey(a.ref).localeCompare(graphRefKey(b.ref)));
    }
}

export class GraphLoader {
    private readonly _limits: GraphLimits;
    private readonly _maxRounds: number;
    private readonly _timeoutMs: number;
    private readonly _signal: AbortSignal | undefined;
    private readonly _timings: GraphTimings | undefined;

    public constructor(
        private readonly _fetch: GraphBatchFetch,
        public readonly cache = new GraphObjectCache(),
        options: GraphFetchOptions = {},
    ) {
        this._signal = options.signal;
        this._timings = options.timings;
        this._limits = {
            maxObjects: options.maxObjects ?? 256,
            maxBytes: options.maxBytes ?? 1_048_576,
        };
        this._maxRounds = options.maxRounds ?? 32;
        this._timeoutMs = options.timeoutMs ?? 5_000;
        if (!Number.isInteger(this._limits.maxObjects) || this._limits.maxObjects <= 0) {
            throw new Error("maxObjects must be a positive integer");
        }
        if (!Number.isInteger(this._limits.maxBytes) || this._limits.maxBytes <= 0) {
            throw new Error("maxBytes must be a positive integer");
        }
        if (!Number.isInteger(this._maxRounds) || this._maxRounds <= 0) {
            throw new Error("maxRounds must be a positive integer");
        }
        if (!Number.isInteger(this._timeoutMs) || this._timeoutMs <= 0) {
            throw new Error("timeoutMs must be a positive integer");
        }
    }

    public async load(needs: readonly GraphNeed[]): Promise<void> {
        const normalizedNeeds = normalizeNeeds(needs);
        const objectOnly = normalizedNeeds.every(need => need.paths.every(path => path === "/"));
        for (let round = 0; ; round++) {
            this._signal?.throwIfAborted();
            const pendingNeeds = objectOnly
                ? normalizedNeeds.filter(need => !this.cache.has(need.ref))
                : normalizedNeeds;
            if (pendingNeeds.length === 0) return;
            if (round >= this._maxRounds) {
                throw new Error(
                    `Graph fetch did not converge after ${this._maxRounds} rounds; `
                    + `${normalizedNeeds.length} need(s) remain`,
                );
            }
            const before = this.cache.size;
            const fetch = () => withTimeout(
                (signal) => this._fetch({
                    needs: pendingNeeds,
                    // Object-only reads cannot encounter cached descendants.
                    have: objectOnly ? [] : this.cache.have(),
                    limits: this._limits,
                }, signal),
                this._timeoutMs,
                "graph batch fetch",
                this._signal,
            );
            const raw = await (this._timings?.measureAsync("fetch", fetch, { needs: pendingNeeds.length, round }) ?? fetch());
            const processResult = () => {
                const result = parseGraphBatchResult(raw);
                assertNoMissing(result.missing);
                this.cache.put(result.objects);
                return result;
            };
            const result = this._timings?.measureSync("cache", processResult) ?? processResult();
            if (result.complete) return;
            if (this.cache.size === before) {
                throw new Error(
                    "Graph server returned an incomplete batch without progress",
                );
            }
        }
    }
}

export interface GraphTreeLine {
    readonly key: string;
    readonly depth: number;
    readonly text: string;
    readonly ref?: GraphRef;
    readonly expandable: boolean;
    readonly expanded?: boolean;
    readonly loaded?: boolean;
    readonly targetKey?: string;
    readonly summary?: string;
    readonly description?: string;
    readonly presentationPending?: readonly GraphRef[];
    readonly selector?: string;
}

export function createGraphTree(
    root: GraphRef,
    cache: GraphObjectCache,
    expanded: ReadonlySet<string>,
    maxDepth = Number.POSITIVE_INFINITY,
    presentation?: GraphPresentation,
): readonly GraphTreeLine[] {
    const lines: GraphTreeLine[] = [];
    const firstPaths = new Map<string, string>();
    appendRef(root, "$", 0, new Set(), lines, firstPaths, cache, expanded, maxDepth, []);
    if (presentation === undefined) return lines;
    return lines.map(line => {
        if (line.ref === undefined || !Object.hasOwn(presentation.rules, line.ref.kind)) return line;
        const result = evaluateGraphPresentation(line.ref, presentation, ref => cache.get(ref));
        return { ...line, summary: result.label, description: result.secondary, presentationPending: result.pending };
    });
}

export function graphRefsInValue(value: JsonValue): readonly GraphRef[] {
    const refs = new Map<string, GraphRef>();
    visitValue(value, (ref) => refs.set(graphRefKey(ref), ref));
    return [...refs.values()];
}

export const graphRefKey = standardGraphRuntimeOptions.refKey;

export function formatGraphRef(ref: GraphRef): string {
    return `${ref.kind}:${ref.id}`;
}

export function parseGraphRef(value: unknown, location = "graph ref"): GraphRef {
    if (!isGraphRef(value)) throw new Error(`${location} must contain exactly string kind and id fields`);
    return value;
}

export function parseGraphBatchResult(value: unknown): GraphBatchResult {
    const record = asRecord(value, "graph batch result");
    if (!Array.isArray(record.objects)) {
        throw new Error("graph batch result.objects must be an array");
    }
    if (!Array.isArray(record.missing)) {
        throw new Error("graph batch result.missing must be an array");
    }
    if (typeof record.complete !== "boolean") {
        throw new Error("graph batch result.complete must be a boolean");
    }
    const objects = record.objects.map((item, index): GraphObject => {
        const object = asRecord(item, `graph batch result.objects[${index}]`);
        if (!Object.hasOwn(object, "value")) {
            throw new Error(`graph batch result.objects[${index}].value is required`);
        }
        assertJsonValue(object.value, `graph batch result.objects[${index}].value`);
        return {
            ref: parseGraphRef(object.ref, `graph batch result.objects[${index}].ref`),
            value: object.value,
        };
    });
    const missing = record.missing.map((item, index) =>
        parseMissing(item, `graph batch result.missing[${index}]`));
    return { objects, missing, complete: record.complete };
}

function parseGraphNeed(value: unknown, location: string): GraphNeed {
    const record = asRecord(value, location);
    if (!Array.isArray(record.paths)) {
        throw new Error(`${location}.paths must be an array`);
    }
    const paths = record.paths.map((path, pathIndex) => {
        if (typeof path !== "string" || !path.startsWith("/")) {
            throw new Error(`${location}.paths[${pathIndex}] must be a JSON pointer string`);
        }
        return path;
    });
    return { ref: parseGraphRef(record.ref, `${location}.ref`), paths };
}

function normalizeNeeds(needs: readonly GraphNeed[]): readonly GraphNeed[] {
    const result = new Map<string, { ref: GraphRef; paths: Set<string> }>();
    for (const need of needs) {
        const key = graphRefKey(need.ref);
        let entry = result.get(key);
        if (entry === undefined) {
            entry = { ref: need.ref, paths: new Set() };
            result.set(key, entry);
        }
        for (const path of need.paths) entry.paths.add(path);
    }
    return [...result.values()].map(({ ref, paths }) => ({ ref, paths: [...paths] }));
}

function parseMissing(value: unknown, location: string): MissingGraphObject<GraphRef> {
    const record = asRecord(value, location);
    const reasons = new Set(["missing", "expired", "forbidden", "oversized"]);
    if (typeof record.reason !== "string" || !reasons.has(record.reason)) {
        throw new Error(`${location}.reason is unsupported`);
    }
    if (record.detail !== undefined && typeof record.detail !== "string") {
        throw new Error(`${location}.detail must be a string when present`);
    }
    return {
        ref: parseGraphRef(record.ref, `${location}.ref`),
        reason: record.reason as MissingGraphObject<GraphRef>["reason"],
        ...(record.detail === undefined ? {} : { detail: record.detail }),
    };
}

function assertNoMissing(missing: readonly MissingGraphObject<GraphRef>[]): void {
    if (missing.length === 0) return;
    const details = missing.map((item) =>
        `${formatGraphRef(item.ref)}: ${item.reason}${item.detail === undefined ? "" : ` (${item.detail})`}`);
    throw new Error(`Graph references unavailable:\n${details.map((line) => `  ${line}`).join("\n")}`);
}

function appendRef(
    ref: GraphRef,
    path: string,
    depth: number,
    ancestors: ReadonlySet<string>,
    lines: GraphTreeLine[],
    firstPaths: Map<string, string>,
    cache: GraphObjectCache,
    expanded: ReadonlySet<string>,
    maxDepth: number,
    selector: readonly string[] | undefined,
): void {
    const refKey = graphRefKey(ref);
    const priorPath = firstPaths.get(refKey);
    const cycle = ancestors.has(refKey);
    const object = cache.get(ref);
    const marker = cycle
        ? ` ↩ cycle to ${priorPath ?? formatGraphRef(ref)}`
        : priorPath !== undefined ? ` ↗ shared with ${priorPath}` : "";
    lines.push({
        key: path,
        depth,
        text: `${path} → ${formatGraphRef(ref)}${object === undefined ? " [not loaded]" : marker}`,
        ref,
        ...(selector === undefined ? {} : { selector: selector.length === 0 ? "/" : `/${selector.join("/")}` }),
        expandable: !cycle && priorPath === undefined && depth < maxDepth,
        expanded: expanded.has(refKey),
        loaded: object !== undefined,
        targetKey: cycle || priorPath !== undefined ? priorPath : undefined,
        summary: object?.value !== null && typeof object?.value === "object" && !Array.isArray(object.value)
            ? typeof object.value.title === "string" ? object.value.title
                : typeof object.value.name === "string" ? object.value.name : undefined
            : undefined,
    });
    if (object === undefined || cycle || priorPath !== undefined || depth >= maxDepth) return;
    firstPaths.set(refKey, path);
    if (!expanded.has(refKey)) return;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(refKey);
    appendValue(object.value, path, depth + 1, nextAncestors, lines, firstPaths, cache, expanded, maxDepth, selector);
}

function appendValue(
    value: JsonValue,
    path: string,
    depth: number,
    ancestors: ReadonlySet<string>,
    lines: GraphTreeLine[],
    firstPaths: Map<string, string>,
    cache: GraphObjectCache,
    expanded: ReadonlySet<string>,
    maxDepth: number,
    selector: readonly string[] | undefined,
): void {
    if (isGraphRef(value)) {
        appendRef(value, path, depth, ancestors, lines, firstPaths, cache, expanded, maxDepth,
            selector === undefined ? undefined : [...selector, "@"]);
        return;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) lines.push({ key: path, depth, text: `${path} = []`, expandable: false });
        value.forEach((item, index) =>
            appendValue(item, `${path}[${index}]`, depth, ancestors, lines, firstPaths, cache, expanded, maxDepth,
                selector === undefined ? undefined : [...selector, String(index)]));
        return;
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value);
        if (entries.length === 0) lines.push({ key: path, depth, text: `${path} = {}`, expandable: false });
        for (const [name, child] of entries) {
            if (child !== undefined) {
                appendValue(child, propertyPath(path, name), depth, ancestors, lines, firstPaths, cache, expanded, maxDepth,
                    selector === undefined || name === "*" || name === "**" || name === "@"
                        ? undefined : [...selector, name.replaceAll("~", "~0").replaceAll("/", "~1")]);
            }
        }
        return;
    }
    lines.push({ key: path, depth, text: `${path} = ${JSON.stringify(value)}`, expandable: false });
}

function visitValue(value: JsonValue, visitor: (ref: GraphRef) => void): void {
    if (isGraphRef(value)) {
        visitor(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) visitValue(item, visitor);
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) {
            if (child !== undefined) visitValue(child, visitor);
        }
    }
}

function propertyPath(parent: string, name: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(name)
        ? `${parent}.${name}`
        : `${parent}[${JSON.stringify(name)}]`;
}

export async function withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label: string,
    signal?: AbortSignal,
): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let onAbort!: () => void;
    const timeout = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
            controller.abort(signal?.reason);
            reject(controller.signal.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
            const error = new Error(`${label} timed out after ${timeoutMs}ms`);
            controller.abort(error);
            reject(error);
        }, timeoutMs);
    });
    try {
        return await Promise.race([operation(controller.signal), timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${location} must be an object`);
    }
    return value as Record<string, unknown>;
}

function assertJsonValue(value: unknown, location: string): asserts value is JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonValue(item, `${location}[${index}]`));
        return;
    }
    if (typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            assertJsonValue(child, `${location}.${key}`);
        }
        return;
    }
    throw new Error(`${location} must be a JSON value`);
}

function jsonEqual(a: JsonValue, b: JsonValue): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
