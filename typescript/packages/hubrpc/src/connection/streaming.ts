import { enum as zEnum, number, object, optional, string, union, unknown } from "zod/mini";
import type { output as zInfer } from "zod/v4/core";
import { defineInterface } from "./interfaceDefinition";
import { notificationType } from "../schema/memberTypes";

/**
 * Direction a {@link STREAM_METHOD} message travels, relative to the
 * request it is correlated with. Made explicit on the wire so that a
 * middlebox (the hub) can *author* a stream message — e.g. inject a
 * cancel when a caller disconnects — without an inbound message whose
 * arrival link it could infer the direction from.
 */
export const StreamDir = {
    /** callee → caller: progress, partial results. Routes like a response. */
    toCaller: "toCaller",
    /** caller → callee: input, cancellation, keepalive ping. */
    toCallee: "toCallee",
} as const;
export type StreamDir = (typeof StreamDir)[keyof typeof StreamDir];

/**
 * Reserved control verbs. A control message carries no app `payload`; it
 * is interpreted by the runtime / hub itself, independently of the
 * originating method's stream schemas, so *any* request is cancellable
 * and keep-alive-able even when it declares no app stream.
 */
export const StreamControlType = {
    /**
     * Ask the callee to abort the in-flight request. Always {@link
     * StreamDir.toCallee}. The callee surfaces this as an `AbortSignal`
     * and is expected to settle the request (typically with a
     * `cancelled` error response).
     */
    cancel: "cancel",
    /**
     * Keepalive / liveness probe. Resets the hub's per-request idle timer
     * so a long-running call is not reaped, and lets either side actively
     * probe the peer. Carries a `nonce` the peer echoes in its {@link
     * StreamControlType.pong}. May travel in either direction. Emitted
     * automatically (without awaiting a pong) by the channel for streaming
     * calls; see {@link STREAM_METHOD}.
     */
    ping: "ping",
    /**
     * Reply to a {@link StreamControlType.ping}, echoing the ping's
     * `nonce` so the prober can correlate it. Travels opposite the ping.
     * Carries no app effect — purely a liveness acknowledgement.
     */
    pong: "pong",
} as const;
export type StreamControlType = (typeof StreamControlType)[keyof typeof StreamControlType];

/**
 * Well-known `control.reason` strings. The set is **open** — any string
 * is valid on the wire; these are the reasons hubrpc itself emits.
 */
export const StreamControlReason = {
    /**
     * The caller's transport dropped while the request was in flight; the
     * hub cancels the callee's now-orphaned work.
     */
    clientDisconnected: "clientDisconnected",
    /**
     * The request exceeded the hub's idle timeout with no stream activity
     * (no ping, no stream message). See {@link STREAM_METHOD} docs.
     */
    idleTimeout: "idleTimeout",
} as const;
export type StreamControlReason = (typeof StreamControlReason)[keyof typeof StreamControlReason];

/**
 * Streaming sub-protocol. Long-running requests can emit additional
 * notifications correlated with the original call in either direction
 * (callee → caller progress, caller → callee input / cancellation /
 * keepalive).
 *
 * Wire form: a JSON-RPC notification whose method is
 * `${streamInterface.info.id}::send` and whose params match
 * `streamInterface.members.send.paramsSchema`. The hub routes purely on
 * `requestId` (following the originating request's established path, like
 * a response); the originating request's capability authorization covers
 * its full stream lifetime, so stream notifications carry no method /
 * interface namespace of their own. App `payload` contents are typed per
 * request via the originating method's
 * `RequestType.clientStreamSchema` / `serverStreamSchema`; reserved
 * `control` messages are schema-independent.
 *
 * Idle timeout: a request that never streams (no `control` ping, no
 * stream message) is subject to the hub's per-request idle timeout
 * (default 30 minutes) — at which point it is cancelled and its caller
 * gets a `requestTimeout` error. This bounds the hub's pending-request
 * table, which is also what protects it from a slow-loris / DDoS that
 * opens requests and never completes them. Streaming-enabled calls keep
 * themselves alive by emitting a periodic {@link StreamControlType.ping}.
 *
 * The interface is declarative: nobody calls
 * `HubRpcConnection.register(streamInterface, ...)`. The channel and the
 * hub intercept `$stream::send` directly. The definition exists so
 * reflection / consent UIs can describe the wire shape and so all wire
 * constants derive from one source.
 */
export const streamInterface = defineInterface(
    {
        id: "$stream",
        description:
            "Reserved sub-protocol for in-flight stream messages "
            + "correlated to a request by `requestId`.",
    },
    {
        send: notificationType(
            object({
                /**
                 * Id of the in-flight request the message belongs to.
                 * The hub rewrites this across the forwarding boundary
                 * in the same way it rewrites response ids.
                 */
                requestId: union([number(), string()]),
                /**
                 * Which way this message travels relative to the request.
                 * Explicit so the hub can author messages (e.g. cancel on
                 * disconnect) without inferring direction from arrival.
                 */
                dir: zEnum(["toCaller", "toCallee"]),
                /**
                 * Reserved control verb (cancel / ping / pong). Mutually
                 * exclusive with `payload` in practice: a control message
                 * is interpreted by the runtime, not the application.
                 */
                control: optional(
                    object({
                        type: zEnum(["cancel", "ping", "pong"]),
                        /** Open-set human/diagnostic reason; see {@link StreamControlReason}. */
                        reason: optional(string()),
                        /**
                         * Correlation token. A `ping` carries a fresh nonce;
                         * the matching `pong` echoes it back so the prober
                         * can resolve the right outstanding probe.
                         */
                        nonce: optional(string()),
                    })
                ),
                /** Opaque app payload — typed per call by the request's stream schema. */
                payload: optional(unknown()),
            }),
            {
                description:
                    "Emit a stream message tied to the request `requestId`.",
            },
        ),
    },
);

/**
 * Full wire method name for stream notifications. Pulled from the
 * interface object so we have a single source of truth.
 */
export const STREAM_METHOD = `${streamInterface.info.id}::send` as const;

/** Wire-level shape carried on `params` of {@link STREAM_METHOD}. */
export type StreamSendParams = zInfer<typeof streamInterface.members.send.paramsSchema>;

