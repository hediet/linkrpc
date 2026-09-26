import assert from 'node:assert/strict';
import { onTestFinished, test } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { autorun } from '@vscode/observables';
import { LinkRpcConnection, TransportPair, type JsonRpcMessage } from '@hediet/linkrpc';
import { GraphClient } from './client';
import {
  GraphComposition, LocalGraphSource, createGraphRuntime, graphInterface, registerGraphSource,
  type GraphRef, type GraphSource, type JsonValue,
} from './source.js';

const limits = { maxObjects: 100, maxBytes: 100_000 };
const request = (ref: GraphRef, paths = ['/**']) => ({ needs: [{ ref, paths }], have: [], limits });

test('source content interning, unique namespace incarnations, and immutable snapshots', () => {
  const a = new LocalGraphSource('same/namespace');
  const b = new LocalGraphSource('same/namespace');
  assert.notEqual(a.namespace, b.namespace);
  assert.notEqual(a.root.get().id, b.root.get().id);
  assert.deepEqual(a.store.lookup(a.root.get()), { found: true, value: {} });
  const input = { nested: { name: 'one' }, values: [1, 2] };
  const original = a.put('record', input);
  assert.equal(a.put('record', { values: [1, 2], nested: { name: 'one' } }), original);
  assert.notEqual(a.put('different-kind', input).id, original.id);
  assert.notEqual(b.put('record', input).id, original.id);
  input.nested.name = 'changed';
  input.values.push(3);
  const stored = a.store.lookup(original);
  assert.ok(stored.found);
  assert.deepEqual(stored.value, { nested: { name: 'one' }, values: [1, 2] });
  assert.ok(Object.isFrozen(stored.value));
  assert.ok(Object.isFrozen((stored.value as { nested: JsonValue }).nested));
  assert.throws(() => { (stored.value as { nested: { name: string } }).nested.name = 'mutation'; });
  assert.throws(() => a.put('bad', NaN), /finite/);
});

test('two unrelated shapes compose without reference remapping and update independently', async () => {
  const music = new LocalGraphSource('music');
  const track = music.put('audio-track', { title: 'Overture', seconds: 123 });
  music.root.set(music.put('playlist', { tracks: [track] }), undefined);
  const weather = new LocalGraphSource('weather');
  const station = weather.put('station-reading', { celsius: 17, coordinates: [48, 12] });
  weather.root.set(weather.put('climate-map', { north: { latest: station } }), undefined);
  const composition = new GraphComposition([
    { id: 'music', label: 'Music', source: music },
    { id: 'weather', label: 'Weather', source: weather },
  ]);
  const first = composition.root.get();
  const historicalLease = await composition.store.retainClosure!(first);
  const before = await createGraphRuntime(composition).batchObjGet(request(first));
  assert.equal(before.objects.length, 5);
  assert.deepEqual(before.missing, []);
  assert.deepEqual(before.objects[0]!.value, {
    sources: [
      { id: 'music', label: 'Music', root: music.root.get() },
      { id: 'weather', label: 'Weather', root: weather.root.get() },
    ],
  });
  const weatherRoot = weather.root.get();
  const versions: GraphRef[] = [];
  const subscription = autorun(reader => { versions.push(composition.root.read(reader)); });
  music.root.set(music.put('playlist', { tracks: [track], shuffle: true }), undefined);
  assert.equal(versions.length, 2);
  assert.notDeepEqual(composition.root.get(), first);
  assert.equal(weather.root.get(), weatherRoot);
  const after = await createGraphRuntime(composition).batchObjGet(request(composition.root.get()));
  const unchanged = after.objects.find(row => row.ref.id === station.id)!;
  assert.equal(unchanged.value, before.objects.find(row => row.ref.id === station.id)!.value);
  assert.equal(after.objects.find(row => row.ref.id === track.id)!.value,
    before.objects.find(row => row.ref.id === track.id)!.value);
  const historical = await createGraphRuntime(composition).batchObjGet(request(first));
  assert.deepEqual(historical, before);
  await historicalLease.dispose();
  subscription.dispose();
  await composition.dispose();
});

