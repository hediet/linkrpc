import type { JsonValue } from '@hediet/linkrpc';
import type { GraphCoverage, GraphMissingReason, GraphRef } from './interfaces';

export interface GraphNeed<TRef> {
    readonly ref: TRef;
    readonly paths: readonly string[];
}
export interface GraphHave<TRef> {
    readonly ref: TRef;
    readonly coverage: GraphCoverage;
}
export interface GraphLimits {
    readonly maxObjects: number;
    readonly maxBytes: number;
}
export interface GraphBatchRequest<TRef> {
    readonly needs: readonly GraphNeed<TRef>[];
    readonly have: readonly GraphHave<TRef>[];
    readonly limits: GraphLimits;
}
export interface GraphObject<TRef, TValue> {
    readonly ref: TRef;
    readonly value: TValue;
}
export interface MissingGraphObject<TRef> {
    readonly ref: TRef;
    readonly reason: GraphMissingReason;
    readonly detail?: string;
}
export interface GraphBatchResult<TRef, TValue> {
    readonly objects: GraphObject<TRef, TValue>[];
    readonly missing: MissingGraphObject<TRef>[];
    readonly complete: boolean;
}
export type GraphLookup<TValue> =
    | { readonly found: true; readonly value: TValue }
    | {
        readonly found: false;
        readonly reason: Exclude<GraphMissingReason, 'oversized'>;
        readonly detail?: string;
    };
export interface GraphLease {
    dispose(): void | Promise<void>;
}
export interface ImmutableGraphSource<TRef, TValue> {
    lookup(ref: TRef): GraphLookup<TValue> | Promise<GraphLookup<TValue>>;
    retainClosure?(ref: TRef): GraphLease | Promise<GraphLease>;
}
export interface ImmutableGraphRuntimeOptions<TRef> {
    readonly refKey: (ref: TRef) => string;
    readonly isRef: (value: unknown) => value is TRef;
}
interface QueueItem<TRef> {
    readonly ref: TRef;
    readonly selector: readonly string[];
}

export class ImmutableGraphRuntime<TRef, TValue extends JsonValue> {
    public constructor(
        private readonly _source: ImmutableGraphSource<TRef, TValue>,
        private readonly _options: ImmutableGraphRuntimeOptions<TRef>,
    ) { }

