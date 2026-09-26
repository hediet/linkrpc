import { randomUUID } from 'node:crypto';
import { autorun, observableValue, runOnChange, type IObservable } from '@vscode/observables';
import type { JsonValue } from '@hediet/linkrpc';
import {
  InMemoryImmutableGraphStore,
  isGraphRef, standardGraphRuntimeOptions,
  type GraphRef, type ImmutableGraphSource, type GraphLease, type GraphLookup,
} from './index.js';

export type { JsonValue } from '@hediet/linkrpc';
export type { GraphRef, ImmutableGraphSource } from './index.js';
export { ImmutableGraphRuntime, standardGraphRuntimeOptions, isGraphRef } from './index.js';
export { graphInterface } from './protocol';
export { createGraphRuntime, registerGraphSource } from './registration';

export interface GraphSource {
  readonly root: IObservable<GraphRef>;
  readonly store: GraphStore;
}

export interface GraphStore extends ImmutableGraphSource<GraphRef, JsonValue> {
  /** Inspect already materialized data without triggering deferred I/O. */
  peek?(ref: GraphRef): GraphLookup<JsonValue> | Promise<GraphLookup<JsonValue>>;
}

export { LazyGraphSource } from './lazySource.js';

/** The supplied namespace is a label; each instance also gets a unique incarnation. */
export class LocalGraphSource implements GraphSource {
  public readonly namespace: string;
  public readonly store = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions);
  public readonly root;
  private readonly _interned = new Map<string, GraphRef>();
  private _nextId = 0;
  private _collection: ReturnType<typeof setTimeout> | undefined;
  private readonly _subscription;
  private _disposed = false;
  private readonly _collectionListeners = new Set<(reachable: ReadonlySet<string>) => void>();

  public constructor(namespace = 'source') {
    this.namespace = `${encodeURIComponent(namespace)}/${randomUUID()}`;
    this.root = observableValue<GraphRef>(this, this.put('empty', {}));
    this._subscription = runOnChange(this.root, () => this._scheduleCollection());
    this.store.setReleaseListener(() => this._scheduleCollection());
  }

  public put(kind: string, value: JsonValue): GraphRef {
    if (this._disposed) throw new Error('Graph source is disposed.');
    const normalized = normalizeJson(value);
    const key = JSON.stringify([kind, normalized]);
    const existing = this._interned.get(key);
    if (existing !== undefined) return existing;
    const ref = Object.freeze({ kind, id: `${this.namespace}/${this._nextId++}` });
    this.store.set(ref, normalized);
    this._interned.set(key, ref);
    return ref;
  }

  private _scheduleCollection(): void {
    if (this._disposed) {
      this.collectGarbage();
      return;
    }
    if (this._collection !== undefined) return;
    // Finish synchronous root publication and asynchronous watch handoffs first.
    this._collection = setTimeout(() => {
      this._collection = undefined;
      this.collectGarbage();
    }, 0);
  }

  public collectGarbage(): ReadonlySet<string> {
    const reachable = this.store.collectGarbage(this._disposed ? [] : [this.root.get()], true);
    for (const [key, ref] of this._interned) {
      if (!reachable.has(standardGraphRuntimeOptions.refKey(ref))) this._interned.delete(key);
    }
    for (const listener of this._collectionListeners) listener(reachable);
    if (this._disposed && this.store.diagnostics.retainedRoots === 0) {
      this._collectionListeners.clear();
      this.store.setReleaseListener(undefined);
    }
    return reachable;
  }

  public onDidCollect(listener: (reachable: ReadonlySet<string>) => void): { dispose(): void } {
    this._collectionListeners.add(listener);
    return { dispose: () => { this._collectionListeners.delete(listener); } };
  }

  public dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._subscription.dispose();
    clearTimeout(this._collection);
    this._collection = undefined;
    this.collectGarbage();
  }

  public get diagnostics(): { interned: number; objects: number; identities: number; retainedRoots: number } {
    return { interned: this._interned.size, ...this.store.diagnostics };
  }
}

export interface GraphSourceEntry {
  readonly id: string;
  readonly label: string;
  readonly source: GraphSource;
}

/** Current and explicitly leased roots retain their independent source stores. */
export class GraphComposition implements GraphSource {
  private readonly _local = new LocalGraphSource('composition');
  private readonly _sources = observableValue<readonly GraphSourceEntry[]>(this, []);
  private readonly _stores = new Set<GraphStore>([this._local.store]);
  private readonly _routes = new Map<string, GraphStore>();
  private readonly _leases = new Set<{ keys: Set<string>; stores: Set<GraphStore> }>();
  private _current: Promise<GraphLease> | undefined;
  private readonly _subscription;
  private _disposed = false;
  public readonly source: GraphSource = this;
  public readonly root = this._local.root;
  public readonly store: GraphStore = {
    lookup: (ref) => this._lookup(ref),
    peek: (ref) => this._lookup(ref, false),
    retainClosure: (ref) => this._retainClosure(ref),
  };

  public constructor(sources: readonly GraphSourceEntry[] = []) {
    this.setSources(sources);
    this._subscription = autorun(reader => {
      const entries = this._sources.read(reader);
      const values = entries.map(entry => {
        const root = entry.source.root.read(reader);
        this._route(root, entry.source.store);
        return { id: entry.id, label: entry.label, root };
      });
      const root = this._local.put('composition', { sources: values });
      this._route(root, this._local.store);
      const previous = this._current;
      this._current = this._retainClosure(root);
      void this._current.then(() => previous?.then(lease => lease.dispose()), () =>
        previous?.then(lease => lease.dispose())).catch(() => {});
      this.root.set(root, undefined);
    });
  }