test('detached/replaced sources keep exact historical routing even with reused source ids and labels', async () => {
  const old = new LocalGraphSource('reused');
  const oldLeaf = old.put('leaf', { content: 'old' });
  old.root.set(old.put('tree', { leaf: oldLeaf }), undefined);
  const composition = new GraphComposition([{ id: 'slot', label: 'Same', source: old }]);
  const historical = composition.root.get();
  const historicalLease = await composition.store.retainClosure!(historical);
  const expected = await createGraphRuntime(composition).batchObjGet(request(historical));
  composition.setSources([]);
  old.root.set(old.put('tree', { leaf: oldLeaf, detachedChange: true }), undefined);
  const empty = composition.root.get();
  assert.deepEqual((await createGraphRuntime(composition).batchObjGet(request(empty))).objects[0]!.value, { sources: [] });
  const replacement = new LocalGraphSource('reused');
  replacement.root.set(replacement.put('tree', { content: 'new' }), undefined);
  composition.setSources([{ id: 'slot', label: 'Same', source: replacement }]);
  assert.deepEqual(await createGraphRuntime(composition).batchObjGet(request(historical)), expected);
  assert.deepEqual(await composition.store.lookup(oldLeaf), { found: true, value: { content: 'old' } });
  await historicalLease.dispose();
  await composition.dispose();
});

test('cross-source traversal, closure haves, selectors, and bounded batches use standard runtime', async () => {
  const inventory = new LocalGraphSource();
  const product = inventory.put('product', { sku: 'X-123' });
  inventory.root.set(inventory.put('warehouse', { products: [product] }), undefined);
  const orders = new LocalGraphSource();
  orders.root.set(orders.put('order', { quantity: 2, product }), undefined);
  const composition = new GraphComposition([
    { id: 'orders', label: 'Orders', source: orders },
    { id: 'inventory', label: 'Inventory', source: inventory },
  ]);
  const runtime = createGraphRuntime(composition);
  const selected = await runtime.batchObjGet(request(composition.root.get(), ['/sources/0/root/@/product/@']));
  assert.deepEqual(selected.objects.map(row => row.ref.id), [composition.root.get().id, orders.root.get().id, product.id]);
  const first = await runtime.batchObjGet({ ...request(composition.root.get()), limits: { ...limits, maxObjects: 2 } });
  assert.equal(first.complete, false);
  const next = await runtime.batchObjGet({
    ...request(composition.root.get()),
    have: first.objects.map(row => ({ ref: row.ref, coverage: 'object' as const })),
  });
  assert.equal(next.complete, true);
  assert.equal(new Set([...first.objects, ...next.objects].map(row => row.ref.id)).size, 4);
  const cached = await runtime.batchObjGet({
    ...request(composition.root.get()), have: [{ ref: inventory.root.get(), coverage: 'closure' }],
  });
  assert.deepEqual(cached.objects.map(row => row.ref.id), [composition.root.get().id, orders.root.get().id]);
  await composition.dispose();
});

test('simultaneous batches hold independent leases until each lookup finishes', async () => {
  const local = new LocalGraphSource();
  let retained = 0;
  const gates: (() => void)[] = [];
  const source: GraphSource = {
    root: local.root,
    store: {
      retainClosure: () => {
        retained++;
        let disposed = false;
        return { dispose: () => { if (!disposed) { disposed = true; retained--; } } };
      },
      lookup: async ref => {
        await new Promise<void>(resolve => gates.push(resolve));
        return local.store.lookup(ref);
      },
    },
  };
  const runtime = createGraphRuntime(source);
  const first = runtime.batchObjGet(request(source.root.get()));
  const second = runtime.batchObjGet(request(source.root.get()));
  await setImmediate();
  assert.equal(retained, 2);
  assert.equal(gates.length, 2);
  gates[0]!();
  await first;
  assert.equal(retained, 1);
  gates[1]!();
  await second;
  assert.equal(retained, 0);
});

