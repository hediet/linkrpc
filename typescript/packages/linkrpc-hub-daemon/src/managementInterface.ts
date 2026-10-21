import { defineInterface, requestType } from '@hediet/linkrpc';
import { z } from 'zod';
import { CallFilterSchema, CallLogLevelSchema, CallRecordSchema } from './callLog/callRecord';

export const ServiceStateSchema = z.enum([
    /** `enabled: false` in the config. */
    'disabled',
    /** Exited without a pending restart. */
    'stopped',
    /** Spawned, waiting for readiness (hub connection or spawn). */
    'starting',
    'running',
    /** Exited; restarting after a delay. */
    'backoff',
    'stopping',
    /** Exited abnormally and the restart policy gave up. */
    'failed',
]);
export type ServiceState = z.infer<typeof ServiceStateSchema>;

export const ServiceStatusSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    /** Namespace the service may claim on the hub. */
    serviceId: z.string(),
    enabled: z.boolean(),
    state: ServiceStateSchema,
    /** Epoch ms of the last state change. */
    since: z.number(),
    pid: z.number().int().optional(),
    /** Open hub connections of this service. */
    connections: z.number().int(),
    /** Restarts since the service was (re)configured. */
    restarts: z.number().int(),
    lastExit: z.object({
        code: z.number().int().nullable(),
        signal: z.string().nullable(),
        at: z.number(),
    }).optional(),
    error: z.string().optional(),
});
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const DaemonStatusSchema = z.object({
    pid: z.number().int(),
    version: z.string(),
    startedAt: z.number(),
    /** Application endpoint (named pipe or Unix socket). */
    endpoint: z.string(),
    configFile: z.string(),
    logFile: z.string(),
    config: z.object({
        /** Revision of the applied config file. */
        revision: z.string().optional(),
        appliedAt: z.number().optional(),
        /** Why the current file is not applied; the previous config keeps running. */
        error: z.string().optional(),
    }),
    hub: z.object({
        startedAt: z.number(),
        listeners: z.array(z.object({ type: z.string(), address: z.string() })),
        error: z.string().optional(),
    }),
    callLog: z.object({
        level: CallLogLevelSchema,
        /** Directory of the NDJSON call-log files. */
        directory: z.string(),
        /** Where the log is served as `linkrpc.logging` while the hub runs. */
        serviceId: z.string().optional(),
        error: z.string().optional(),
    }),
    services: z.array(ServiceStatusSchema),
});
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;

export const LogLineSchema = z.object({
    at: z.number(),
    stream: z.enum(['stdout', 'stderr', 'daemon']),
    text: z.string(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

export const ConfigDocumentSchema = z.object({
    path: z.string(),
    text: z.string(),
    /** Opaque content revision; pass it back to `setConfig`. */
    revision: z.string(),
});
export type ConfigDocument = z.infer<typeof ConfigDocumentSchema>;

/** Management API of the local hub daemon, served on its management endpoint. */
export const hubDaemonManagementInterface = defineInterface(
    { id: 'linkrpc.hubDaemon', description: 'Manage the local LinkRPC hub daemon.' },
    {
        getStatus: requestType(z.object({}), DaemonStatusSchema),
        /** Streams the status on every change until cancelled. */
        watchStatus: requestType(z.object({}), z.object({})).withStream({ server: DaemonStatusSchema }),
        /** Re-read the config file and apply what changed. */
        reloadConfig: requestType(z.object({}), DaemonStatusSchema),
        getConfig: requestType(z.object({}), ConfigDocumentSchema),
        /** Validate, write, and apply; rejects when the file changed since `expectedRevision`. */
        setConfig: requestType(
            z.object({ text: z.string(), expectedRevision: z.string() }),
            z.object({ revision: z.string() }),
        ),
        /** Persistently enable or disable a service in the config file. */
        setServiceEnabled: requestType(z.object({ name: z.string(), enabled: z.boolean() }), z.object({})),
        restartService: requestType(z.object({ name: z.string() }), z.object({})),
        getServiceLogs: requestType(
            z.object({ name: z.string(), limit: z.number().int().positive().optional() }),
            z.object({ lines: z.array(LogLineSchema) }),
        ),
        /** Persist `callLog.level` in the config file and apply it (`off` stops recording). */
        setCallLogLevel: requestType(z.object({ level: CallLogLevelSchema }), z.object({})),
        /** Read recorded calls from the call-log files, newest first. */
        queryCalls: requestType(
            z.object({ filter: CallFilterSchema.optional(), limit: z.number().int().positive().max(5_000).optional() }),
            z.object({ calls: z.array(CallRecordSchema), truncated: z.boolean() }),
        ),
        /** Streams matching records as they are written, until cancelled. */
        watchCalls: requestType(z.object({ filter: CallFilterSchema.optional() }), z.object({}))
            .withStream({ server: CallRecordSchema }),
        /** Stop all services and exit. Intentional: autostart managers do not restart it. */
        shutdown: requestType(z.object({}), z.object({})),
    },
);
