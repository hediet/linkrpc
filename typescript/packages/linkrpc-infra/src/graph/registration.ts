import type { JsonValue, LinkRpcConnection, StreamApi } from '@hediet/linkrpc';
import { autorun } from '@vscode/observables';
import { ImmutableGraphRuntime, standardGraphRuntimeOptions } from './immutableGraph';
import type { GraphRef } from './interfaces';
import { graphInterface, retainedGraphInterface } from './protocol';
import { RootWatchCoordinator } from './rootWatch';
import type { GraphSource } from './source';
import { graphPresentationInterface, graphPresentationSchema } from './presentation';

export function createGraphRuntime(source: GraphSource): ImmutableGraphRuntime<GraphRef, JsonValue> {
    return new ImmutableGraphRuntime(source.store, standardGraphRuntimeOptions);
}

/** Register the canonical object/root protocol and independent immutable-root leases.
 * A provider may initialize lazily; it must resolve to the same source during this registration.
 */
export function registerGraphSource(
    connection: LinkRpcConnection,
    source: GraphSource | (() => Promise<GraphSource>),
    options: { serviceId?: string } = {},
): { dispose(): void } {
    const getSource = typeof source === 'function' ? source : async () => source;
    const abort = new AbortController();
    const subscriptions = new Set<{ dispose(): void }>();
    const retention = {
        retainClosure: async (ref: GraphRef) => {
            const current = await getSource();
            return await current.store.retainClosure?.(ref) ?? { dispose() {} };
        },
    };
    const runtime = new ImmutableGraphRuntime({
        lookup: async (ref: GraphRef) => (await getSource()).store.lookup(ref),
        ...retention,
    }, standardGraphRuntimeOptions);
    const sameRef = (a: GraphRef, b: GraphRef) =>
        standardGraphRuntimeOptions.refKey(a) === standardGraphRuntimeOptions.refKey(b);
    const scope = (stream: StreamApi<{ accept: number }, { version: number; ref: GraphRef }>) => ({
        ...stream, signal: AbortSignal.any([stream.signal, abort.signal]),
    });
    const graph = connection.register(graphInterface, {
        objects: { batchObjGet: request => runtime.batchObjGet(request) },
        workspace: {
            watch: async (_params, _context, stream) => {
                const current = await getSource();
                const scoped = scope(stream);
                if (scoped.signal.aborted) return {};
                const roots = new RootWatchCoordinator<Record<string, never>, GraphRef>({
                    paramsKey: () => '', sameRef, retention,
                });
                const subscription = autorun(reader => roots.publish({}, current.root.read(reader)));
                subscriptions.add(subscription);
                try {
                    return await roots.watch({}, scoped);
                } finally {
                    subscription.dispose();
                    subscriptions.delete(subscription);
                }
            },
        },
    }, options);
    const pins = connection.register(retainedGraphInterface, {
        objects: { batchObjGet: request => runtime.batchObjGet(request) },
        root: {
            watch: (params, _context, stream) => {
                // Per-call coordinators discard parameter/ref bookkeeping on cancellation.
                const roots = new RootWatchCoordinator<{ ref: GraphRef }, GraphRef>({
                    paramsKey: params => standardGraphRuntimeOptions.refKey(params.ref),
                    sameRef, retention,
                });
                roots.publish(params, params.ref);
                return roots.watch(params, scope(stream));
            },
        },
    }, options);
    const presentation = connection.register(graphPresentationInterface, {
        get: async () => graphPresentationSchema.parse((await getSource()).presentation ?? { rules: {} }),
    }, options);
    let disposed = false;
    const close = connection.onDidClose(() => result.dispose());
    const result = {
        dispose: () => {
            if (disposed) return;
            disposed = true;
            close.dispose();
            abort.abort();
            for (const subscription of subscriptions) subscription.dispose();
            subscriptions.clear();
            graph.dispose();
            pins.dispose();
            presentation.dispose();
        },
    };
    return result;
}
