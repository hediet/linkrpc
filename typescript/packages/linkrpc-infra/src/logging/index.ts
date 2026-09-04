import {
    array,
    discriminatedUnion,
    enum as zEnum,
    lazy,
    literal,
    number,
    object,
    optional,
    record,
    string,
    unknown,
} from 'zod/mini';
import type { output as zInfer } from 'zod/v4/core';
import { defineInterface, requestType, type Schema } from '@hediet/linkrpc';
import { jsonDocumentEditSchema } from '../json-document/index';

export const logLevelSchema = zEnum(['trace', 'debug', 'info', 'warn', 'error', 'off']);
export type LogLevel = zInfer<typeof logLevelSchema>;
export type EmittedLogLevel = Exclude<LogLevel, 'off'>;

export interface LogError {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
}

export interface LogEntry {
    readonly timestamp: string;
    readonly level: EmittedLogLevel;
    readonly message: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
    readonly entries?: readonly LogEntry[];
    readonly durationMs?: number;
    readonly error?: LogError;
}

export interface LogDocument {
    readonly schemaVersion: 1;
    readonly service: string;
    readonly startedAt: string;
    readonly state: Readonly<Record<string, unknown>>;
    readonly entries: readonly LogEntry[];
}

const logErrorSchema = object({
    name: optional(string()),
    message: string(),
    stack: optional(string()),
});

export const logEntrySchema: Schema<LogEntry> = lazy(() =>
    object({
        timestamp: string(),
        level: zEnum(['trace', 'debug', 'info', 'warn', 'error']),
        message: string(),
        attributes: optional(record(string(), unknown())),
        entries: optional(array(logEntrySchema)),
        durationMs: optional(number()),
        error: optional(logErrorSchema),
    }),
);

export const logDocumentSchema: Schema<LogDocument> = object({
    schemaVersion: literal(1),
    service: string(),
    startedAt: string(),
    state: record(string(), unknown()),
    entries: array(logEntrySchema),
});

export const logStreamEventSchema = discriminatedUnion('type', [
    object({
        type: literal('snapshot'),
        revision: number(),
        document: logDocumentSchema,
    }),
    object({
        type: literal('patch'),
        revision: number(),
        edits: array(jsonDocumentEditSchema),
    }),
]);

export type LogStreamEvent = zInfer<typeof logStreamEventSchema>;

/**
 * Standard structured-log protocol. Implementations choose their own storage,
 * retention, and sinks; this definition specifies only the LinkRPC wire API.
 */
export const loggingInterface = defineInterface(
    {
        id: 'linkrpc.logging',
        description:
            'Structured service logs exposed as a revisioned JSON document stream. '
            + 'watchLog emits a snapshot first and then patches in revision order. '
            + 'Clients that observe a revision gap must resynchronize with getLogSnapshot.',
    },
    {
        getLogLevel: requestType(object({}), object({ level: logLevelSchema })),
        getLogSnapshot: requestType(
            object({}),
            object({ revision: number(), document: logDocumentSchema }),
        ),
        setLogLevel: requestType(object({ level: logLevelSchema }), object({})),
        watchLog: requestType(object({}), object({})).withStream({
            server: logStreamEventSchema,
        }),
    },
);