    public async batchObjGet(request: GraphBatchRequest<TRef>): Promise<GraphBatchResult<TRef, TValue>> {
        assertLimits(request.limits);
        const queue: QueueItem<TRef>[] = [];
        for (const need of request.needs) {
            for (const path of need.paths.length === 0 ? ['/'] : need.paths) {
                queue.push({ ref: need.ref, selector: parseSelector(path) });
            }
        }
        const leases: GraphLease[] = [];
        const errors: unknown[] = [];
        let result: GraphBatchResult<TRef, TValue> | undefined;
        try {
            if (this._source.retainClosure !== undefined) {
                const retained = new Set<string>();
                for (const need of request.needs) {
                    const key = this._options.refKey(need.ref);
                    if (retained.has(key)) continue;
                    leases.push(await this._source.retainClosure(need.ref));
                    retained.add(key);
                }
            }
            result = await this._batchObjGet(request, queue);
        } catch (error) {
            errors.push(error);
        }
        const outcomes = await Promise.allSettled(leases.map(lease =>
            Promise.resolve().then(() => lease.dispose())));
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') errors.push(outcome.reason);
        }
        if (errors.length > 0) {
            throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Graph batch failed');
        }
        return result!;
    }

    private async _batchObjGet(
        request: GraphBatchRequest<TRef>,
        queue: QueueItem<TRef>[],
    ): Promise<GraphBatchResult<TRef, TValue>> {
        const lookupCache = new Map<string, GraphLookup<TValue>>();
        const lookup = async (ref: TRef): Promise<GraphLookup<TValue>> => {
            const key = this._options.refKey(ref);
            let result = lookupCache.get(key);
            if (result === undefined) {
                result = await this._source.lookup(ref);
                lookupCache.set(key, result);
            }
            return result;
        };
        const have = new Set<string>();
        for (const item of request.have) {
            if (item.coverage === 'object') {
                have.add(this._options.refKey(item.ref));
            } else {
                // A stale/incomplete closure claim must not hide available objects.
                const closure = [item.ref];
                const keys = new Set<string>();
                let complete = true;
                for (let i = 0; i < closure.length; i++) {
                    const ref = closure[i]!;
                    const key = this._options.refKey(ref);
                    if (keys.has(key)) continue;
                    keys.add(key);
                    const value = await lookup(ref);
                    if (!value.found) { complete = false; break; }
                    closure.push(...collectRefs(value.value, this._options.isRef));
                }
                if (complete) for (const key of keys) have.add(key);
            }
        }
        const objects: GraphObject<TRef, TValue>[] = [];
        const missing: MissingGraphObject<TRef>[] = [];
        const seenStates = new Set<string>();
        const emitted = new Set<string>();
        const reportedMissing = new Set<string>();
        let bytes = 0;
        for (let i = 0; i < queue.length; i++) {
            const current = queue[i]!;
            const refKey = this._options.refKey(current.ref);
            const stateKey = JSON.stringify([refKey, current.selector]);
            if (seenStates.has(stateKey) || reportedMissing.has(refKey)) continue;
            seenStates.add(stateKey);
            if (!have.has(refKey) && !emitted.has(refKey) && objects.length >= request.limits.maxObjects) {
                return { objects, missing, complete: false };
            }
            const value = await lookup(current.ref);
            if (!value.found) {
                missing.push({
                    ref: current.ref, reason: value.reason,
                    ...(value.detail === undefined ? {} : { detail: value.detail }),
                });
                reportedMissing.add(refKey);
                continue;
            }
            if (!have.has(refKey) && !emitted.has(refKey)) {
                const row = { ref: current.ref, value: value.value };
                const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
                if (rowBytes > request.limits.maxBytes) {
                    missing.push({
                        ref: current.ref, reason: 'oversized',
                        detail: `Encoded object is ${rowBytes} bytes; maxBytes is ${request.limits.maxBytes}.`,
                    });
                    reportedMissing.add(refKey);
                    continue;
                }
                if (bytes + rowBytes > request.limits.maxBytes) return { objects, missing, complete: false };
                objects.push(row);
                emitted.add(refKey);
                bytes += rowBytes;
            }
            this._enqueueSelectedRefs(queue, value.value, current.selector);
        }
        return { objects, missing, complete: true };
    }

    private _enqueueSelectedRefs(queue: QueueItem<TRef>[], value: JsonValue, selector: readonly string[]): void {
        if (selector.length === 0) return;
        const [head, ...tail] = selector;
        if (head === '**') {
            for (const ref of collectRefs(value, this._options.isRef)) queue.push({ ref, selector });
        } else if (head === '@') {
            if (this._options.isRef(value)) queue.push({ ref: value, selector: tail });
        } else if (head === '*') {
            for (const child of orderedChildren(value)) this._enqueueSelectedRefs(queue, child, tail);
        } else {
            const child = jsonChild(value, head!);
            if (child !== undefined) this._enqueueSelectedRefs(queue, child, tail);
        }
    }
}

type Stored<TValue> =
    | { readonly state: 'available'; readonly value: TValue }
    | {
        readonly state: 'missing';
        readonly reason: Exclude<GraphMissingReason, 'oversized'>;
        readonly detail?: string;
    };

