import { defineInterface, requestType } from '@hediet/linkrpc';
import {
    discriminatedUnion,
    enum as zEnum,
    literal,
    object,
    optional,
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
    | 'remoteClosed';

const rawFrameSchema = object({ frame: unknown() });

/**
 * Opens a transparent JSON-RPC transport over one duplex LinkRPC request.
 * Frames are intentionally opaque; the endpoint owns JSON-RPC semantics.
 */
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
