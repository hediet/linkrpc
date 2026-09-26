import assert from 'node:assert/strict'
import { test } from 'vitest'
import { LinkRpcConnection, TransportPair, type JsonValue, type StreamApi } from '@hediet/linkrpc'
import { ImmutableGraphRuntime, standardGraphRuntimeOptions, type GraphBatchRequest, type GraphBatchResult } from './immutableGraph'
import type { GraphRef } from './interfaces'
import { GraphClient, type GraphClientOptions, type LoadState } from './client'
import { graphInterface as graphProtocol, retainedGraphInterface as retainedGraphProtocol } from './protocol'
import { registerGraphSource } from './registration'
import { LocalGraphSource } from './source'
import type { IObservable } from '@vscode/observables'

const ref = (id: string): GraphRef => ({ kind: 'item', id })
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
async function state<T>(observable: IObservable<LoadState<T>>): Promise<LoadState<T>> {
  for (let i = 0; i < 100; i++) {
    const value = observable.get()
    if (value.kind !== 'loading') return value
    await tick()
  }
  throw new Error('Load timed out')
}

function setup(
  batch: (request: GraphBatchRequest<GraphRef>) => Promise<GraphBatchResult<GraphRef, JsonValue>>,
  options: GraphClientOptions = {},
  behavior: { root?: GraphRef; pinError?: (ref: GraphRef) => Error | undefined } = {},
) {
  const pair = new TransportPair()
  const server = LinkRpcConnection.fromTransport(pair.a)
  let watches = 0
  const watch = async (ref: GraphRef, stream: StreamApi<{ accept: number }, { version: number, ref: GraphRef }>) => {
    watches++
    try {
      const ended = new Promise<void>(resolve => {
        if (stream.signal.aborted) resolve()
        else stream.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      await stream.send({ version: 1, ref })
      await ended
      return {}
    } finally { watches-- }
  }
  server.register(graphProtocol, {
    workspace: { watch: (_params, _ctx, stream) => watch(behavior.root ?? ref('root'), stream) },
    objects: { batchObjGet: batch },
  })
  server.register(retainedGraphProtocol, {
    objects: { batchObjGet: batch },
    root: { watch: (params, _ctx, stream) => {
      const error = behavior.pinError?.(params.ref)
      if (error) throw error
      return watch(params.ref, stream)
    } },
  })
  const connection = LinkRpcConnection.fromTransport(pair.b)
  const client = new GraphClient(connection, options)
  return { client, connection, server, watches: () => watches,
    dispose: () => { client.dispose(); connection.close(); server.close() } }
}

test('exact object batches are bounded, deduplicated, continue partial responses and never request closure', async () => {
  const requests: GraphBatchRequest<GraphRef>[] = []
  const runtime = new ImmutableGraphRuntime({
    lookup: async (item: GraphRef) => ({ found: true as const, value: { text: item.id + 'x'.repeat(100) } }),
  }, standardGraphRuntimeOptions)
  const env = setup(async request => {
    requests.push(request)
    return runtime.batchObjGet(request)
  }, { maxBatchObjects: 3, maxBatchBytes: 240 })
  try {
    const handles = Array.from({ length: 7 }, (_, index) => env.client.acquire(ref(String(index))))
    const duplicate = env.client.acquire(ref('0'))
    await Promise.all(handles.map(handle => state(handle.state)))
    assert.ok(handles.every(handle => handle.state.get().kind === 'ready'))
    assert.equal(duplicate.state, handles[0]!.state)
    assert.ok(requests.length >= 7, 'byte limit must produce partial continuations')
    const received = new Set<string>()
    for (const request of requests) {
      assert.ok(request.needs.length <= 3)
      assert.deepEqual(request.have, [])
      for (const need of request.needs) {
        assert.deepEqual(need.paths, ['/'])
        received.add(need.ref.id)
      }
    }
    assert.equal(received.size, 7)
    for (const handle of handles) handle.dispose()
    duplicate.dispose()
    env.client.dispose()
    for (let i = 0; i < 100 && env.watches(); i++) await tick()
    assert.equal(env.watches(), 0)
  } finally { env.dispose() }
})

test('missing, throwing, omitted, no-progress and oversized batches expose retryable errors', async () => {
  for (const scenario of ['missing', 'throwing', 'omitted', 'no-progress', 'oversized']) {
    let fail = true
    let calls = 0
    const env = setup(async request => {
      calls++
      if (fail) {
        if (scenario === 'throwing') throw new Error('Unavailable')
        return {
          objects: [],
          missing: scenario === 'missing' || scenario === 'oversized'
            ? [{ ref: request.needs[0]!.ref, reason: scenario === 'missing' ? 'expired' : 'oversized' }] : [],
          complete: scenario !== 'no-progress',
        }
      }
      return { objects: request.needs.map(need => ({ ref: need.ref, value: { ok: true } })), missing: [], complete: true }
    })
    try {
      const handle = env.client.acquire(ref('test'))
      assert.equal((await state(handle.state)).kind, 'error', scenario)
      await tick()
      assert.equal(calls, 1, 'errors must not busy-loop')
      fail = false
      handle.retry()
      assert.deepEqual(await state(handle.state), { kind: 'ready', value: { ok: true } })
      handle.dispose()
    } finally { env.dispose() }
  }
})

test('idle cache is bounded, immutable, and reuses data without another object request', async () => {
  const fetched: string[] = []
  const env = setup(async request => {
    fetched.push(...request.needs.map(need => need.ref.id))
    return { objects: request.needs.map(need => ({ ref: need.ref, value: { nested: { text: need.ref.id } } })),
      missing: [], complete: true }
  }, { maxCachedObjects: 2 })
  try {
    const a = env.client.acquire(ref('a'))
    const loaded = await state(a.state)
    assert.equal(loaded.kind, 'ready')
    if (loaded.kind === 'ready') {
      assert.ok(Object.isFrozen(loaded.value))
      assert.ok(Object.isFrozen((loaded.value as { nested: JsonValue }).nested))
    }
    a.dispose()
    const again = env.client.acquire(ref('a'))
    await state(again.state)
    assert.deepEqual(fetched, ['a'])
    again.dispose()
    for (const id of ['b', 'c']) {
      const handle = env.client.acquire(ref(id))
      await state(handle.state)
      handle.dispose()
    }
    const evicted = env.client.acquire(ref('a'))
    await state(evicted.state)
    assert.deepEqual(fetched, ['a', 'b', 'c', 'a'])
    evicted.dispose()
  } finally { env.dispose() }
})

test('disposing before pin confirmation cancels object demand', async () => {
  let requests = 0
  const env = setup(async () => {
    requests++
    return { objects: [], missing: [], complete: true }
  })
  const handle = env.client.acquire(ref('never-visible'))
  handle.dispose()
  await tick()
  assert.equal(requests, 0)
  env.dispose()
})

test('remount during an in-flight batch shares the request and releasing one reader keeps the other live', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const env = setup(async request => {
    calls++
    await gate
    return { objects: request.needs.map(need => ({ ref: need.ref, value: 'shared' })),
      missing: [], complete: true }
  })
  try {
    const first = env.client.acquire(ref('one'))
    for (let i = 0; i < 100 && calls === 0; i++) await tick()
    assert.equal(calls, 1)
    first.dispose()
    const second = env.client.acquire(ref('one'))
    const third = env.client.acquire(ref('one'))
    await tick()
    second.dispose()
    release()
    assert.deepEqual(await state(third.state), { kind: 'ready', value: 'shared' })
    await tick()
    assert.equal(calls, 1)
    third.dispose()
  } finally { release(); env.dispose() }
})

test('ready root and inner observable values survive root retry and connection replacement', async () => {
  let calls = 0
  const fetch = async (request: GraphBatchRequest<GraphRef>) => {
    calls++
    return { objects: request.needs.map(need => ({ ref: need.ref, value: { stable: true } })),
      missing: [], complete: true }
  }
  const first = setup(fetch)
  const second = setup(fetch)
  try {
    await state(first.client.root)
    const handle = first.client.acquire(ref('stable'))
    await state(handle.state)
    const root = first.client.root.get()
    const ready = handle.state.get()
    first.client.retryRoot()
    assert.equal(first.client.root.get(), root)
    await tick()
    first.connection.close()
    assert.equal(first.client.root.get(), root)
    assert.equal(handle.state.get(), ready)
    assert.ok(first.client.rootError.get())
    assert.ok(handle.error.get())
    first.client.setConnection(second.connection)
    assert.equal(handle.state.get(), ready)
    assert.equal(first.client.root.get(), root)
    await tick()
    assert.equal(first.client.root.get(), root)
    assert.equal(handle.state.get(), ready)
    assert.equal(handle.error.get(), undefined)
    assert.equal(first.client.rootError.get(), undefined)
    assert.equal(calls, 1, 'immutable ready objects must not refetch on reconnect')
    handle.dispose()
  } finally { first.dispose(); second.dispose() }
})

test('a stalled old transport cannot block new demand or overwrite its result after replacement', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const first = setup(async request => {
    calls++
    await gate
    return { objects: request.needs.map(need => ({ ref: need.ref, value: 'late-old' })),
      missing: [], complete: true }
  })
  const second = setup(async request => ({
    objects: request.needs.map(need => ({ ref: need.ref, value: 'new' })), missing: [], complete: true,
  }))
  try {
    const handle = first.client.acquire(ref('item'))
    for (let i = 0; i < 100 && !calls; i++) await tick()
    first.client.setConnection(second.connection)
    assert.deepEqual(await state(handle.state), { kind: 'ready', value: 'new' })
    release()
    await tick()
    assert.deepEqual(handle.state.get(), { kind: 'ready', value: 'new' })
    handle.dispose()
  } finally { release(); first.dispose(); second.dispose() }
})

