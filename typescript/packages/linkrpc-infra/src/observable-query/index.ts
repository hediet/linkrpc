import { object } from 'zod/mini';
import { defineInterfaceTemplate, requestType, type Schema } from '@hediet/linkrpc';
import { runChangeLoop, type ServerStream } from './changeLoop';

export const OBSERVABLE_QUERY_TEMPLATE_ID = 'linkrpc.observableQuery.v1';
export const OBSERVABLE_QUERY_INTERFACE_TAG = 'linkrpc.observableQuery';

/**
 * A family of changing values, one per `params`, as an interface template: the parameterized form
 * of `linkrpc.observableValue` (e.g. the state of any pull request, given its repository and number).
 * `get` reads the current value, `watch` streams it. Unlike an event stream, a missed update is
 * harmless: the current value always tells the whole state, so a watcher that reconnects calls
 * `get`/`watch` again and compares. Interfaces that instantiate it are tagged
 * {@link OBSERVABLE_QUERY_INTERFACE_TAG}.
 */
export const ObservableQueryTemplate = defineInterfaceTemplate(
    { id: OBSERVABLE_QUERY_TEMPLATE_ID, parameters: ['params', 'value'], tags: [OBSERVABLE_QUERY_INTERFACE_TAG] },
    <P, V>({ params, value }: { params: Schema<P>; value: Schema<V> }) => ({
        get: requestType(object({ params }), object({ value }), {
            description: 'Read the current value for `params`.',
        }),
        watch: requestType(object({ params }), object({}), {
            description: 'Stream `{ value }` for `params`: the current value first, then every change, until cancelled. '
                + 'Rapid changes may be coalesced; the latest value is always delivered.',
        }).withStream({ server: object({ value }) }),
    }),
);

/** A readable family of changing values that {@link observableQueryHandlers} can serve. */
export interface ObservableQuerySource<P, V> {
    get(params: P): V | Promise<V>;
    /**
     * Calls the listener after the value for `params` may have changed; returns a function that
     * unsubscribes. A polling source starts polling here and stops when the last listener leaves.
     */
    subscribe(params: P, listener: () => void): () => void;
}

export interface ObservableQueryHandlerOptions<V> {
    /** Minimum time between two reads of one watcher; later changes are coalesced. Default 0. */
    readonly minIntervalMs?: number;
    /** Whether two values are equal and need not be sent again. Default: JSON equality. */
    readonly equals?: (a: V, b: V) => boolean;
}

/**
 * Handlers for one {@link ObservableQueryTemplate} instance. Use them as the instance's member group
 * when registering, e.g. `{ pullRequest: observableQueryHandlers(pullRequests) }`.
 */
export function observableQueryHandlers<P, V>(
    source: ObservableQuerySource<P, V>,
    options: ObservableQueryHandlerOptions<V> = {},
): {
    get: (request: { params: P }) => Promise<{ value: V }>;
    watch: (request: { params: P }, context: unknown, stream: ServerStream<{ value: V }>) => Promise<Record<string, never>>;
} {
    const equals = options.equals ?? ((a: V, b: V) => JSON.stringify(a) === JSON.stringify(b));
    return {
        get: async ({ params }) => ({ value: await source.get(params) }),
        watch: async ({ params }, _context, stream) => {
            let sent: { value: V } | undefined;
            await runChangeLoop(stream.signal, listener => source.subscribe(params, listener), async () => {
                const value = await source.get(params);
                if (sent && equals(sent.value, value)) return;
                sent = { value };
                await stream.send({ value });
            }, options.minIntervalMs ?? 0);
            return {};
        },
    };
}