test('composition retains same-store descendants once rather than leasing every overlapping closure', async () => {
  const local = new LocalGraphSource();
  const refs: GraphRef[] = [];
  let ref = local.put('leaf', { value: 0 });
  refs.push(ref);
  for (let i = 0; i < 100; i++) {
    ref = local.put('node', { child: ref });
    refs.push(ref);
  }
  local.root.set(ref, undefined);
  let leases = 0;
  const source: GraphSource = {
    root: local.root,
    store: {
      lookup: ref => local.store.lookup(ref),
      retainClosure: ref => { leases++; return local.store.retainClosure(ref); },
    },
  };
  const composition = new GraphComposition([{ id: 'test', label: 'Test', source }]);
  await setImmediate();
  leases = 0;
  const result = await createGraphRuntime(composition).batchObjGet(request(composition.root.get(), ['/']));
  assert.equal(result.objects.length, 1);
  assert.equal(leases, 1);
  for (const ref of refs) assert.ok(local.store.isRetained(ref));
  await composition.dispose();
  for (const ref of refs) assert.equal(local.store.isRetained(ref), false);
});

test('ambiguous identities and duplicate source ids are rejected without changing the root', async () => {
  const a = new LocalGraphSource();
  const b = new LocalGraphSource();
  b.root.set(a.root.get(), undefined);
  const composition = new GraphComposition();
  const before = composition.root.get();
  assert.throws(() => composition.setSources([
    { id: 'a', label: 'A', source: a }, { id: 'b', label: 'B', source: b },
  ]), /collision/);
  assert.throws(() => composition.setSources([
    { id: 'same', label: 'A', source: a }, { id: 'same', label: 'B', source: a },
  ]), /Duplicate/);
  assert.equal(composition.root.get(), before);
  composition.setSources([{ id: 'a', label: 'A', source: a }]);
  composition.setSources([]);
  assert.throws(() => composition.setSources([{ id: 'a', label: 'A', source: b }]), /collision/);
  await composition.dispose();
});

test('composition retention crosses store boundaries and releases independent batch leases', async () => {
  const a = new LocalGraphSource();
  const b = new LocalGraphSource();
  const leaf = b.put('leaf', { value: 9 });
  b.root.set(b.put('index', { leaf }), undefined);
  a.root.set(a.put('link', { leaf }), undefined);
  const composition = new GraphComposition([
    { id: 'a', label: 'A', source: a }, { id: 'b', label: 'B', source: b },
  ]);
  const root = composition.root.get();
  const lease1 = await composition.store.retainClosure!(root);
  const lease2 = await composition.store.retainClosure!(root);
  await composition.dispose();
  assert.throws(() => b.store.markUnavailable(leaf, 'expired'), /Retained/);
  await lease1.dispose();
  assert.throws(() => b.store.markUnavailable(leaf, 'expired'), /Retained/);
  await lease2.dispose();
  b.store.markUnavailable(leaf, 'expired');
  assert.deepEqual(await b.store.lookup(leaf), { found: false, reason: 'expired' });
  assert.deepEqual(composition.diagnostics, { routes: 0, stores: 0, leases: 0, objects: 0 });
});

test('250 catalog updates keep only current objects, identities, interned values, routes and leases', async () => {
  const source = new LocalGraphSource('bounded');
  const items = Array.from({ length: 1000 }, (_, index) => source.put('item', { index }));
  source.root.set(source.put('catalog', { items, revision: 0 }), undefined);
  const composition = new GraphComposition([{ id: 'source', label: 'Source', source }]);
  for (let revision = 1; revision <= 250; revision++) {
    source.root.set(source.put('catalog', { items, revision }), undefined);
    if (revision % 25 === 0) await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(source.diagnostics, { objects: 1001, identities: 1001, interned: 1001, retainedRoots: 1 });
  assert.deepEqual(composition.diagnostics, { routes: 1002, stores: 2, leases: 1, objects: 1 });
  await composition.dispose();
  source.dispose();
  assert.deepEqual(source.diagnostics, { objects: 0, identities: 0, interned: 0, retainedRoots: 0 });
  assert.deepEqual(composition.diagnostics, { routes: 0, stores: 0, leases: 0, objects: 0 });
});

test('leased historical roots remain readable after collection, then fully reclaim on release', async () => {
  const source = new LocalGraphSource('old-pinned');
  const oldItem = source.put('item', { text: 'old' });
  const oldRoot = source.put('catalog', { items: [oldItem] });
  source.root.set(oldRoot, undefined);
  const composition = new GraphComposition([{ id: 'source', label: 'Source', source }]);
  const previous = composition.root.get();
  const pin = await composition.store.retainClosure!(previous);
  const nextRoot = source.put('catalog', { items: [] });
  source.root.set(nextRoot, undefined);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await source.store.lookup(oldItem), { found: true, value: { text: 'old' } });
  const old = await createGraphRuntime(composition).batchObjGet(request(previous));
  assert.equal(old.objects.length, 3);
  assert.deepEqual(old.missing, []);
  await pin.dispose();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(source.store.lookup(oldItem).found, false);
  assert.equal(source.store.lookup(oldRoot).found, false);
  assert.equal((await composition.store.lookup(previous)).found, false);
  assert.deepEqual(source.diagnostics, { objects: 1, identities: 1, interned: 1, retainedRoots: 1 });
  const repeated = source.put('item', { text: 'old' });
  assert.notEqual(repeated.id, oldItem.id, 'collected ids must never be reassigned');
  await composition.dispose();
  source.dispose();
});

