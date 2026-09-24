import { LocalGraphSource, standardGraphRuntimeOptions, type GraphRef, type GraphSource, type GraphStore, type JsonValue } from "./source.js";

/** Deferred references are assigned exactly once; retention never starts a load. */
export class LazyGraphSource implements GraphSource {
    private readonly _local: LocalGraphSource;
    private readonly _loads = new Map<string, () => Promise<JsonValue>>();
    private readonly _pending = new Map<string, Promise<void>>();
    private _nextId = 0;
    public readonly root;
    public readonly store: GraphStore;

    public constructor(namespace?: string) {
        this._local = new LocalGraphSource(namespace);
        this.root = this._local.root;
        this.store = {
            lookup: async ref => {
                const key = standardGraphRuntimeOptions.refKey(ref);
                const load = this._loads.get(key);
                if (load) {
                    let pending = this._pending.get(key);
                    if (!pending) {
                        pending = Promise.resolve().then(load).then(value => {
                            this._local.store.set(ref, value);
                            this._loads.delete(key);
                            this._pending.delete(key);
                        });
                        this._pending.set(key, pending);
                    }
                    await pending;
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
        const ref = Object.freeze({ kind, id: `${this._local.namespace}/lazy/${this._nextId++}` });
        this._loads.set(standardGraphRuntimeOptions.refKey(ref), load);
        return ref;
    }
}
