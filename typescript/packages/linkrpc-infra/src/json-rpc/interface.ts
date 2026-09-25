import { defineInterface, requestType } from '@hediet/linkrpc';
import {
    discriminatedUnion,
    enum as zEnum,
    literal,
    array,
    int,
    number,
    object,
    optional,
    string,
    positive,
    unknown,
} from 'zod/mini';

export const jsonRpcConnectionCloseReasonSchema = zEnum([
    'cancelled',
    'closed',
    'disposed',
    'remoteClosed',
]);

export type JsonRpcConnectionCloseReason =
    | 'cancelled'
    | 'closed'
    | 'disposed'
    | 'remoteClosed'
    | 'idleTimeout'
    | 'ttl';

export const jsonRpcConnectionDescriptorSchema = object({
    connectionId: string(),
    initializationResult: optional(unknown()),
});

export const jsonRpcConnectionOptionsSchema = object({
    params: optional(unknown()),
    idleTimeoutMs: optional(number().check(int(), positive())),
    ttlMs: optional(number().check(int(), positive())),
});

export type JsonRpcConnectionDescriptor = {
    connectionId: string;
    initializationResult?: unknown;
};

export type JsonRpcConnectionOptions = {
    params?: unknown;
    idleTimeoutMs?: number;
    ttlMs?: number;
};

const rawFrameSchema = object({ frame: unknown() });

/**
 * Opens a transparent JSON-RPC transport over one duplex LinkRPC request.
 * Frames are intentionally opaque; the endpoint owns JSON-RPC semantics.
 */
export const jsonRpcManagedConnectionInterface = defineInterface(
    {
        id: 'jsonRpcManagedConnection',
        description: 'Creates and controls managed JSON-RPC connections.',
    },
    {
        open: requestType(jsonRpcConnectionOptionsSchema, jsonRpcConnectionDescriptorSchema),
        connect: requestType(
            jsonRpcConnectionOptionsSchema,
            object({ reason: zEnum(['cancelled', 'closed', 'disposed', 'idleTimeout', 'remoteClosed', 'ttl']) }),
        ).withStream({
            server: object({ type: literal('opened'), connection: jsonRpcConnectionDescriptorSchema }),
        }),
        status: requestType(object({ connectionId: string() }), object({
            connectionId: string(),
            openedAt: number(),
            lastActivityAt: number(),
            state: literal('open'),
            reverseRequestPolicy: zEnum(['queue', 'reject']),
        })),
        request: requestType(object({ connectionId: string(), method: string(), params: optional(unknown()) }), object({ result: unknown() })),
        notify: requestType(object({ connectionId: string(), method: string(), params: optional(unknown()) }), object({ sent: literal(true) })),
        readEvents: requestType(object({ connectionId: string(), after: optional(number()), waitMs: optional(number()) }), object({
            events: array(discriminatedUnion('type', [
                object({ type: literal('notification'), sequence: number(), receivedAt: number(), method: string(), params: optional(unknown()) }),
                object({ type: literal('request'), sequence: number(), receivedAt: number(), requestToken: string(), method: string(), params: optional(unknown()), autoRejectAt: number() }),
            ])),
            next: number(),
            droppedBefore: number(),
        })),
        respond: requestType(discriminatedUnion('kind', [
            object({ kind: literal('result'), connectionId: string(), requestToken: string(), result: unknown() }),
            object({ kind: literal('error'), connectionId: string(), requestToken: string(), error: object({ code: number(), message: string(), data: optional(unknown()) }) }),
        ]), object({ responded: literal(true) })),
        close: requestType(object({ connectionId: string() }), object({ closed: literal(true) })),
    },
);

/** Control contract registered by registerJsonRpcConnectionFactory. */
export const jsonRpcConnectionFactoryInterface = jsonRpcManagedConnectionInterface;

/** Unchanged raw interface: existing clients and servers retain their wire schema. */
export const jsonRpcConnectionInterface = defineInterface(
    {
        id: 'jsonRpcConnection',
        description: 'Opens transparent JSON-RPC transports over LinkRPC streams.',
    },
    {
        connectRaw: requestType(
            object({ params: optional(unknown()) }),
            object({ reason: jsonRpcConnectionCloseReasonSchema }),
            {
                description:
                    'Open a transparent JSON-RPC transport tied to this request. '
                    + 'Cancellation closes the transport.',
            },
        ).withStream({
            client: rawFrameSchema,
            server: discriminatedUnion('type', [
                object({ type: literal('ready') }),
                object({ type: literal('frame'), frame: unknown() }),
            ]),
        }),
    },
);
