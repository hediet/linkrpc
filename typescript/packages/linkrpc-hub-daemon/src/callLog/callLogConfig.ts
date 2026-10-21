import { z } from 'zod';
import { CallLogLevelSchema } from './callRecord';

/** Keys whose values are replaced by `[redacted]`; matched case-insensitively, ignoring `_`/`-`, as substrings. */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
    'password', 'passwd', 'secret', 'token', 'apikey', 'privatekey', 'authorization', 'cookie', 'credential',
];

const PayloadPolicySchema = z.object({
    /**
     * `none` records only sizes; `truncated` (default) cuts long strings,
     * arrays, and deep nesting per property; `full` records payloads as sent.
     * Redaction applies to `truncated` and `full`.
     */
    mode: z.enum(['none', 'truncated', 'full']).default('truncated'),
    maxStringLength: z.number().int().positive().default(256),
    maxArrayItems: z.number().int().positive().default(50),
    maxDepth: z.number().int().positive().default(8),
    /** `[]` turns redaction off. */
    redactKeys: z.array(z.string().min(1)).default([...DEFAULT_REDACT_KEYS]),
}).strict().prefault({});

export type PayloadPolicy = z.output<typeof PayloadPolicySchema>;

const RotationSchema = z.object({
    /** Start a new file once the current one reaches this size. */
    maxFileSizeMb: z.number().positive().default(10),
    /** Delete the oldest files beyond this count. */
    maxFiles: z.number().int().positive().default(20),
    /** Delete files last written longer ago than this. */
    maxAgeDays: z.number().positive().default(14),
}).strict().prefault({});

export type CallLogRotation = z.output<typeof RotationSchema>;

/**
 * Persistent log of the calls routed through the hub, written as NDJSON to
 * `<state dir>/calls`. Changes apply without restarting the hub.
 */
export const CallLogConfigSchema = z.object({
    /**
     * `off` (default) records nothing; `error`/`warn` failed calls; `info`
     * every request; `debug` also notifications; `trace` also stream frames.
     */
    level: CallLogLevelSchema.default('off'),
    payloads: PayloadPolicySchema,
    rotation: RotationSchema,
}).strict().prefault({});

export type CallLogConfig = z.output<typeof CallLogConfigSchema>;
