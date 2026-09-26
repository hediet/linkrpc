import { type LinkRpcConnection, type InterfaceClient, type JsonValue } from '@hediet/linkrpc'
import {
  InMemoryImmutableGraphStore, standardGraphRuntimeOptions,
  type GraphLimits,
} from './immutableGraph'
import type { GraphRef } from './interfaces'
import { observableValue, type IObservable, type ISettableObservable } from '@vscode/observables'
import { graphInterface, retainedGraphInterface } from './protocol'

export type { GraphRef, JsonValue }
export type GraphValue = JsonValue
export type LoadState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready', readonly value: T }
  | { readonly kind: 'error', readonly message: string }

export interface GraphReader {
  readonly root: IObservable<LoadState<GraphRef>>
  acquire(ref: GraphRef): { readonly state: IObservable<LoadState<JsonValue>>, dispose(): void }
  retry(ref: GraphRef): void
}

export interface GraphObjectHandle {
  readonly state: IObservable<LoadState<JsonValue>>
  readonly error: IObservable<string | undefined>
  readonly refreshing: IObservable<boolean>
  retry(): void
  dispose(): void
}

export interface GraphClientOptions {
  readonly serviceId?: string
  readonly maxBatchObjects?: number
  readonly maxBatchBytes?: number
  /** Unreferenced entries are evicted first. Visible objects are never evicted. */
  readonly maxCachedObjects?: number
  readonly maxCachedBytes?: number
}

type RootCall = ReturnType<InterfaceClient<typeof graphInterface>['workspace']['watch']>
interface Entry {
  readonly ref: GraphRef
  readonly state: ISettableObservable<LoadState<JsonValue>>
  readonly error: ISettableObservable<string | undefined>
  readonly refreshing: ISettableObservable<boolean>
  users: number
  bytes: number
  lastUsed: number
  pin?: { readonly ready: Promise<void>, dispose(): void }
}

const keyOf = standardGraphRuntimeOptions.refKey
const errorState = (error: unknown): Extract<LoadState<never>, { kind: 'error' }> => ({
  kind: 'error', message: error instanceof Error ? error.message : String(error),
})

/** Acquired handles are the only source of object demand; references are never traversed here.
 * Connections are caller-owned. Dispose this client before closing its connection.
 */
export class GraphClient implements GraphReader {
  private _api: InterfaceClient<typeof graphInterface> | undefined
  private _pins: InterfaceClient<typeof retainedGraphInterface> | undefined
  private readonly _root = observableValue<LoadState<GraphRef>>(this, { kind: 'loading' })
  public readonly root: IObservable<LoadState<GraphRef>> = this._root
  private readonly _rootError = observableValue<string | undefined>(this, undefined)
  public readonly rootError: IObservable<string | undefined> = this._rootError
  private readonly _refreshing = observableValue(this, false)
  public readonly refreshing: IObservable<boolean> = this._refreshing
  private readonly _entries = new Map<string, Entry>()
  private readonly _pending = new Set<Entry>()
  private readonly _inFlight = new Map<Entry, number>()
  private readonly _limits: GraphLimits
  private readonly _maxCachedObjects: number
  private readonly _maxCachedBytes: number
  private _close: { dispose(): void } | undefined
  private readonly _serviceId: string | undefined
  private _epoch = 0
  private _watch: RootCall | undefined
  private _generation = 0
  private _clock = 0
  private _scheduled = false
  private _runningEpoch: number | undefined
  private _disposed = false

  public constructor(connection?: LinkRpcConnection, options: GraphClientOptions = {}) {
    this._serviceId = options.serviceId
    this._limits = {
      maxObjects: positive(options.maxBatchObjects ?? 32),
      maxBytes: positive(options.maxBatchBytes ?? 1024 * 1024),
    }
    this._maxCachedObjects = positive(options.maxCachedObjects ?? 256)
    this._maxCachedBytes = positive(options.maxCachedBytes ?? 16 * 1024 * 1024)
    if (connection) this.setConnection(connection)
  }

  /** Swap transports without throwing away immutable objects or their observable identities. */
  public setConnection(connection: LinkRpcConnection | undefined): void {
    if (this._disposed) throw new Error('Graph client is disposed')
    this._detach()
    if (!connection) return
    this._api = connection.get(graphInterface, { serviceId: this._serviceId })
    this._pins = connection.get(retainedGraphInterface, { serviceId: this._serviceId })
    this._close = connection.onDidClose(() => this._failConnection())
    for (const entry of this._entries.values()) {
      if (entry.users > 0) {
        if (entry.state.get().kind !== 'ready') entry.state.set({ kind: 'loading' }, undefined)
        entry.error.set(undefined, undefined)
        this._pin(entry)
      }
    }
    this.retryRoot()
  }

  /** Report transport setup failures without replacing already displayed immutable values. */
  public reportConnectionError(error: unknown): void {
    if (!this._disposed) this._failRoot(error)
  }

