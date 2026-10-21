/**
 * Interfaces of a compute node: one machine's status, processes, files,
 * loopback HTTP, and loopback TCP. Browser-safe; the Node.js implementation
 * is `@hediet/linkrpc-infra/compute-node/node`.
 *
 * SECURITY: `command`, `filesystem`, `http`, and `tcpForward` act with the
 * full rights of the OS user running the node. Grant them only to trusted
 * principals.
 */
import { defineInterface, requestType } from '@hediet/linkrpc';
import { z } from 'zod';

const empty = z.object({});
const port = z.number().int().min(1).max(65_535);
const loopbackHost = z.enum(['localhost', '127.0.0.1', '::1']);
const base64 = z.string();
const headers = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
const timeoutMs = z.number().int().min(1).max(10 * 60 * 1_000);

const fileKind = z.enum(['file', 'directory', 'symlink', 'blockDevice', 'characterDevice', 'fifo', 'socket', 'other']);
const fileStat = z.object({
    path: z.string(),
    kind: fileKind,
    sizeBytes: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    modifiedAtMs: z.number(),
    createdAtMs: z.number(),
});

const statusSchema = z.object({
    timestamp: z.string(),
    hostname: z.string(),
    username: z.string(),
    platform: z.string(),
    architecture: z.string(),
    osRelease: z.string(),
    uptimeSeconds: z.number().nonnegative(),
    cpu: z.object({
        logicalCores: z.number().int().positive(),
        model: z.string().optional(),
        /** Always zero on Windows. */
        loadAverage: z.tuple([z.number(), z.number(), z.number()]),
        processUserMicros: z.number().nonnegative(),
        processSystemMicros: z.number().nonnegative(),
        cgroupQuotaCores: z.number().positive().optional(),
        cgroupUsageMicros: z.number().nonnegative().optional(),
    }),
    memory: z.object({
        totalBytes: z.number().int().nonnegative(),
        freeBytes: z.number().int().nonnegative(),
        processRssBytes: z.number().int().nonnegative(),
        processHeapUsedBytes: z.number().int().nonnegative(),
        cgroupCurrentBytes: z.number().int().nonnegative().optional(),
        cgroupLimitBytes: z.number().int().positive().optional(),
    }),
    storage: z.array(z.object({
        path: z.string(),
        totalBytes: z.number().int().nonnegative(),
        freeBytes: z.number().int().nonnegative(),
        availableBytes: z.number().int().nonnegative(),
    })),
    network: z.array(z.object({
        name: z.string(),
        address: z.string(),
        family: z.enum(['IPv4', 'IPv6']),
        internal: z.boolean(),
        mac: z.string(),
        cidr: z.string().nullable(),
    })),
});

const commandParamsSchema = z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    stdin: z.string().optional(),
    timeoutMs: timeoutMs.optional(),
});
const commandResultSchema = z.object({
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
    durationMs: z.number().nonnegative(),
});
const commandOutputSchema = z.object({ stream: z.enum(['stdout', 'stderr']), text: z.string() });

const httpRequestSchema = z.object({
    port,
    host: loopbackHost.optional(),
    method: z.string().min(1).optional(),
    path: z.string().regex(/^\/(?!\/)/, 'path must be an origin-relative path beginning with /'),
    headers: headers.optional(),
    bodyBase64: base64.optional(),
    timeoutMs: timeoutMs.optional(),
    maxResponseBytes: z.number().int().min(1).max(16 * 1_024 * 1_024).optional(),
});

export const computeNodeStatusInterface = defineInterface(
    {
        id: 'linkrpc.computeNode.status',
        description: 'Reports operating-system, CPU, memory, storage, process, and network status for one compute node.',
    },
    { getStatus: requestType(empty, statusSchema) },
);

export const computeNodeCommandInterface = defineInterface(
    {
        id: 'linkrpc.computeNode.command',
        description: [
            'Runs a non-interactive process to completion and returns its buffered output.',
            '`command` is an executable run without a shell; to use shell syntax, run the shell itself',
            '(e.g. `pwsh -Command ...` or `sh -c ...`). Output is also streamed while the process runs.',
        ].join(' '),
    },
    {
        run: requestType(commandParamsSchema, commandResultSchema).withStream({ server: commandOutputSchema }),
    },
);

export const computeNodeFileSystemInterface = defineInterface(
    {
        id: 'linkrpc.computeNode.filesystem',
        description: 'Minimal filesystem access for one compute node. Paths are native paths resolved by the node process.',
    },
    {
        stat: requestType(z.object({ path: z.string().min(1) }), fileStat),
        readDirectory: requestType(
            z.object({ path: z.string().min(1), limit: z.number().int().min(1).max(10_000).optional() }),
            z.object({
                path: z.string(),
                entries: z.array(z.object({ name: z.string(), kind: fileKind })),
                truncated: z.boolean(),
            }),
        ),
        readFile: requestType(
            z.object({
                path: z.string().min(1),
                offset: z.number().int().nonnegative().optional(),
                length: z.number().int().min(1).max(4 * 1_024 * 1_024).optional(),
            }),
            z.object({
                path: z.string(),
                sizeBytes: z.number().int().nonnegative(),
                offset: z.number().int().nonnegative(),
                bytesRead: z.number().int().nonnegative(),
                contentBase64: base64,
                eof: z.boolean(),
            }),
        ),
        writeFile: requestType(
            z.object({ path: z.string().min(1), contentBase64: base64, createNew: z.boolean().optional() }),
            z.object({ path: z.string(), bytesWritten: z.number().int().nonnegative() }),
        ),
    },
);

