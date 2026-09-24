import { randomUUID } from 'node:crypto';
import { autorun, observableValue, type IObservable } from '@vscode/observables';
import {
  defineInterface,
  type JsonValue, type LinkRpcConnection, type StreamApi,
} from '@hediet/linkrpc';
import {
  ImmutableGraphRuntime, InMemoryImmutableGraphStore, RootWatchCoordinator,
  graphRefSchema, GraphObjects, GraphRoot, validateGraphInterfaceSchema,
  isGraphRef, standardGraphRuntimeOptions,
  type GraphRef, type ImmutableGraphSource, type GraphLease, type GraphLookup,
} from './index.js';
import { z } from 'zod';

export type { JsonValue } from '@hediet/linkrpc';
export type { GraphRef, ImmutableGraphSource } from './index.js';
export { ImmutableGraphRuntime, standardGraphRuntimeOptions, isGraphRef } from './index.js';

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

  public constructor(namespace = 'source') {
    this.namespace = `${encodeURIComponent(namespace)}/${randomUUID()}`;
    this.root = observableValue<GraphRef>(this, this.put('empty', {}));
  }

  public put(kind: string, value: JsonValue): GraphRef {
    const normalized = normalizeJson(value);
    const key = JSON.stringify([kind, normalized]);
    const existing = this._interned.get(key);
    if (existing !== undefined) return existing;
    const ref = Object.freeze({ kind, id: `${this.namespace}/${this._interned.size}` });
    this.store.set(ref, normalized);
    this._interned.set(key, ref);
    return ref;
  }
}

export interface GraphSourceEntry {
  readonly id: string;
  readonly label: string;
  readonly source: GraphSource;
}

/** Historical routing and root leases are kept for this composition's lifetime. */
export class GraphComposition implements GraphSource {
  private readonly _local = new LocalGraphSource('composition');
  private readonly _sources = observableValue<readonly GraphSourceEntry[]>(this, []);
  private readonly _stores = new Set<GraphStore>([this._local.store]);
  private readonly _routes = new Map<string, GraphStore>();
  private readonly _historicalLeases = new Map<string, Promise<GraphLease>>();
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
        const key = standardGraphRuntimeOptions.refKey(root);
        if (!this._historicalLeases.has(key)) {
          const lease = Promise.resolve(entry.source.store.retainClosure?.(root) ?? noLease());
          // A rejected retention is surfaced when this root is looked up, not unhandled.
          void lease.catch(() => {});
          this._historicalLeases.set(key, lease);
        }
        return { id: entry.id, label: entry.label, root };
      });
      const root = this._local.put('composition', { sources: values });
      this._route(root, this._local.store);
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
    await Promise.all([...this._historicalLeases.values()].map(async lease => (await lease).dispose()));
  }

  private _route(ref: GraphRef, store: GraphStore): void {
    const key = standardGraphRuntimeOptions.refKey(ref);
    const prior = this._routes.get(key);
    if (prior !== undefined && prior !== store) throw new Error('Graph reference collision between distinct stores.');
    this._routes.set(key, store);
  }

  private async _lookup(ref: GraphRef, load = true): Promise<GraphLookup<JsonValue>> {
    const key = standardGraphRuntimeOptions.refKey(ref);
    await this._historicalLeases.get(key);
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
    const queue: { ref: GraphRef; coveredBy?: GraphStore }[] = [{ ref: root }];
    try {
      while (queue.length > 0) {
        const { ref, coveredBy } = queue.shift()!;
        const key = standardGraphRuntimeOptions.refKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        const value = await this._lookup(ref, false);
        const store = this._routes.get(key);
        // A store's closure lease already protects same-store descendants.
        // Continue walking only to discover edges into other stores.
        if (store?.retainClosure !== undefined && store !== coveredBy) {
          leases.push(await store.retainClosure(ref));
        }
        if (value.found) {
          const children: GraphRef[] = [];
          collectRefs(value.value, children);
          for (const child of children) queue.push({ ref: child, coveredBy: store });
        }
      }
    } catch (error) {
      await disposeLeases(leases);
      throw error;
    }
    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await disposeLeases(leases);
      },
    };
  }
}

const jsonSchema: z.ZodType<JsonValue> = z.json();
const objects = GraphObjects({ ref: graphRefSchema, value: jsonSchema });
const workspace = GraphRoot({ params: z.object({}), ref: graphRefSchema });
export const graphInterface = defineInterface(
  { id: 'linkrpc.graph.v1' },
  { objects, workspace },
);
validateGraphInterfaceSchema(graphInterface.toSchema());

export function createGraphRuntime(source: GraphSource): ImmutableGraphRuntime<GraphRef, JsonValue> {
  return new ImmutableGraphRuntime(source.store, standardGraphRuntimeOptions);
}

export function registerGraphSource(
  connection: LinkRpcConnection,
  source: GraphSource,
  options: { serviceId?: string } = {},
): { dispose(): void } {
  const runtime = createGraphRuntime(source);
  const abort = new AbortController();
  const roots = new RootWatchCoordinator<Record<string, never>, GraphRef>({
    paramsKey: () => '',
    sameRef: (a, b) => standardGraphRuntimeOptions.refKey(a) === standardGraphRuntimeOptions.refKey(b),
    retention: { retainClosure: ref => source.store.retainClosure?.(ref) ?? noLease() },
  });
  const registration = connection.register(graphInterface, {
    objects: { batchObjGet: params => runtime.batchObjGet(params) },
    workspace: {
      watch: (params, _context, stream) => {
        const scoped: StreamApi<{ accept: number }, { version: number; ref: GraphRef }> = {
          ...stream, signal: AbortSignal.any([stream.signal, abort.signal]),
        };
        return roots.watch(params, scoped);
      },
    },
  }, options);
  const subscription = autorun(reader => roots.publish({}, source.root.read(reader)));
  return {
    dispose: () => {
      subscription.dispose();
      abort.abort();
      registration.dispose();
    },
  };
}

function noLease(): GraphLease { return { dispose() {} }; }

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