  public acquire(ref: GraphRef): GraphObjectHandle {
    if (this._disposed) throw new Error('Graph client is disposed')
    const key = keyOf(ref)
    let entry = this._entries.get(key)
    if (!entry) {
      entry = {
        ref: Object.freeze({ ...ref }),
        state: observableValue<LoadState<JsonValue>>(this, { kind: 'loading' }),
        error: observableValue<string | undefined>(this, undefined),
        refreshing: observableValue(this, false),
        users: 0, bytes: 0, lastUsed: ++this._clock,
      }
      this._entries.set(key, entry)
    }
    const item = entry
    item.users++
    item.lastUsed = ++this._clock
    if (!item.pin && this._pins) this._pin(item)
    let disposed = false
    return {
      state: item.state,
      error: item.error,
      refreshing: item.refreshing,
      retry: () => {
        if (!disposed) this.retry(item.ref)
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        item.users--
        item.lastUsed = ++this._clock
        if (item.users === 0) {
          item.pin?.dispose()
          item.pin = undefined
          this._pending.delete(item)
        }
        this._evict()
      },
    }
  }

  public retry(ref: GraphRef): void {
    const entry = this._entries.get(keyOf(ref))
    if (!entry || this._disposed || entry.users === 0 || entry.error.get() === undefined) return
    if (entry.state.get().kind !== 'ready') entry.state.set({ kind: 'loading' }, undefined)
    entry.error.set(undefined, undefined)
    entry.pin?.dispose()
    entry.pin = undefined
    if (this._pins) this._pin(entry)
  }

  public retryRoot(): void {
    if (this._disposed || !this._api) return
    const generation = ++this._generation
    cancel(this._watch)
    if (this._root.get().kind !== 'ready') this._root.set({ kind: 'loading' }, undefined)
    this._rootError.set(undefined, undefined)
    this._refreshing.set(true, undefined)
    const watch = this._api.workspace.watch({}, {
      onMessage: offer => {
        // Do not release the accepted workspace until every visible object has
        // its own retained-root lease. This also covers pending batch requests.
        const pins = [...this._entries.values()].filter(entry => entry.users > 0)
          .map(entry => entry.pin?.ready)
        void Promise.all(pins).then(() => {
          if (this._disposed || generation !== this._generation) return
          const current = this._root.get()
          if (current.kind !== 'ready' || keyOf(current.value) !== keyOf(offer.ref)) {
            this._root.set({ kind: 'ready', value: Object.freeze({ ...offer.ref }) }, undefined)
          }
          this._refreshing.set(false, undefined)
          this._rootError.set(undefined, undefined)
          return watch.send({ accept: offer.version })
        }).catch(error => {
          if (!this._disposed && generation === this._generation) {
            this._failRoot(error)
          }
        })
      },
    })
    this._watch = watch
    void watch.then(() => {
      if (!this._disposed && generation === this._generation) {
        this._failRoot('Graph root watch ended')
      }
    }, error => {
      if (!this._disposed && generation === this._generation) {
        this._failRoot(error)
      }
    })
  }

  private _pin(entry: Entry): void {
    entry.refreshing.set(true, undefined)
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const ready = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    let disposed = false
    const call = this._pins!.root.watch({ ref: entry.ref }, {
      onMessage: offer => {
        if (disposed || this._disposed) return
        if (keyOf(offer.ref) !== keyOf(entry.ref)) {
          reject(new Error('Retained graph watch returned another reference'))
          return
        }
        queueMicrotask(() => {
          if (disposed || this._disposed) return
          void call.send({ accept: offer.version }).then(resolve, reject)
        })
      },
    })
    const pin = {
      ready,
      dispose: () => {
        if (disposed) return
        disposed = true
        resolve()
        cancel(call)
      },
    }
    entry.pin = pin
    const fail = (error: unknown) => {
      if (!disposed) {
        reject(error)
        if (!this._disposed && entry.pin === pin) {
          this._failEntry(entry, error)
        }
      }
    }
    void call.then(() => fail(new Error('Retained graph watch ended')), fail)
    void ready.then(() => {
      if (disposed || this._disposed || entry.users === 0 || entry.pin !== pin) return
      entry.error.set(undefined, undefined)
      entry.refreshing.set(false, undefined)
      if (entry.state.get().kind === 'loading' && !this._inFlight.has(entry)) {
        this._pending.add(entry)
        this._schedule()
      }
    }, error => {
      if (!disposed && !this._disposed && entry.pin === pin) {
        this._failEntry(entry, error)
      }
    })
  }

  private _schedule(): void {
    if (this._scheduled || this._runningEpoch === this._epoch || this._disposed) return
    this._scheduled = true
    queueMicrotask(() => {
      this._scheduled = false
      void this._flush()
    })
  }

