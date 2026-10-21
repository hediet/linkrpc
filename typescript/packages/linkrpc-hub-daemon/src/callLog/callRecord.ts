/**
 * The persisted call-log record and its filter. Schema-only (no Node.js APIs)
 * so management clients and UIs can share it.
 */
import { logLevelSchema } from '@hediet/linkrpc-infra/logging';
import { z } from 'zod';
import { CallQuery } from './callQuery';

/** `linkrpc.logging` levels. A threshold records calls at or above it. */
export const CallLogLevelSchema = z.enum(logLevelSchema.options);
export type CallLogLevel = z.infer<typeof CallLogLevelSchema>;

/**
 * The level of a recorded call: failures are `error`, requests `info`,
 * notifications `debug`, and stream frames reported apart from their request
 * `trace`. `warn` records the same calls as `error`.
 */
export const CallRecordLevelSchema = z.enum(['error', 'info', 'debug', 'trace']);
export type CallRecordLevel = z.infer<typeof CallRecordLevelSchema>;

/** One side of a call at the hub: the port's friendly label and its transport. */
export const CallPeerSchema = z.object({
    /** The port's claimed prefix (e.g. `hediet/devbox`) or an edge id (`e12`). */
    label: z.string(),
    /** E.g. `named-pipe \\.\pipe\linkrpc-hub-user` or `websocket 10.0.0.2:51234`. */
    transport: z.string().optional(),
});
export type CallPeer = z.infer<typeof CallPeerSchema>;

/**
 * One NDJSON line. A call still in flight is written as `pending` and written
 * again under the same `id` when it settles; readers keep the newest record per id.
 */
export const CallRecordSchema = z.object({
    v: z.literal(1),
    id: z.string(),
    /** Start, epoch ms. */
    at: z.number(),
    level: CallRecordLevelSchema,
    kind: z.enum(['request', 'notification', 'stream']),
    status: z.enum(['pending', 'completed', 'failed', 'unroutable', 'dropped']),
    durationMs: z.number(),
    /** The wire method, e.g. `hediet/pc2/compute::linkrpc.compute::exec`. */
    method: z.string(),
    serviceId: z.string().optional(),
    /** Where the call entered the hub. */
    from: CallPeerSchema,
    /** Where the hub forwarded it; absent when the hub consumed or dropped it. */
    to: CallPeerSchema.optional(),
    /** `$hubrpc.principal` of a signed call; verified when the hub checks forwarded calls. */
    principal: z.string().optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
    /** UTF-8 size of the application params (without `$hubrpc*` meta). */
    paramsBytes: z.number().int().optional(),
    resultBytes: z.number().int().optional(),
    /** Redacted and truncated per the `callLog.payloads` policy; absent for `mode: "none"`. */
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    /** Stream frames folded into this record (frames shortly after the request starts). */
    streamFrames: z.number().int().optional(),
});
export type CallRecord = z.infer<typeof CallRecordSchema>;

export const CallFilterSchema = z.object({
    /** A {@link CallQuery}: space-separated terms, `-term` to exclude, `method:<glob>` for methods. */
    text: z.string().optional(),
    /** Only records at or above this level, e.g. `error` for failures. */
    minLevel: CallRecordLevelSchema.optional(),
    /** Start time bounds, epoch ms (inclusive). */
    since: z.number().optional(),
    until: z.number().optional(),
});
export type CallFilter = z.infer<typeof CallFilterSchema>;

const SEVERITY: Readonly<Record<CallLogLevel, number>> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, off: 5 };

/** Whether a record at `level` is recorded or shown at `threshold`. */
export function isCallLevelEnabled(level: CallRecordLevel, threshold: CallLogLevel): boolean {
    return SEVERITY[level] >= SEVERITY[threshold];
}

/** Parses `filter` once; the result tests records against it. */
export function createCallMatcher(filter: CallFilter): (record: CallRecord) => boolean {
    const query = filter.text ? CallQuery.parse(filter.text) : undefined;
    return record => {
        if (filter.minLevel !== undefined && !isCallLevelEnabled(record.level, filter.minLevel)) return false;
        if (filter.since !== undefined && record.at < filter.since) return false;
        if (filter.until !== undefined && record.at > filter.until) return false;
        return query?.matches(record) ?? true;
    };
}