export const computeNodeHttpInterface = defineInterface(
    {
        id: 'linkrpc.computeNode.http',
        description: 'HTTP client for a loopback port of the compute node. Bodies are buffered and size-limited.',
    },
    {
        request: requestType(
            httpRequestSchema,
            z.object({ statusCode: z.number().int().min(100).max(999), headers, bodyBase64: base64 }),
        ),
    },
);

const clientTcpFrame = z.discriminatedUnion('type', [
    z.object({ type: z.literal('data'), dataBase64: base64 }),
    z.object({ type: z.literal('end') }),
]);
const serverTcpFrame = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready'), targetAddress: z.string() }),
    z.object({ type: z.literal('data'), dataBase64: base64 }),
    z.object({ type: z.literal('end') }),
]);
const tcpConnectionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const tcpCreditBytes = z.number().int().min(1).max(256 * 1_024);
const clientMultiplexedTcpFrame = z.discriminatedUnion('type', [
    z.object({ type: z.literal('open'), connectionId: tcpConnectionId }),
    z.object({ type: z.literal('data'), connectionId: tcpConnectionId, dataBase64: base64 }),
    z.object({ type: z.literal('end'), connectionId: tcpConnectionId }),
    z.object({ type: z.literal('close'), connectionId: tcpConnectionId }),
    z.object({ type: z.literal('credit'), connectionId: tcpConnectionId, bytes: tcpCreditBytes }),
]);
const serverMultiplexedTcpFrame = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready'), maxConnections: z.number().int().min(1).max(10), receiveWindowBytes: tcpCreditBytes }),
    z.object({
        type: z.literal('opened'),
        connectionId: tcpConnectionId,
        targetAddress: z.string(),
        receiveWindowBytes: tcpCreditBytes,
    }),
    z.object({ type: z.literal('data'), connectionId: tcpConnectionId, dataBase64: base64 }),
    z.object({ type: z.literal('end'), connectionId: tcpConnectionId }),
    z.object({
        type: z.literal('closed'),
        connectionId: tcpConnectionId,
        reason: z.enum(['remoteClosed', 'clientClosed', 'idleTimeout', 'limit', 'protocolError', 'error']),
        message: z.string().optional(),
    }),
    z.object({ type: z.literal('credit'), connectionId: tcpConnectionId, bytes: tcpCreditBytes }),
]);

export const computeNodeTcpForwardInterface = defineInterface(
    {
        id: 'linkrpc.computeNode.tcpForward',
        description: [
            'Opens raw duplex byte streams to a loopback TCP port of the compute node.',
            'HTTP, streaming responses, SSE, and WebSocket upgrades remain opaque and are preserved.',
            '`multiplex` carries up to 10 logical connections with per-connection credit-based flow control.',
        ].join(' '),
    },
    {
        connect: requestType(
            z.object({ port, host: loopbackHost.optional() }),
            z.object({
                reason: z.enum(['remoteClosed', 'clientEnded', 'cancelled', 'error']),
                message: z.string().optional(),
            }),
        ).withStream({ client: clientTcpFrame, server: serverTcpFrame }),
        multiplex: requestType(
            z.object({ port, host: loopbackHost.optional() }),
            z.object({ reason: z.enum(['cancelled', 'error']), message: z.string().optional() }),
        ).withStream({ client: clientMultiplexedTcpFrame, server: serverMultiplexedTcpFrame }),
    },
);

export const computeNodeInterfaces = [
    computeNodeStatusInterface,
    computeNodeCommandInterface,
    computeNodeFileSystemInterface,
    computeNodeHttpInterface,
    computeNodeTcpForwardInterface,
] as const;

export type ComputeNodeStatus = z.infer<typeof statusSchema>;
export type ComputeNodeCommandParams = z.infer<typeof commandParamsSchema>;
export type ComputeNodeCommandResult = z.infer<typeof commandResultSchema>;
export type ComputeNodeCommandOutput = z.infer<typeof commandOutputSchema>;
export type ComputeNodeFileStat = z.infer<typeof fileStat>;
export type ComputeNodeFileKind = z.infer<typeof fileKind>;
export type ComputeNodeHttpRequest = z.infer<typeof httpRequestSchema>;
export type ComputeNodeTcpClientFrame = z.infer<typeof clientTcpFrame>;
export type ComputeNodeTcpServerFrame = z.infer<typeof serverTcpFrame>;
export type ComputeNodeMultiplexedTcpClientFrame = z.infer<typeof clientMultiplexedTcpFrame>;
export type ComputeNodeMultiplexedTcpServerFrame = z.infer<typeof serverMultiplexedTcpFrame>;
