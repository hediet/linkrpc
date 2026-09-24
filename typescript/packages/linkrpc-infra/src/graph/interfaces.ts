import {
    array, boolean, enum as zEnum, number, object, optional, string, type output,
} from 'zod/mini';
import { defineInterface, defineInterfaceTemplate, requestType, type Schema } from '@hediet/linkrpc';

export const IMMUTABLE_GRAPH_INTERFACE_ID = 'linkrpc.graph.objects.v1';
export const ROOT_WATCH_INTERFACE_ID = 'linkrpc.graph.root.v1';
export const LIVE_RESOURCE_WATCH_INTERFACE_ID = 'linkrpc.graph.live.v1';
export const GRAPH_INTERFACE_TAG = 'linkrpc.graph';
export const graphRefSchema = object({ kind: string(), id: string() });
export type GraphRef = output<typeof graphRefSchema>;
export type GraphCoverage = 'object' | 'closure';
export type GraphMissingReason = 'missing' | 'expired' | 'forbidden' | 'oversized';

export const GraphObjects = defineInterfaceTemplate(
    { id: IMMUTABLE_GRAPH_INTERFACE_ID, parameters: ['ref', 'value'] },
    <R, V>({ ref, value }: { ref: Schema<R>; value: Schema<V> }) => ({
        batchObjGet: requestType(
            object({
                needs: array(object({ ref, paths: array(string()) })),
                have: array(object({ ref, coverage: zEnum(['object', 'closure']) })),
                limits: object({ maxObjects: number(), maxBytes: number() }),
            }),
            object({
                objects: array(object({ ref, value })),
                missing: array(object({
                    ref, reason: zEnum(['missing', 'expired', 'forbidden', 'oversized']),
                    detail: optional(string()),
                })),
                complete: boolean(),
            }),
            { description: 'Fetch a deterministic ancestor-first graph batch. This is a normal '
                + 'request/response method; budget exhaustion returns partial progress.' },
        ).withErrors([]),
    }),
);

export const GraphRoot = defineInterfaceTemplate(
    { id: ROOT_WATCH_INTERFACE_ID, parameters: ['params', 'ref'], tags: [GRAPH_INTERFACE_TAG] },
    <P, R>({ params, ref }: { params: Schema<P>; ref: Schema<R> }) => ({
        watch: requestType(params, object({}), {
            description: 'Watch one typed root. The server streams {version,ref}; the client '
                + 'acknowledges with {accept:version}.',
        }).withErrors([]).withStream({
            client: object({ accept: number() }),
            server: object({ version: number(), ref }),
        }),
    }),
);

export interface DefineLiveResourceWatchInterfaceOptions<TParams, TEvent> {
    readonly id?: string;
    readonly paramsSchema: Schema<TParams>;
    readonly eventSchema: Schema<TEvent>;
}

export function defineLiveResourceWatchInterface<TParams, TEvent>(
    options: DefineLiveResourceWatchInterfaceOptions<TParams, TEvent>,
) {
    return defineInterface({
        id: options.id ?? LIVE_RESOURCE_WATCH_INTERFACE_ID,
        description: 'Watch a stable live resource. Events are mutable observations and are '
            + 'deliberately separate from immutable graph references and closure sync.',
    }, {
        watch: requestType(options.paramsSchema, object({}), {
            description: 'Stream observations for a stable resource until the request is cancelled.',
        }).withErrors([]).withStream({ server: options.eventSchema }),
    });
}