test('replacing 250 independent sources releases detached stores and route history', async () => {
  const composition = new GraphComposition();
  const sources: LocalGraphSource[] = [];
  for (let index = 0; index < 250; index++) {
    const source = new LocalGraphSource(`source-${index}`);
    sources.push(source);
    source.root.set(source.put('catalog', { index }), undefined);
    composition.setSources([{ id: 'slot', label: 'Source', source }]);
    if (index % 25 === 0) await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(composition.diagnostics, { routes: 2, stores: 2, leases: 1, objects: 1 });
  for (const source of sources.slice(0, -1)) assert.equal(source.diagnostics.retainedRoots, 0);
  await composition.dispose();
  for (const source of sources) source.dispose();
});

test('known routes acquire a lease before asynchronous peek can overlap root replacement and collection', async () => {
  const local = new LocalGraphSource('delayed-peek');
  const old = local.put('record', { version: 1 });
  local.root.set(old, undefined);
  let delayed = false;
  let entered!: () => void;
  const peeking = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const composition = new GraphComposition([{
    id: 'source', label: 'Source',
    source: {
      root: local.root,
      store: {
        lookup: ref => local.store.lookup(ref),
        retainClosure: ref => local.store.retainClosure(ref),
        peek: async ref => {
          if (delayed && ref.id === old.id) { entered(); await gate; }
          return local.store.lookup(ref);
        },
      },
    },
  }]);
  try {
    await composition.store.lookup(composition.root.get());
    delayed = true;
    const acquiring = composition.store.retainClosure!(old);
    await peeking;
    local.root.set(local.put('record', { version: 2 }), undefined);
    await composition.store.lookup(composition.root.get());
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(local.store.isRetained(old), true);
    assert.deepEqual(local.store.lookup(old), { found: true, value: { version: 1 } });
    release();
    const lease = await acquiring;
    assert.deepEqual(await composition.store.lookup(old), { found: true, value: { version: 1 } });
    await lease.dispose();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(local.store.lookup(old).found, false);
  } finally {
    release();
    await composition.dispose();
    local.dispose();
  }
});

test('current retention failures surface through composition errors, lookups and watches, then recover', async () => {
  const local = new LocalGraphSource('retention-error');
  let fail = true;
  const composition = new GraphComposition([{
    id: 'source', label: 'Source',
    source: {
      root: local.root,
      store: {
        lookup: ref => local.store.lookup(ref),
        retainClosure: ref => {
          if (fail) throw new Error('Cannot retain source root');
          return local.store.retainClosure(ref);
        },
      },
    },
  }]);
  const pair = new TransportPair();
  const server = LinkRpcConnection.fromTransport(pair.a);
  const connection = LinkRpcConnection.fromTransport(pair.b);
  const registration = registerGraphSource(server, composition);
  const client = new GraphClient(connection);
  try {
    await assert.rejects(Promise.resolve(composition.store.lookup(composition.root.get())), /Cannot retain source root/);
    await assert.rejects(Promise.resolve(composition.store.retainClosure!(composition.root.get())), /Cannot retain source root/);
    assert.match(composition.error.get()?.message ?? '', /Cannot retain source root/);
    for (let i = 0; i < 100 && !client.rootError.get(); i++) await setImmediate();
    assert.match(client.rootError.get() ?? '', /Cannot retain source root/);
    fail = false;
    local.root.set(local.put('root', { recovered: true }), undefined);
    await composition.store.lookup(composition.root.get());
    assert.equal(composition.error.get(), undefined);
    client.retryRoot();
    for (let i = 0; i < 100 && client.root.get().kind !== 'ready'; i++) await setImmediate();
    assert.equal(client.root.get().kind, 'ready');
    assert.equal(client.rootError.get(), undefined);
  } finally {
    client.dispose();
    registration.dispose();
    await composition.dispose();
    local.dispose();
    connection.close();
    server.close();
  }
});

test.each(['', 'sources/test'])('standard interface roundtrips batches and watch acknowledgements with clean disposal (%s)', async serviceId => {
  const schema = graphInterface.toSchema();
  assert.deepEqual(Object.keys(graphInterface.members), ['objects$batchObjGet', 'workspace$watch']);
  const templates = schema['x-interface-templates'] as {
    instances: { name: string; template: string; members: Record<string, string> }[];
  };
  assert.deepEqual(templates.instances.map(({ name, template, members }) =>
    ({ name, template, members: { ...members } })), [
    { name: 'objects', template: 'linkrpc.graph.objects.v1', members: { batchObjGet: 'objects$batchObjGet' } },
    { name: 'workspace', template: 'linkrpc.graph.root.v1', members: { watch: 'workspace$watch' } },
  ]);
  const local = new LocalGraphSource();
  const { client, server } = connectionPair();
  onTestFinished(() => { client.close(); server.close(); });
  const registration = registerGraphSource(server, local, { serviceId });
  onTestFinished(() => registration.dispose());
  const rpc = client.service(serviceId).get(graphInterface);
  const batch = await rpc.objects.batchObjGet(request(local.root.get()));
  assert.deepEqual(batch.objects, [{ ref: local.root.get(), value: {} }]);
  type Offer = { version: number; ref: GraphRef };
  const messages: Offer[] = [];
  const receivers: ((offer: Offer) => void)[] = [];
  const next = (): Promise<Offer> => {
    const message = messages.shift();
    return message === undefined ? new Promise(resolve => receivers.push(resolve)) : Promise.resolve(message);
  };
  const watch = rpc.workspace.watch({}, {
    onMessage: offer => {
      const receiver = receivers.shift();
      if (receiver !== undefined) receiver(offer);
      else messages.push(offer);
    },
  });
  const first = await next();
  assert.deepEqual(first.ref, local.root.get());
  assert.equal(local.store.isRetained(first.ref), true);
  local.root.set(local.put('next', { version: 2 }), undefined);
  local.root.set(local.put('next', { version: 3 }), undefined);
  await watch.send({ accept: first.version });
  const second = await next();
  assert.deepEqual(second.ref, local.root.get());
  assert.equal(local.store.isRetained(first.ref), true);
  assert.equal(local.store.isRetained(second.ref), true);
  await watch.send({ accept: second.version });
  await setImmediate();
  assert.equal(local.store.isRetained(first.ref), false);
  registration.dispose();
  assert.deepEqual(await watch, {});
  assert.equal(local.store.isRetained(second.ref), false);
  registration.dispose();
  assert.equal(server.findRegisteredInterface(graphInterface.info.id, serviceId), undefined);
});

function connectionPair(): { client: LinkRpcConnection; server: LinkRpcConnection } {
  let receiveClient: ((message: JsonRpcMessage) => void) | undefined;
  let receiveServer: ((message: JsonRpcMessage) => void) | undefined;
  return {
    client: LinkRpcConnection.fromTransport({
      send: message => { queueMicrotask(() => receiveServer?.(structuredClone(message))); },
      setListener: listener => { receiveClient = listener; },
      dispose: () => { receiveClient = undefined; },
    }),
    server: LinkRpcConnection.fromTransport({
      send: message => { queueMicrotask(() => receiveClient?.(structuredClone(message))); },
      setListener: listener => { receiveServer = listener; },
      dispose: () => { receiveServer = undefined; },
    }),
  };
}