test('byte-budget cache eviction never evicts active readers and evicts their entries after release', async () => {
  const fetched: string[] = []
  const env = setup(async request => {
    fetched.push(...request.needs.map(need => need.ref.id))
    return { objects: request.needs.map(need => ({ ref: need.ref, value: 'x'.repeat(200) })),
      missing: [], complete: true }
  }, { maxCachedObjects: 1, maxCachedBytes: 100 })
  try {
    const a = env.client.acquire(ref('a'))
    const b = env.client.acquire(ref('b'))
    await Promise.all([state(a.state), state(b.state)])
    const duplicate = env.client.acquire(ref('a'))
    assert.equal(duplicate.state, a.state)
    assert.equal(fetched.length, 2)
    duplicate.dispose()
    a.dispose()
    const again = env.client.acquire(ref('a'))
    await state(again.state)
    assert.deepEqual(fetched, ['a', 'b', 'a'])
    again.dispose()
    b.dispose()
  } finally { env.dispose() }
})

test('failed old-reference retention on reconnect cannot wedge new workspace offers', async () => {
  const batch = async (request: GraphBatchRequest<GraphRef>) => ({
    objects: request.needs.map(need => ({ ref: need.ref, value: { title: need.ref.id } })),
    missing: [], complete: true,
  })
  const first = setup(batch)
  const replacement = setup(batch, {}, {
    root: ref('new-root'),
    pinError: item => item.id === 'expired-old' ? new Error('Old reference expired') : undefined,
  })
  try {
    await state(first.client.root)
    const old = first.client.acquire(ref('expired-old'))
    await state(old.state)
    const cached = old.state.get()
    first.connection.close()
    first.client.setConnection(replacement.connection)
    for (let i = 0; i < 100; i++) {
      const root = first.client.root.get()
      if (root.kind === 'ready' && root.value.id === 'new-root') break
      await tick()
    }
    assert.deepEqual(first.client.root.get(), { kind: 'ready', value: ref('new-root') })
    assert.equal(first.client.rootError.get(), undefined)
    assert.equal(old.state.get(), cached)
    assert.match(old.error.get() ?? '', /Old reference expired/)
    first.client.retryRoot()
    await tick()
    assert.equal(first.client.rootError.get(), undefined)
    assert.equal(first.client.refreshing.get(), false)
    const current = first.client.acquire(ref('new-root'))
    assert.deepEqual(await state(current.state), { kind: 'ready', value: { title: 'new-root' } })
    current.dispose()
    old.dispose()
  } finally { first.dispose(); replacement.dispose() }
})