  public setSources(sources: readonly GraphSourceEntry[]): void {
    if (this._disposed) throw new Error('Graph composition is disposed.');
    const ids = new Set<string>();
    const routes = new Map(this._routes);
    for (const entry of sources) {
      if (ids.has(entry.id)) throw new Error(`Duplicate graph source id: ${entry.id}`);
      ids.add(entry.id);
      const key = standardGraphRuntimeOptions.refKey(entry.source.root.get());
      const previous = routes.get(key);
      if (previous !== undefined && previous !== entry.source.store) {
        throw new Error('Graph reference collision between distinct stores.');
      }
      routes.set(key, entry.source.store);
    }
    for (const entry of sources) this._stores.add(entry.source.store);
    this._sources.set(sources.map(entry => ({ ...entry })), undefined);
  }

  public async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._subscription.dispose();
    const current = this._current;
    this._current = undefined;
    try {
      await (await current)?.dispose();
    } finally {
      this._sources.set([], undefined);
      this._local.dispose();
      this._pruneRoutes();
    }
  }

  private _route(ref: GraphRef, store: GraphStore): void {
    const key = standardGraphRuntimeOptions.refKey(ref);
    const prior = this._routes.get(key);
    if (prior !== undefined && prior !== store) throw new Error('Graph reference collision between distinct stores.');
    this._routes.set(key, store);
  }

  private async _lookup(ref: GraphRef, load = true): Promise<GraphLookup<JsonValue>> {
    const key = standardGraphRuntimeOptions.refKey(ref);
    const routed = this._routes.get(key);
    const lookupFrom = (store: GraphStore) => !load && store.peek ? store.peek(ref) : store.lookup(ref);
    if (routed !== undefined) return lookupFrom(routed);
    let result: GraphLookup<JsonValue> = { found: false, reason: 'missing' };
    let owner: GraphStore | undefined;
    for (const store of this._stores) {
      const lookup = await lookupFrom(store);
      if (lookup.found) {
        if (owner !== undefined) throw new Error('Graph reference collision between distinct stores.');
        owner = store;
        result = lookup;
      } else if (!result.found && lookup.reason !== 'missing') {
        result = lookup;
      }
    }
    if (owner !== undefined) this._route(ref, owner);
    return result;
  }

  private async _retainClosure(root: GraphRef): Promise<GraphLease> {
    const leases: GraphLease[] = [];
    const seen = new Set<string>();
    const tracking = { keys: seen, stores: new Set(this._stores) };
    const usedStores = new Set<GraphStore>();
    this._leases.add(tracking);
    // Pin the composition's own root synchronously, before the first await.
    const localLease = this._local.store.retainClosure(root);
    leases.push(localLease);
    const queue: { ref: GraphRef; coveredBy?: GraphStore }[] = [{ ref: root }];
    try {
      while (queue.length > 0) {
        const { ref, coveredBy } = queue.shift()!;
        const key = standardGraphRuntimeOptions.refKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        const value = await this._lookup(ref, false);
        const store = this._routes.get(key);
        if (store) usedStores.add(store);
        // A store's closure lease already protects same-store descendants.
        // Continue walking only to discover edges into other stores.
        if (store?.retainClosure !== undefined && store !== coveredBy
          && !(store === this._local.store && ref === root)) {
          leases.push(await store.retainClosure(ref));
        }
        if (value.found) {
          const children: GraphRef[] = [];
          collectRefs(value.value, children);
          for (const child of children) queue.push({ ref: child, coveredBy: store });
        }
      }
      tracking.stores = usedStores;
    } catch (error) {
      try {
        await disposeLeases(leases);
      } finally {
        this._leases.delete(tracking);
        this._pruneRoutes();
      }
      throw error;
    }
    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        try {
          await disposeLeases(leases);
        } finally {
          this._leases.delete(tracking);
          this._pruneRoutes();
        }
      },
    };
  }

  private _pruneRoutes(): void {
    const stores = new Set<GraphStore>(this._disposed ? [] : [this._local.store]);
    for (const entry of this._sources.get()) stores.add(entry.source.store);
    const keys = new Set<string>();
    if (!this._disposed) keys.add(standardGraphRuntimeOptions.refKey(this.root.get()));
    for (const lease of this._leases) {
      for (const key of lease.keys) keys.add(key);
      for (const store of lease.stores) stores.add(store);
    }
    for (const key of this._routes.keys()) if (!keys.has(key)) this._routes.delete(key);
    for (const store of this._stores) if (!stores.has(store)) this._stores.delete(store);
  }

  public get diagnostics(): { routes: number; stores: number; leases: number; objects: number } {
    return { routes: this._routes.size, stores: this._stores.size, leases: this._leases.size,
      objects: this._local.store.diagnostics.objects };
  }
}

async function disposeLeases(leases: readonly GraphLease[]): Promise<void> {
  const results = await Promise.allSettled(leases.map(lease => Promise.resolve().then(() => lease.dispose())));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to release graph leases.');
}

function collectRefs(value: JsonValue, refs: GraphRef[]): void {
  if (isGraphRef(value)) { refs.push(value); return; }
  if (Array.isArray(value)) for (const child of value) collectRefs(child, refs);
  else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) if (child !== undefined) collectRefs(child, refs);
  }
}

function normalizeJson(value: JsonValue): JsonValue {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Graph values require finite JSON numbers.');
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => [key, normalizeJson(value[key]!)]));
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw new Error('Graph values must be JSON.');
}
