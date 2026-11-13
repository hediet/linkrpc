import { object } from 'zod/mini';
import { defineInterfaceTemplate, requestType, type Schema } from '@hediet/linkrpc';

export const OBSERVABLE_VALUE_TEMPLATE_ID = 'linkrpc.observableValue.v1';
export const OBSERVABLE_VALUE_INTERFACE_TAG = 'linkrpc.observableValue';

/**
 * A value that changes over time, as an interface template: `get` reads it, `watch` streams it.
 * Instantiate it once per value; without a member mapping, instance `x` has the wire methods
 * `x$get` and `x$watch`. Interfaces that instantiate it are tagged
 * {@link OBSERVABLE_VALUE_INTERFACE_TAG}, so generic clients (dashboards, the Stream Deck) find
 * observable values through directory tags and the reflected template metadata.
 */
export const ObservableValueTemplate = defineInterfaceTemplate(
    { id: OBSERVABLE_VALUE_TEMPLATE_ID, parameters: ['value'], tags: [OBSERVABLE_VALUE_INTERFACE_TAG] },
    <V>({ value }: { value: Schema<V> }) => ({
        get: requestType(object({}), object({ value }), {
            description: 'Read the current value.',
        }),
        watch: requestType(object({}), object({}), {
            description: 'Stream `{ value }`: the current value first, then every change, until cancelled. '
                + 'Rapid changes may be coalesced; the latest value is always delivered.',
        }).withStream({ server: object({ value }) }),
    }),
);

/** A readable, changing value that {@link observableValueHandlers} can serve. */
export interface ObservableValueSource<V> {
    get(): V;
    /** Calls the listener after the value may have changed; returns a function that unsubscribes. */
    subscribe(listener: () => void): () => void;
}

export interface ObservableValueHandlerOptions<V> {
    /** Minimum time between two streamed values of one watcher; later changes are coalesced. Default 0. */
    readonly minIntervalMs?: number;
    /** Whether two values are equal and need not be sent again. Default: JSON equality. */
    readonly equals?: (a: V, b: V) => boolean;
}

interface WatchStream<T> {
    readonly signal: AbortSignal;
    send(message: T): Promise<void>;
}

/**
 * Handlers for one {@link ObservableValueTemplate} instance. Use them as the instance's member group
 * when registering, e.g. `{ tokensPerSecond: observableValueHandlers(source) }`.
 */
export function observableValueHandlers<V>(
    source: ObservableValueSource<V>,
    options: ObservableValueHandlerOptions<V> = {},
): {
    get: () => { value: V };
    watch: (params: object, context: unknown, stream: WatchStream<{ value: V }>) => Promise<Record<string, never>>;
} {
    const equals = options.equals ?? ((a: V, b: V) => JSON.stringify(a) === JSON.stringify(b));
    const minIntervalMs = options.minIntervalMs ?? 0;
    return {
        get: () => ({ value: source.get() }),
        watch: async (_params, _context, stream) => {
            let sent: { value: V } | undefined;
            let lastSentAt = -Infinity;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let sending = Promise.resolve();
            const flush = () => {
                timer = undefined;
                const value = source.get();
                if (sent && equals(sent.value, value)) return;
                sent = { value };
                lastSentAt = Date.now();
                sending = sending.then(() => stream.send({ value })).catch(() => { /* the watcher went away */ });
            };
            const schedule = () => {
                if (timer !== undefined || stream.signal.aborted) return;
                timer = setTimeout(flush, Math.max(0, lastSentAt + minIntervalMs - Date.now()));
            };
            flush();
            const unsubscribe = source.subscribe(schedule);
            try {
                await new Promise<void>(resolve => {
                    if (stream.signal.aborted) resolve();
                    else stream.signal.addEventListener('abort', () => resolve(), { once: true });
                });
            } finally {
                unsubscribe();
                if (timer !== undefined) clearTimeout(timer);
            }
            return {};
        },
    };
}
