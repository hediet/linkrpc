import { LocalGraphSource, standardGraphRuntimeOptions, type GraphRef, type GraphSource, type GraphStore, type JsonValue } from "./source.js";

/** Deferred references are assigned exactly once; retention never starts a load. */
export class LazyGraphSource implements GraphSource {
    private readonly _local: LocalGraphSource;
    private readonly _loads = new Map<string, () => Promise<JsonValue>>();
    private readonly _pending = new Map<string, Promise<JsonValue>>();
    private _nextId = 0;
    private _disposed = false;
    public readonly root;
    public readonly store: GraphStore;

    public constructor(namespace?: string) {
        this._local = new LocalGraphSource(namespace);
        this._local.onDidCollect(reachable => {
            for (const key of this._loads.keys()) {
                if (!reachable.has(key) && !this._pending.has(key)) this._loads.delete(key);
            }
        });
        this.root = this._local.root;
        this.store = {
            lookup: async ref => {
                const key = standardGraphRuntimeOptions.refKey(ref);
                const load = this._loads.get(key);
                if (load) {
                    let pending = this._pending.get(key);
                    if (!pending) {
                        const lease = this._local.store.retainClosure(ref);
                        pending = Promise.resolve().then(load).then(value => {
                            if (!this._disposed) this._local.store.set(ref, value);
                            this._loads.delete(key);
                            return value;
                        }).finally(() => {
                            this._pending.delete(key);
                            lease.dispose();
                        });
                        this._pending.set(key, pending);
                    }
                    const value = await pending;
                    if (this._disposed) return { found: true, value };
                }
                return this._local.store.lookup(ref);
            },
            peek: ref => this._local.store.lookup(ref),
            retainClosure: ref => this._local.store.retainClosure(ref),
        };
    }

    public put(kind: string, value: JsonValue): GraphRef {
        return this._local.put(kind, value);
    }

    public defer(kind: string, load: () => Promise<JsonValue>): GraphRef {
        if (this._disposed) throw new Error('Graph source is disposed.');
        const ref = Object.freeze({ kind, id: `${this._local.namespace}/lazy/${this._nextId++}` });
        this._loads.set(standardGraphRuntimeOptions.refKey(ref), load);
        return ref;
    }

    public collectGarbage(): void {
        this._local.collectGarbage();
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._local.dispose();
        this._loads.clear();
        this._pending.clear();
    }

    public get diagnostics(): { deferred: number; pending: number; interned: number; objects: number; identities: number; retainedRoots: number } {
        return { deferred: this._loads.size, pending: this._pending.size, ...this._local.diagnostics };
    }
}