test('the same reader switches service routes, preserves omitted targets and resets with empty options', async () => {
  const pair = new TransportPair()
  const server = LinkRpcConnection.fromTransport(pair.a)
  const connection = LinkRpcConnection.fromTransport(pair.b)
  const sources = ['', 'first', 'second'].map(name => {
    const source = new LocalGraphSource(`route-${name}`)
    source.root.set(source.put('catalog', { name }), undefined)
    return source
  })
  const registrations = sources.map((source, index) =>
    registerGraphSource(server, source, { serviceId: ['', 'first', 'second'][index] }))
  const client = new GraphClient(connection, { serviceId: 'first' })
  const rootObservable = client.root
  const waitRoot = async (source: LocalGraphSource) => {
    for (let i = 0; i < 100; i++) {
      const root = client.root.get()
      if (root.kind === 'ready' && root.value.id === source.root.get().id && !client.refreshing.get()) return
      await tick()
    }
    throw new Error('Service route did not update')
  }
  try {
    await waitRoot(sources[1]!)
    const first = client.acquire(sources[1]!.root.get())
    assert.deepEqual(await state(first.state), { kind: 'ready', value: { name: 'first' } })
    const cached = first.state.get()
    client.setConnection(connection, { serviceId: 'second' })
    await waitRoot(sources[2]!)
    assert.equal(client.root, rootObservable)
    assert.equal(first.state.get(), cached)
    const second = client.acquire(sources[2]!.root.get())
    assert.deepEqual(await state(second.state), { kind: 'ready', value: { name: 'second' } })
    client.setConnection(connection)
    await waitRoot(sources[2]!)
    client.setConnection(undefined)
    client.setConnection(connection)
    await waitRoot(sources[2]!)
    client.setConnection(connection, {})
    await waitRoot(sources[0]!)
    const unscoped = client.acquire(sources[0]!.root.get())
    assert.deepEqual(await state(unscoped.state), { kind: 'ready', value: { name: '' } })
    first.dispose()
    second.dispose()
    unscoped.dispose()
  } finally {
    client.dispose()
    for (const registration of registrations) registration.dispose()
    for (const source of sources) source.dispose()
    connection.close()
    server.close()
  }
})