export class InMemoryImmutableGraphStore<TRef, TValue extends JsonValue>
implements ImmutableGraphSource<TRef, TValue> {
    private readonly _objects = new Map<string, Stored<TValue>>();
    private readonly _identities = new Map<string, string>();
    private readonly _retained = new Map<string, number>();

    public constructor(private readonly _options: ImmutableGraphRuntimeOptions<TRef>) { }

    public set(ref: TRef, value: TValue): void {
        const key = this._options.refKey(ref);
        const serialized = JSON.stringify(value);
        const identity = this._identities.get(key);
        if (identity !== undefined && identity !== serialized) {
            throw new Error(`Immutable graph object "${key}" cannot be replaced.`);
        }
        this._objects.set(key, { state: 'available', value: freezeJson(structuredClone(value)) });
        this._identities.set(key, serialized);
    }

    public markUnavailable(ref: TRef, reason: Exclude<GraphMissingReason, 'oversized'>, detail?: string): void {
        const key = this._options.refKey(ref);
        if ((this._retained.get(key) ?? 0) > 0) {
            throw new Error(`Retained graph object "${key}" cannot be made unavailable.`);
        }
        this._objects.set(key, {
            state: 'missing', reason, ...(detail === undefined ? {} : { detail }),
        });
    }

    public lookup(ref: TRef): GraphLookup<TValue> {
        const stored = this._objects.get(this._options.refKey(ref));
        if (stored === undefined) return { found: false, reason: 'missing' };
        if (stored.state === 'missing') {
            return {
                found: false, reason: stored.reason,
                ...(stored.detail === undefined ? {} : { detail: stored.detail }),
            };
        }
        return { found: true, value: stored.value };
    }

    public retainClosure(ref: TRef): GraphLease {
        const keys = new Set<string>();
        const seen = new Set<string>();
        const queue = [ref];
        for (let i = 0; i < queue.length; i++) {
            const current = queue[i]!;
            const key = this._options.refKey(current);
            if (seen.has(key)) continue;
            seen.add(key);
            const lookup = this.lookup(current);
            if (!lookup.found) continue;
            keys.add(key);
            queue.push(...collectRefs(lookup.value, this._options.isRef));
        }
        for (const key of keys) this._retained.set(key, (this._retained.get(key) ?? 0) + 1);
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                for (const key of keys) {
                    const count = this._retained.get(key)!;
                    if (count <= 1) this._retained.delete(key);
                    else this._retained.set(key, count - 1);
                }
            },
        };
    }

    public isRetained(ref: TRef): boolean {
        return (this._retained.get(this._options.refKey(ref)) ?? 0) > 0;
    }
}

export const standardGraphRuntimeOptions: ImmutableGraphRuntimeOptions<GraphRef> = {
    refKey: ref => JSON.stringify([ref.kind, ref.id]),
    isRef: isGraphRef,
};

export function isGraphRef(value: unknown): value is GraphRef {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return Object.keys(candidate).length === 2
        && typeof candidate.kind === 'string' && typeof candidate.id === 'string';
}

function parseSelector(path: string): readonly string[] {
    if (path === '/') return [];
    if (!path.startsWith('/')) throw new Error(`Graph path "${path}" must start with "/".`);
    const segments = path.slice(1).split('/').map(segment => {
        if (/~(?:[^01]|$)/.test(segment)) {
            throw new Error(`Invalid JSON pointer escape in graph path segment "${segment}".`);
        }
        return segment.replace(/~1/g, '/').replace(/~0/g, '~');
    });
    if (segments.includes('**') && segments.indexOf('**') !== segments.length - 1) {
        throw new Error('Graph closure selector "**" must be the final path segment.');
    }
    return segments;
}

function jsonChild(value: JsonValue, segment: string): JsonValue | undefined {
    if (Array.isArray(value)) return /^(0|[1-9]\d*)$/.test(segment) ? value[Number(segment)] : undefined;
    if (value !== null && typeof value === 'object' && Object.hasOwn(value, segment)) return value[segment];
    return undefined;
}

function orderedChildren(value: JsonValue): readonly JsonValue[] {
    if (Array.isArray(value)) return value;
    if (value === null || typeof value !== 'object') return [];
    return Object.keys(value).sort().map(key => value[key]).filter((child): child is JsonValue => child !== undefined);
}

function collectRefs<TRef>(value: JsonValue, isRef: (value: unknown) => value is TRef): readonly TRef[] {
    const refs: TRef[] = [];
    const pending: JsonValue[] = [value];
    while (pending.length > 0) {
        const current = pending.pop()!;
        if (isRef(current)) refs.push(current);
        else {
            const children = orderedChildren(current);
            for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
        }
    }
    return refs;
}

function freezeJson<T extends JsonValue>(value: T): T {
    const pending: (JsonValue | undefined)[] = [value];
    while (pending.length > 0) {
        const item = pending.pop();
        if (item === null || typeof item !== 'object' || Object.isFrozen(item)) continue;
        pending.push(...Object.values(item));
        Object.freeze(item);
    }
    return value;
}

function assertLimits(limits: GraphLimits): void {
    if (!Number.isSafeInteger(limits.maxObjects) || limits.maxObjects <= 0) {
        throw new Error('maxObjects must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
        throw new Error('maxBytes must be a positive safe integer.');
    }
}