  private async _flush(): Promise<void> {
    if (this._runningEpoch === this._epoch || this._disposed) return
    const flushEpoch = this._epoch
    this._runningEpoch = flushEpoch
    try {
      while (this._pending.size && !this._disposed && flushEpoch === this._epoch) {
        const entries = [...this._pending].filter(entry => entry.users > 0)
          .slice(0, this._limits.maxObjects)
        for (const entry of entries) this._pending.delete(entry)
        if (!entries.length) break
        const requested = new Map(entries.map(entry => [keyOf(entry.ref), entry]))
        const epoch = this._epoch
        for (const entry of entries) this._inFlight.set(entry, epoch)
        try {
          const response = await this._api!.objects.batchObjGet({
            needs: entries.map(entry => ({ ref: entry.ref, paths: ['/'] })),
            have: [],
            limits: this._limits,
          })
          if (this._disposed || epoch !== this._epoch) continue
          let progress = 0
          for (const object of response.objects) {
            const entry = requested.get(keyOf(object.ref))
            if (!entry) continue
            // Reuse the published immutable cache's cloning/freezing contract.
            // One cache per entry lets eviction release identity metadata too.
            const cache = new InMemoryImmutableGraphStore<GraphRef, JsonValue>(standardGraphRuntimeOptions)
            cache.set(object.ref, object.value)
            const result = cache.lookup(object.ref)
            if (!result.found) throw new Error('Immutable cache rejected graph object')
            entry.bytes = new TextEncoder().encode(JSON.stringify(object)).byteLength
            entry.state.set({ kind: 'ready', value: result.value }, undefined)
            entry.error.set(undefined, undefined)
            requested.delete(keyOf(object.ref))
            progress++
          }
          for (const missing of response.missing) {
            const entry = requested.get(keyOf(missing.ref))
            if (!entry) continue
            this._failEntry(entry, `Graph object ${missing.reason}: ${missing.detail ?? missing.ref.id}`)
            requested.delete(keyOf(missing.ref))
            progress++
          }
          for (const entry of requested.values()) {
            if (!response.complete && progress > 0) {
              if (entry.users > 0) this._pending.add(entry)
            } else {
              this._failEntry(entry, response.complete
                ? 'Graph response omitted a requested object' : 'Graph batch made no progress')
            }
          }
        } catch (error) {
          if (!this._disposed && epoch === this._epoch) {
            for (const entry of requested.values()) {
              this._failEntry(entry, error)
            }
          }
        } finally {
          for (const entry of entries) {
            if (this._inFlight.get(entry) === epoch) this._inFlight.delete(entry)
          }
        }
        this._evict()
      }
    } finally {
      if (this._runningEpoch === flushEpoch) this._runningEpoch = undefined
      if (this._pending.size && !this._disposed) this._schedule()
    }
  }

  private _evict(): void {
    let bytes = [...this._entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    const idle = [...this._entries.values()].filter(entry => entry.users === 0 && !this._inFlight.has(entry))
      .sort((a, b) => a.lastUsed - b.lastUsed)
    for (const entry of idle) {
      if (this._entries.size <= this._maxCachedObjects && bytes <= this._maxCachedBytes) break
      this._entries.delete(keyOf(entry.ref))
      bytes -= entry.bytes
    }
  }

  private _failConnection(): void {
    if (this._disposed) return
    const error = new Error('Graph connection closed')
    this._failRoot(error)
    for (const entry of this._entries.values()) {
      if (entry.users > 0) this._failEntry(entry, error)
    }
    this._detach()
  }

  private _failRoot(error: unknown): void {
    const state = errorState(error)
    this._rootError.set(state.message, undefined)
    this._refreshing.set(false, undefined)
    if (this._root.get().kind !== 'ready') this._root.set(state, undefined)
  }

  private _failEntry(entry: Entry, error: unknown): void {
    const state = errorState(error)
    entry.error.set(state.message, undefined)
    entry.refreshing.set(false, undefined)
    if (entry.state.get().kind !== 'ready') entry.state.set(state, undefined)
  }

  private _detach(): void {
    this._epoch++
    this._generation++
    this._close?.dispose()
    this._close = undefined
    cancel(this._watch)
    this._watch = undefined
    for (const entry of this._entries.values()) {
      entry.pin?.dispose()
      entry.pin = undefined
      entry.refreshing.set(false, undefined)
    }
    this._pending.clear()
    this._inFlight.clear()
    this._refreshing.set(false, undefined)
    this._api = undefined
    this._pins = undefined
  }

  public dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._detach()
    this._entries.clear()
    this._pending.clear()
  }
}

function cancel(call: RootCall | undefined): void {
  if (!call) return
  // Cancellation must reach the peer before local stream bookkeeping is dropped.
  void call.cancel().catch(() => {}).finally(() => call.dispose?.())
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Graph client limits must be positive integers')
  return value
}
