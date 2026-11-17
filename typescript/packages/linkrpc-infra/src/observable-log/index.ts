import { array, boolean, number, object, optional, string } from 'zod/mini';
import { defineInterfaceTemplate, requestType, type Schema } from '@hediet/linkrpc';
import { runChangeLoop, type ServerStream } from '../observable-query/changeLoop';

export const OBSERVABLE_LOG_TEMPLATE_ID = 'linkrpc.observableLog.v1';
export const OBSERVABLE_LOG_INTERFACE_TAG = 'linkrpc.observableLog';

/**
 * A family of append-only logs, one per `params`, as an interface template (e.g. the comments of
 * any pull request, or the messages of a chat channel). Entries have opaque, ordered cursors, so a
 * reader that stores the last cursor it has seen can resume after any interruption without missing
 * entries; if the source no longer retains some of them, the reader is told so (`gap`) instead of
 * losing them silently. Interfaces that instantiate it are tagged {@link OBSERVABLE_LOG_INTERFACE_TAG}.
 */
export const ObservableLogTemplate = defineInterfaceTemplate(
    { id: OBSERVABLE_LOG_TEMPLATE_ID, parameters: ['params', 'entry'], tags: [OBSERVABLE_LOG_INTERFACE_TAG] },
    <P, E>({ params, entry }: { params: Schema<P>; entry: Schema<E> }) => {
        const page = object({
            entries: array(object({ cursor: string(), entry })),
            gap: boolean(),
            cursor: optional(string()),
        });
        return {
            read: requestType(object({ params, after: optional(string()), limit: optional(number()) }), page, {
                description: 'Read entries after the cursor `after` (from the oldest retained entry when omitted), oldest first. '
                    + '`cursor` is where to continue; `gap` means entries directly after `after` are no longer retained.',
            }),
            follow: requestType(object({ params, after: optional(string()) }), object({}), {
                description: 'Stream pages of entries after `after` (only new entries when omitted), until cancelled. '
                    + 'The first page is sent right away, even when empty, so its `cursor` tells where the stream started.',
            }).withStream({ server: page }),
        };
    },
);

export interface ObservableLogEntry<E> {
    readonly cursor: string;
    readonly entry: E;
}

export interface ObservableLogPage<E> {
    readonly entries: ObservableLogEntry<E>[];
    /** Entries directly after the requested cursor are no longer retained. */
    readonly gap: boolean;
    /** The cursor to continue from; absent only while the log is empty. */
    readonly cursor?: string;
}

/** A family of logs that {@link observableLogHandlers} can serve. */
export interface ObservableLogSource<P, E> {
    /** At most `limit` entries after `after` (from the oldest retained when undefined), oldest first. */
    read(params: P, after: string | undefined, limit: number): ObservableLogRead<E> | Promise<ObservableLogRead<E>>;
    /** The cursor of the newest entry, or undefined while the log is empty. */
    latest(params: P): string | undefined | Promise<string | undefined>;
    /** Calls the listener after new entries may exist for `params`; returns a function that unsubscribes. */
    subscribe(params: P, listener: () => void): () => void;
}

export type ObservableLogRead<E> = Pick<ObservableLogPage<E>, 'entries' | 'gap'>;

export interface ObservableLogHandlerOptions {
    /** Entries per page when the reader sets no limit. Default 100. */
    readonly pageSize?: number;
    /** Minimum time between two reads of one follower. Default 0. */
    readonly minIntervalMs?: number;
}

/**
 * Handlers for one {@link ObservableLogTemplate} instance. Use them as the instance's member group
 * when registering, e.g. `{ comments: observableLogHandlers(comments) }`.
 */
export function observableLogHandlers<P, E>(
    source: ObservableLogSource<P, E>,
    options: ObservableLogHandlerOptions = {},
): {
    read: (request: { params: P; after?: string; limit?: number }) => Promise<ObservableLogPage<E>>;
    follow: (request: { params: P; after?: string }, context: unknown, stream: ServerStream<ObservableLogPage<E>>) => Promise<Record<string, never>>;
} {
    const pageSize = options.pageSize ?? 100;
    const readPage = async (params: P, after: string | undefined, limit: number): Promise<ObservableLogPage<E>> => {
        const { entries, gap } = await source.read(params, after, limit);
        const cursor = entries.length > 0 ? entries[entries.length - 1].cursor : after;
        return { entries, gap, ...(cursor === undefined ? {} : { cursor }) };
    };
    return {
        read: ({ params, after, limit }) => readPage(params, after, limit ?? pageSize),
        follow: async ({ params, after }, _context, stream) => {
            let cursor = after ?? await source.latest(params);
            let started = false;
            await runChangeLoop(stream.signal, listener => source.subscribe(params, listener), async () => {
                for (;;) {
                    const page = await readPage(params, cursor, pageSize);
                    if (!started || page.entries.length > 0 || page.gap) {
                        started = true;
                        await stream.send(page);
                    }
                    cursor = page.cursor;
                    if (page.entries.length < pageSize) return;
                }
            }, options.minIntervalMs ?? 0);
            return {};
        },
    };
}
