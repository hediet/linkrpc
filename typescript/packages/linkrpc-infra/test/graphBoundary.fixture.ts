import { z } from 'zod';
import {
    defineInterface, LinkRpcConnection, TransportPair,
    type InterfaceClient, type Schema,
} from '@hediet/linkrpc';
import {
    GraphObjects, GraphRoot, ImmutableGraphRuntime, InMemoryImmutableGraphStore,
    RootWatchCoordinator, validateGraphInterfaceSchema,
} from '@hediet/linkrpc-infra/graph';

const refSchema = z.object({ store: z.string(), id: z.string() });
type Ref = z.infer<typeof refSchema>;
const valueSchema = z.object({ label: z.string(), child: refSchema.optional() });
type Value = z.infer<typeof valueSchema>;

// These factories must remain generic through the package's emitted declarations.
export const genericObjects = <R, V>(ref: Schema<R>, value: Schema<V>) => GraphObjects({ ref, value });
export const genericRoot = <P, R>(params: Schema<P>, ref: Schema<R>) => GraphRoot({ params, ref });
const objects = genericObjects(refSchema, valueSchema).mapMembers({ batchObjGet: 'fetchObjects' });
const root = genericRoot(z.object({ filter: z.string() }), refSchema);
const definition = defineInterface({ id: 'test.generic-graph' }, { objects, root });

function assertClientTypes(client: InterfaceClient<typeof definition>) {
    const batch = client.objects.batchObjGet({
        needs: [{ ref: { store: 's', id: '1' }, paths: ['/**'] }],
        have: [], limits: { maxObjects: 1, maxBytes: 1000 },
    });
    const exact: Promise<{ objects: { ref: Ref; value: Value }[]; missing: {
        ref: Ref; reason: 'missing' | 'expired' | 'forbidden' | 'oversized'; detail?: string;
    }[]; complete: boolean }> = batch;
    // @ts-expect-error references remain specialized, not unknown or any
    client.objects.batchObjGet({ needs: [{ ref: 42, paths: [] }], have: [], limits: { maxObjects: 1, maxBytes: 1000 } });
    // @ts-expect-error flattened wire names do not leak into nested clients
    client.fetchObjects({});
    // @ts-expect-error root parameters remain specialized
    client.root.watch({ filter: 42 });
    const watching = client.root.watch({ filter: 'all' }, {
        onMessage: offer => { const exact: Ref = offer.ref; void exact; },
    });
    void watching.send({ accept: 1 });
    // @ts-expect-error duplex acceptance retains its payload type
    void watching.send({ accept: '1' });
    return exact;
}
void assertClientTypes;

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(predicate: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await pause();
    }
    throw new Error('Graph boundary fixture timed out');
}

export async function runGraphBoundaryFixture() {
    validateGraphInterfaceSchema(definition.toSchema());
    const options = {
        refKey: (ref: Ref) => JSON.stringify([ref.store, ref.id]),
        isRef: (value: unknown): value is Ref => refSchema.safeParse(value).success,
    };
    const store = new InMemoryImmutableGraphStore<Ref, Value>(options);
    const one = { store: 'test', id: 'one' }, two = { store: 'test', id: 'two' };
    store.set(one, { label: 'one', child: two });
    store.set(two, { label: 'two' });
    const runtime = new ImmutableGraphRuntime(store, options);
    const coordinator = new RootWatchCoordinator({
        paramsKey: (params: { filter: string }) => params.filter,
        sameRef: (a: Ref, b: Ref) => options.refKey(a) === options.refKey(b), retention: store,
    });
    coordinator.publish({ filter: 'all' }, one);
    const pair = new TransportPair();
    const client = LinkRpcConnection.fromTransport(pair.a);
    const server = LinkRpcConnection.fromTransport(pair.b);
    let serverWatch: Promise<Record<string, never>> | undefined;
    const registration = server.register(definition, {
        objects: { batchObjGet: params => runtime.batchObjGet(params) },
        root: { watch: (params, _context, stream) => {
            serverWatch = coordinator.watch(params, stream);
            return serverWatch;
        } },
    });
    let cancelWatch: (() => Promise<void>) | undefined;
    try {
        const remote = client.get(definition);
        const first = await remote.objects.batchObjGet({
            needs: [{ ref: one, paths: ['/**'] }], have: [],
            limits: { maxObjects: 1, maxBytes: 1000 },
        });
        const second = await remote.objects.batchObjGet({
            needs: [{ ref: one, paths: ['/**'] }],
            have: [{ ref: one, coverage: 'object' }],
            limits: { maxObjects: 1, maxBytes: 1000 },
        });
        const offers: { version: number; ref: Ref }[] = [];
        const watching = remote.root.watch({ filter: 'all' }, {
            onMessage: offer => offers.push(offer),
        });
        cancelWatch = () => watching.cancel();
        const settled = Promise.resolve(watching).then(() => 'resolved', () => 'cancelled');
        await until(() => offers.length === 1);
        await watching.send({ accept: offers[0]!.version });
        coordinator.publish({ filter: 'all' }, two);
        await until(() => offers.length === 2);
        const retainedBeforeAck = store.isRetained(one) && store.isRetained(two);
        await watching.send({ accept: offers[1]!.version });
        await until(() => !store.isRetained(one));
        const retainedAfterAck = store.isRetained(two);
        await watching.cancel('fixture complete');
        const cancellation = await settled;
        await serverWatch;
        await until(() => !store.isRetained(two));
        return {
            first, second, offers, retainedBeforeAck, retainedAfterAck, cancellation,
            released: !store.isRetained(one) && !store.isRetained(two),
            members: Object.keys(definition.toSchema().methods),
        };
    } finally {
        await cancelWatch?.();
        registration.dispose();
        client.close();
        server.close();
    }
}
