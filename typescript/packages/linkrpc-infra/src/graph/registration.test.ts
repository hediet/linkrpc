import assert from 'node:assert/strict'
import { test } from 'vitest'
import { LinkRpcConnection, TransportPair } from '@hediet/linkrpc'
import { GraphComposition, LazyGraphSource, LocalGraphSource, graphInterface } from './source'
import { GraphClient, type LoadState } from './client'
import { graphInterface as graphProtocol } from './protocol'
import { registerGraphSource } from './registration'
import type { IObservable } from '@vscode/observables'

async function value<T>(state: IObservable<LoadState<T>>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const result = state.get()
    if (result.kind === 'ready') return result.value
    if (result.kind === 'error') throw new Error(result.message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Graph load timed out')
}

test('browser contract matches published source graph contract', () => {
  assert.deepEqual(graphProtocol.toSchema(), graphInterface.toSchema())
})

test('catalog and selected viewport only resolve demanded objects from 1000 lazy items', async () => {
  const source = new LazyGraphSource('thousand')
  const loaded: number[] = []
  const refs = Array.from({ length: 1000 }, (_, index) => source.defer('turn', async () => {
    loaded.push(index)
    return { text: `Turn ${index}` }
  }))
  source.root.set(source.put('catalog', { items: refs }), undefined)
  const composition = new GraphComposition([{ id: 'source', label: 'Source', source }])
  const pair = new TransportPair()
  const server = LinkRpcConnection.fromTransport(pair.a)
  const registration = registerGraphSource(server, async () => composition)
  const client = new GraphClient(LinkRpcConnection.fromTransport(pair.b))
  try {
    const root = await value(client.root)
    const compositionHandle = client.acquire(root)
    await value(compositionHandle.state)
    const catalog = client.acquire(source.root.get())
    await value(catalog.state)
    assert.deepEqual(loaded, [], 'root and catalog must not hydrate any deferred detail')
    const a = client.acquire(refs[17]!)
    const b = client.acquire(refs[17]!)
    const c = client.acquire(refs[900]!)
    await Promise.all([value(a.state), value(b.state), value(c.state)])
    assert.deepEqual(loaded.sort((a, b) => a - b), [17, 900])
    assert.equal(a.state, b.state)
    a.dispose()
    b.dispose()
    const cached = client.acquire(refs[17]!)
    await value(cached.state)
    assert.equal(loaded.length, 2)
    cached.dispose()
    c.dispose()
    catalog.dispose()
    compositionHandle.dispose()
  } finally {
    client.dispose()
    registration.dispose()
    server.close()
    await composition.dispose()
  }
})

test('workspace ACK releases obsolete root while visible old refs retain their closure', async () => {
  const source = new LocalGraphSource('retention')
  const child = source.put('message', { text: 'old message' })
  const old = source.put('turn', { message: child })
  const oldRoot = source.put('catalog', { items: [old] })
  source.root.set(oldRoot, undefined)
  const pair = new TransportPair()
  const server = LinkRpcConnection.fromTransport(pair.a)
  const registration = registerGraphSource(server, async () => source)
  const client = new GraphClient(LinkRpcConnection.fromTransport(pair.b))
  try {
    await value(client.root)
    const handle = client.acquire(old)
    await value(handle.state)
    const replacement = source.put('catalog', { items: [] })
    source.root.set(replacement, undefined)
    for (let i = 0; i < 100 && (client.root.get().kind !== 'ready'
      || (client.root.get() as { value: { id: string } }).value.id !== replacement.id
      || source.store.isRetained(oldRoot)); i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.deepEqual(await value(client.root), replacement)
    assert.equal(source.store.isRetained(oldRoot), false)
    assert.equal(source.store.isRetained(child), true)
    assert.throws(() => source.store.markUnavailable(child, 'expired'), /Retained/)
    const nested = client.acquire(child)
    assert.deepEqual(await value(nested.state), { text: 'old message' })
    nested.dispose()
    handle.dispose()
    client.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(source.store.isRetained(child), false)
    assert.equal(source.store.isRetained(replacement), false)
    source.store.markUnavailable(child, 'expired')
  } finally {
    client.dispose()
    registration.dispose()
    server.close()
  }
})

test('pending acquired-reference lease blocks workspace ACK until the old object is safe', async () => {
  const source = new LocalGraphSource('pending-lease')
  const child = source.put('child', { value: 1 })
  const old = source.put('old', { child })
  const initial = source.put('catalog', { items: [old] })
  source.root.set(initial, undefined)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const pair = new TransportPair()
  const server = LinkRpcConnection.fromTransport(pair.a)
  const connection = LinkRpcConnection.fromTransport(pair.b)
  const registration = registerGraphSource(server, {
    root: source.root,
    store: {
      lookup: ref => source.store.lookup(ref),
      retainClosure: async ref => {
        if (ref.id === old.id) await gate
        return source.store.retainClosure(ref)
      },
    },
  })
  const client = new GraphClient(connection)
  try {
    await value(client.root)
    const handle = client.acquire(old)
    const next = source.put('catalog', { items: [] })
    source.root.set(next, undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(await value(client.root), initial)
    assert.equal(source.store.isRetained(initial), true)
    release()
    await value(handle.state)
    for (let i = 0; i < 100 && source.store.isRetained(initial); i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.deepEqual(await value(client.root), next)
    assert.equal(source.store.isRetained(initial), false)
    assert.equal(source.store.isRetained(old), true)
    handle.dispose()
  } finally {
    release()
    client.dispose()
    registration.dispose()
    connection.close()
    server.close()
  }
})

test('registration disposal during lazy initialization cannot leave a root watch behind', async () => {
  const source = new LocalGraphSource('late-start')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const pair = new TransportPair()
  const server = LinkRpcConnection.fromTransport(pair.a)
  const connection = LinkRpcConnection.fromTransport(pair.b)
  const registration = registerGraphSource(server, async () => { await gate; return source })
  const client = new GraphClient(connection)
  registration.dispose()
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(source.store.isRetained(source.root.get()), false)
  assert.equal(server.listRegisteredInterfaces().length, 0)
  client.dispose()
  connection.close()
  server.close()
})
