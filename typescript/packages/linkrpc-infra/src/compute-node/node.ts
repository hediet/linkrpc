/**
 * Node.js implementation of the compute-node interfaces. Acts with the full
 * rights of the OS user running the process.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, open, readdir, readFile as readFileContents, statfs, writeFile as writeFileContents } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import * as os from 'node:os';
import path from 'node:path';
import type {
    InterfaceDeclarations,
    InterfaceDefinition,
    InterfaceHandlers,
    InterfaceRegistration,
    MemberMap,
    StreamApi,
} from '@hediet/linkrpc';
import {
    type ComputeNodeCommandOutput,
    type ComputeNodeCommandParams,
    type ComputeNodeCommandResult,
    type ComputeNodeFileKind,
    type ComputeNodeFileStat,
    type ComputeNodeHttpRequest,
    type ComputeNodeKeepAwakeEvent,
    type ComputeNodeKeepAwakeParams,
    type ComputeNodeKeepAwakeResult,
    type ComputeNodeMultiplexedTcpClientFrame,
    type ComputeNodeMultiplexedTcpServerFrame,
    type ComputeNodeStatus,
    computeNodeCommandInterface,
    computeNodeFileSystemInterface,
    computeNodeHttpInterface,
    computeNodePortsInterface,
    computeNodePowerInterface,
    computeNodeSessionInterface,
    computeNodeStatusInterface,
    computeNodeTcpForwardInterface,
    type ComputeNodeTcpClientFrame,
    type ComputeNodeTcpServerFrame,
} from './index';
import { holdSleepInhibitor, type SleepInhibitorCommand, sleepInhibitorCommand, type SleepInhibitorOptions } from './keepAwake';
import { readListeningPorts } from './listeningPorts';
import { runSystemActionCommand, type SystemAction, type SystemActionCommand, systemActionCommand } from './systemActions';

export { type SleepInhibitorCommand, sleepInhibitorCommand, type SleepInhibitorOptions } from './keepAwake';
export { type SystemAction, type SystemActionCommand, systemActionCommand } from './systemActions';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_TERMINATION_GRACE_MS = 2_000;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_FILE_READ_BYTES = 1 * 1_024 * 1_024;
const MAX_FILE_WRITE_BYTES = 4 * 1_024 * 1_024;
const MAX_HTTP_REQUEST_BYTES = 16 * 1_024 * 1_024;
const DEFAULT_HTTP_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_MULTIPLEXED_TCP_CONNECTIONS = 10;
const MULTIPLEXED_TCP_WINDOW_BYTES = 256 * 1_024;
const MAX_MULTIPLEXED_TCP_FRAME_BYTES = 64 * 1_024;

type LoopbackHost = 'localhost' | '127.0.0.1' | '::1';

export interface ComputeNodeOptions {
    /** Chooses the helper that keeps the machine awake. Defaults to the current platform's {@link sleepInhibitorCommand}. */
    readonly sleepInhibitor?: (options: SleepInhibitorOptions) => SleepInhibitorCommand;
    /** Chooses the command that performs a lock or power action. Defaults to the current platform's {@link systemActionCommand}. */
    readonly systemAction?: (action: SystemAction) => SystemActionCommand;
}

export class ComputeNode {
    constructor(private readonly _options: ComputeNodeOptions = {}) { }

    async getStatus(): Promise<ComputeNodeStatus> {
        const cpuInfo = os.cpus();
        const usage = process.cpuUsage();
        const memory = process.memoryUsage();
        const [cgroupCpu, cgroupMemory, storage] = await Promise.all([readCgroupCpu(), readCgroupMemory(), readStorage()]);
        const load = os.loadavg();
        return {
            timestamp: new Date().toISOString(),
            hostname: os.hostname(),
            username: os.userInfo().username,
            platform: os.platform(),
            architecture: os.arch(),
            osRelease: os.release(),
            uptimeSeconds: os.uptime(),
            cpu: {
                logicalCores: Math.max(cpuInfo.length, 1),
                ...(cpuInfo[0]?.model ? { model: cpuInfo[0].model } : {}),
                loadAverage: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
                processUserMicros: usage.user,
                processSystemMicros: usage.system,
                ...cgroupCpu,
            },
            memory: {
                totalBytes: os.totalmem(),
                freeBytes: os.freemem(),
                processRssBytes: memory.rss,
                processHeapUsedBytes: memory.heapUsed,
                ...cgroupMemory,
            },
            storage,
            network: Object.entries(os.networkInterfaces())
                .flatMap(([name, addresses]) => (addresses ?? []).map(address => ({
                    name,
                    address: address.address,
                    family: address.family,
                    internal: address.internal,
                    mac: address.mac,
                    cidr: address.cidr,
                })))
                .sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address)),
        };
    }

    /**
     * Runs `params.command` without a shell. `onOutput` receives output as it
     * arrives; the result carries the complete buffered output.
     */
    runCommand(
        params: ComputeNodeCommandParams,
        signal?: AbortSignal,
        onOutput?: (output: ComputeNodeCommandOutput) => void,
    ): Promise<ComputeNodeCommandResult> {
        return new Promise((resolve, reject) => {
            const startedAt = performance.now();
            const child = spawn(params.command, params.args ?? [], {
                cwd: params.cwd,
                env: { ...process.env, ...params.env },
                shell: false,
                windowsHide: true,
                stdio: 'pipe',
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let timedOut = false;
            let settled = false;
            let outputError: Error | undefined;
            let cancellationError: Error | undefined;
            let forceKillTimeout: NodeJS.Timeout | undefined;

            const finish = (error: Error | undefined, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                clearTimeout(forceKillTimeout);
                signal?.removeEventListener('abort', abort);
                const failure = error ?? outputError ?? cancellationError;
                if (failure) {
                    reject(failure);
                    return;
                }
                resolve({
                    exitCode,
                    signal: exitSignal,
                    stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8'),
                    stderr: Buffer.concat(stderr, stderrBytes).toString('utf8'),
                    timedOut,
                    durationMs: performance.now() - startedAt,
                });
            };
            const terminate = (): void => {
                child.kill();
                if (forceKillTimeout !== undefined) return;
                forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), COMMAND_TERMINATION_GRACE_MS);
                forceKillTimeout.unref();
            };
            const append = (target: Buffer[], chunk: Buffer, currentBytes: number, stream: 'stdout' | 'stderr'): number => {
                const nextBytes = currentBytes + chunk.byteLength;
                if (nextBytes > MAX_COMMAND_OUTPUT_BYTES) {
                    outputError = new Error(`${stream} exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`);
                    terminate();
                    return currentBytes;
                }
                target.push(chunk);
                onOutput?.({ stream, text: chunk.toString('utf8') });
                return nextBytes;
            };
            const abort = (): void => {
                cancellationError = signal?.reason instanceof Error ? signal.reason : new Error('Command cancelled');
                terminate();
            };
            const timeout = setTimeout(() => {
                timedOut = true;
                terminate();
            }, params.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);

            child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = append(stdout, chunk, stdoutBytes, 'stdout'); });
            child.stderr.on('data', (chunk: Buffer) => { stderrBytes = append(stderr, chunk, stderrBytes, 'stderr'); });
            child.once('error', error => finish(error));
            child.once('close', (code, exitSignal) => finish(undefined, code, exitSignal));
            child.stdin.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code !== 'EPIPE') finish(error);
            });

            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener('abort', abort, { once: true });
            child.stdin.end(params.stdin);
        });
    }

    async stat(filePath: string): Promise<ComputeNodeFileStat> {
        const resolved = path.resolve(filePath);
        const value = await lstat(resolved);
        return {
            path: resolved,
            kind: fileKind(value),
            sizeBytes: value.size,
            mode: value.mode,
            modifiedAtMs: value.mtimeMs,
            createdAtMs: value.birthtimeMs,
        };
    }

    async readDirectory(directoryPath: string, limit = 1_000): Promise<{
        path: string;
        entries: { name: string; kind: ComputeNodeFileKind; }[];
        truncated: boolean;
    }> {
        const resolved = path.resolve(directoryPath);
        const entries = await readdir(resolved, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        return {
            path: resolved,
            entries: entries.slice(0, limit).map(entry => ({ name: entry.name, kind: fileKind(entry) })),
            truncated: entries.length > limit,
        };
    }

    async readFile(filePath: string, offset = 0, length = DEFAULT_FILE_READ_BYTES): Promise<{
        path: string;
        sizeBytes: number;
        offset: number;
        bytesRead: number;
        contentBase64: string;
        eof: boolean;
    }> {
        const resolved = path.resolve(filePath);
        const handle = await open(resolved, 'r');
        try {
            const stats = await handle.stat();
            const buffer = Buffer.alloc(Math.min(length, Math.max(0, stats.size - offset)));
            const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
            return {
                path: resolved,
                sizeBytes: stats.size,
                offset,
                bytesRead,
                contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
                eof: offset + bytesRead >= stats.size,
            };
        } finally {
            await handle.close();
        }
    }

    async writeFile(filePath: string, contentBase64: string, createNew = false): Promise<{ path: string; bytesWritten: number; }> {
        const resolved = path.resolve(filePath);
        const content = decodeBase64(contentBase64);
        if (content.byteLength > MAX_FILE_WRITE_BYTES) throw new Error(`File content exceeds ${MAX_FILE_WRITE_BYTES} bytes`);
        await writeFileContents(resolved, content, { flag: createNew ? 'wx' : 'w' });
        return { path: resolved, bytesWritten: content.byteLength };
    }

    requestHttp(params: ComputeNodeHttpRequest, signal?: AbortSignal): Promise<{
        statusCode: number;
        headers: Record<string, string | string[]>;
        bodyBase64: string;
    }> {
        const body = params.bodyBase64 === undefined ? undefined : decodeBase64(params.bodyBase64);
        if (body !== undefined && body.byteLength > MAX_HTTP_REQUEST_BYTES) {
            throw new Error(`HTTP request body exceeds ${MAX_HTTP_REQUEST_BYTES} bytes`);
        }
        const maxResponseBytes = params.maxResponseBytes ?? DEFAULT_HTTP_RESPONSE_BYTES;
        const timeoutMs = params.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finishReject = (error: Error): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            };
            const request = httpRequest(
                {
                    host: params.host ?? 'localhost',
                    port: params.port,
                    method: params.method ?? (body === undefined ? 'GET' : 'POST'),
                    path: params.path,
                    headers: params.headers,
                    signal,
                },
                response => {
                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    response.on('data', (chunk: Buffer) => {
                        bytes += chunk.byteLength;
                        if (bytes > maxResponseBytes) {
                            response.destroy(new Error(`HTTP response exceeded ${maxResponseBytes} bytes`));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    response.once('error', finishReject);
                    response.once('end', () => {
                        if (settled) return;
                        if (response.statusCode === undefined) {
                            finishReject(new Error('HTTP response has no status code'));
                            return;
                        }
                        settled = true;
                        clearTimeout(timeout);
                        resolve({
                            statusCode: response.statusCode,
                            headers: normalizeHeaders(response.headers),
                            bodyBase64: Buffer.concat(chunks, bytes).toString('base64'),
                        });
                    });
                },
            );
            const timeout = setTimeout(() => request.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms`)), timeoutMs);
            request.once('error', finishReject);
            request.end(body);
        });
    }

    async forwardTcp(
        port: number,
        host: LoopbackHost,
        stream: StreamApi<ComputeNodeTcpClientFrame, ComputeNodeTcpServerFrame>,
    ): Promise<{ reason: 'remoteClosed' | 'clientEnded' | 'cancelled' | 'error'; message?: string; }> {
        const socket = createConnection({ host, port, allowHalfOpen: true });
        socket.pause();
        const connected = waitForSocketConnect(socket, stream.signal);
        let clientEnded = false;
        let input = Promise.resolve();
        let inputError: Error | undefined;
        stream.onMessage(frame => {
            input = input
                .then(async () => {
                    if (inputError) return;
                    if (clientEnded) throw new Error('Received TCP frame after client end');
                    await connected;
                    if (frame.type === 'end') {
                        clientEnded = true;
                        socket.end();
                        return;
                    }
                    if (!socket.write(decodeBase64(frame.dataBase64))) await once(socket, 'drain');
                })
                .catch((error: unknown) => {
                    inputError = error instanceof Error ? error : new Error(String(error));
                    socket.destroy(inputError);
                });
        });
        try {
            await connected;
        } catch (error) {
            socket.destroy();
            if (stream.signal.aborted) return { reason: 'cancelled' };
            throw error;
        }

        const abort = (): void => { socket.destroy(); };
        stream.signal.addEventListener('abort', abort, { once: true });
        try {
            await stream.send({ type: 'ready', targetAddress: `${socket.remoteAddress ?? host}:${socket.remotePort ?? port}` });
            socket.resume();
            for await (const chunk of socket) {
                await stream.send({ type: 'data', dataBase64: Buffer.from(chunk).toString('base64') });
            }
            await input;
            if (!stream.signal.aborted) await stream.send({ type: 'end' });
            if (inputError) return { reason: 'error', message: inputError.message };
            return { reason: stream.signal.aborted ? 'cancelled' : clientEnded ? 'clientEnded' : 'remoteClosed' };
        } catch (error) {
            if (stream.signal.aborted) return { reason: 'cancelled' };
            return { reason: 'error', message: error instanceof Error ? error.message : String(error) };
        } finally {
            stream.signal.removeEventListener('abort', abort);
            socket.destroy();
        }
    }

    forwardTcpMultiplexed(
        port: number,
        host: LoopbackHost,
        stream: StreamApi<ComputeNodeMultiplexedTcpClientFrame, ComputeNodeMultiplexedTcpServerFrame>,
    ): Promise<{ reason: 'cancelled' | 'error'; message?: string; }> {
        return new MultiplexedTcpSession(host, port, stream).run();
    }

    /**
     * Keeps the machine awake until `signal` aborts or `params.maxDurationMs`
     * elapses. Every call holds its own lease; `onActive` reports when sleep
     * prevention is in effect.
     */
    async keepAwake(
        params: ComputeNodeKeepAwakeParams,
        signal: AbortSignal,
        onActive: (event: ComputeNodeKeepAwakeEvent) => void,
    ): Promise<ComputeNodeKeepAwakeResult> {
        const inhibitor = (this._options.sleepInhibitor ?? sleepInhibitorCommand)({
            displayOn: params.displayOn ?? false,
            reason: params.reason ?? 'Kept awake by a LinkRPC caller',
        });
        return holdSleepInhibitor(inhibitor, params.maxDurationMs, signal, onActive);
    }

    /** Locks the session or sleeps, restarts, or shuts down the machine with the platform's command. */
    async performSystemAction(action: SystemAction): Promise<{ mechanism: string; }> {
        const command = (this._options.systemAction ?? systemActionCommand)(action);
        await runSystemActionCommand(command);
        return { mechanism: command.mechanism };
    }
}

/** Anything that registers interface handlers, e.g. a connection or `ParticipantServices`. */
export interface InterfaceRegistrar {
    register<TDef extends InterfaceDefinition<MemberMap, InterfaceDeclarations>>(
        iface: TDef,
        handlers: InterfaceHandlers<TDef>,
    ): InterfaceRegistration;
}

/** Register all compute-node interfaces backed by `node`. */
export function registerComputeNode(registrar: InterfaceRegistrar, node: ComputeNode = new ComputeNode()): { dispose(): void; } {
    const registrations = [
        registrar.register(computeNodeStatusInterface, { getStatus: () => node.getStatus() }),
        registrar.register(computeNodeCommandInterface, {
            run: (params, _ctx, stream) => node.runCommand(params, stream.signal, output => {
                stream.send(output).catch(() => { /* the caller went away */ });
            }),
        }),
        registrar.register(computeNodeFileSystemInterface, {
            stat: ({ path: filePath }) => node.stat(filePath),
            readDirectory: params => node.readDirectory(params.path, params.limit),
            readFile: params => node.readFile(params.path, params.offset, params.length),
            writeFile: params => node.writeFile(params.path, params.contentBase64, params.createNew),
        }),
        registrar.register(computeNodeHttpInterface, { request: (params, _ctx, stream) => node.requestHttp(params, stream.signal) }),
        registrar.register(computeNodeTcpForwardInterface, {
            connect: (params, _ctx, stream) => node.forwardTcp(params.port, params.host ?? 'localhost', stream),
            multiplex: (params, _ctx, stream) => node.forwardTcpMultiplexed(params.port, params.host ?? 'localhost', stream),
        }),
        registrar.register(computeNodePortsInterface, {
            listListening: async () => ({ ports: await readListeningPorts() }),
        }),
        registrar.register(computeNodePowerInterface, {
            keepAwake: (params, _ctx, stream) => node.keepAwake(params, stream.signal, event => {
                stream.send(event).catch(() => { /* the caller went away */ });
            }),
            sleep: () => node.performSystemAction('sleep'),
            restart: () => node.performSystemAction('restart'),
            shutdown: () => node.performSystemAction('shutdown'),
        }),
        registrar.register(computeNodeSessionInterface, { lock: () => node.performSystemAction('lock') }),
    ];
    return { dispose: () => { for (const registration of registrations) registration.dispose(); } };
}

class MultiplexedTcpSession {
    private readonly _connections = new Map<string, MultiplexedTcpConnection>();

    constructor(
        private readonly _host: LoopbackHost,
        private readonly _port: number,
        private readonly _stream: StreamApi<ComputeNodeMultiplexedTcpClientFrame, ComputeNodeMultiplexedTcpServerFrame>,
    ) { }

    async run(): Promise<{ reason: 'cancelled' | 'error'; message?: string; }> {
        this._stream.onMessage(frame => this._handleFrame(frame));
        this._send({ type: 'ready', maxConnections: MAX_MULTIPLEXED_TCP_CONNECTIONS, receiveWindowBytes: MULTIPLEXED_TCP_WINDOW_BYTES });
        if (!this._stream.signal.aborted) {
            await new Promise<void>(resolve => this._stream.signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        for (const connection of this._connections.values()) connection.dispose();
        this._connections.clear();
        return { reason: 'cancelled' };
    }

    private _handleFrame(frame: ComputeNodeMultiplexedTcpClientFrame): void {
        if (this._stream.signal.aborted) return;
        if (frame.type === 'open') {
            const existing = this._connections.get(frame.connectionId);
            if (existing) {
                existing.failProtocol('Duplicate logical TCP connection ID');
                return;
            }
            if (this._connections.size >= MAX_MULTIPLEXED_TCP_CONNECTIONS) {
                this._send({
                    type: 'closed',
                    connectionId: frame.connectionId,
                    reason: 'limit',
                    message: `TCP multiplex session is limited to ${MAX_MULTIPLEXED_TCP_CONNECTIONS} connections`,
                });
                return;
            }
            const connection = new MultiplexedTcpConnection({
                connectionId: frame.connectionId,
                host: this._host,
                port: this._port,
                signal: this._stream.signal,
                send: message => this._send(message),
                onClosed: () => this._connections.delete(frame.connectionId),
            });
            this._connections.set(frame.connectionId, connection);
            connection.start();
            return;
        }
        const connection = this._connections.get(frame.connectionId);
        if (!connection) {
            if (frame.type !== 'close') {
                this._send({
                    type: 'closed',
                    connectionId: frame.connectionId,
                    reason: 'protocolError',
                    message: 'Logical TCP connection does not exist',
                });
            }
            return;
        }
        connection.handleFrame(frame);
    }

    private _send(message: ComputeNodeMultiplexedTcpServerFrame): void {
        if (this._stream.signal.aborted) return;
        this._stream.send(message).catch(() => { /* the caller went away */ });
    }
}

interface MultiplexedTcpConnectionOptions {
    connectionId: string;
    host: LoopbackHost;
    port: number;
    signal: AbortSignal;
    send(message: ComputeNodeMultiplexedTcpServerFrame): void;
    onClosed(): void;
}

class MultiplexedTcpConnection {
    private readonly _socket: Socket;
    private readonly _connected: Promise<void>;
    private readonly _outboundCredit = new ByteCredit(MULTIPLEXED_TCP_WINDOW_BYTES);
    private _input = Promise.resolve();
    private _inboundCredit = MULTIPLEXED_TCP_WINDOW_BYTES;
    private _lastError: Error | undefined;
    private _clientEnded = false;
    private _clientClosed = false;
    private _protocolError = false;
    private _closed = false;

    constructor(private readonly _options: MultiplexedTcpConnectionOptions) {
        this._socket = createConnection({ host: _options.host, port: _options.port, allowHalfOpen: true });
        this._socket.pause();
        this._socket.on('error', error => { this._lastError = error; });
        this._socket.once('close', () => this._finish());
        this._connected = waitForSocketConnect(this._socket, _options.signal);
    }

    start(): void {
        void this._run();
    }

    handleFrame(frame: Exclude<ComputeNodeMultiplexedTcpClientFrame, { type: 'open'; }>): void {
        switch (frame.type) {
            case 'credit':
                if (!this._outboundCredit.add(frame.bytes)) this.failProtocol('TCP receive credit exceeded the negotiated window');
                return;
            case 'close':
                this._clientClosed = true;
                this._socket.destroy();
                return;
            case 'end':
                this._appendInput(async () => {
                    if (this._clientEnded) throw new Error('Received duplicate TCP end frame');
                    await this._connected;
                    this._clientEnded = true;
                    this._socket.end();
                });
                return;
            case 'data': {
                const data = decodeBase64(frame.dataBase64);
                if (data.byteLength > MAX_MULTIPLEXED_TCP_FRAME_BYTES) {
                    this.failProtocol(`TCP data frame exceeds ${MAX_MULTIPLEXED_TCP_FRAME_BYTES} bytes`);
                    return;
                }
                if (data.byteLength > this._inboundCredit) {
                    this.failProtocol('TCP sender exceeded its receive credit');
                    return;
                }
                this._inboundCredit -= data.byteLength;
                this._appendInput(async () => {
                    if (this._clientEnded) throw new Error('Received TCP data after client end');
                    await this._connected;
                    if (!this._socket.write(data)) await once(this._socket, 'drain');
                    this._inboundCredit += data.byteLength;
                    this._options.send({ type: 'credit', connectionId: this._options.connectionId, bytes: data.byteLength });
                });
                return;
            }
        }
    }

    failProtocol(message: string): void {
        if (this._closed) return;
        this._protocolError = true;
        this._lastError = new Error(message);
        this._socket.destroy(this._lastError);
    }

    dispose(): void {
        this._outboundCredit.close(new Error('TCP multiplex session closed'));
        this._socket.destroy();
    }

    private async _run(): Promise<void> {
        try {
            await this._connected;
            if (this._closed || this._options.signal.aborted) return;
            this._options.send({
                type: 'opened',
                connectionId: this._options.connectionId,
                targetAddress: `${this._socket.remoteAddress ?? this._options.host}:${this._socket.remotePort ?? this._options.port}`,
                receiveWindowBytes: MULTIPLEXED_TCP_WINDOW_BYTES,
            });
            this._socket.resume();
            for await (const chunk of this._socket) {
                const data = Buffer.from(chunk);
                let offset = 0;
                while (offset < data.byteLength) {
                    const bytes = await this._outboundCredit.take(Math.min(MAX_MULTIPLEXED_TCP_FRAME_BYTES, data.byteLength - offset));
                    const frame = data.subarray(offset, offset + bytes);
                    this._options.send({ type: 'data', connectionId: this._options.connectionId, dataBase64: frame.toString('base64') });
                    offset += frame.byteLength;
                }
            }
            if (!this._closed && !this._options.signal.aborted) {
                this._options.send({ type: 'end', connectionId: this._options.connectionId });
            }
        } catch (error) {
            if (!this._options.signal.aborted && !this._closed) {
                this._lastError = error instanceof Error ? error : new Error(String(error));
                this._socket.destroy(this._lastError);
            }
        }
    }

    private _appendInput(action: () => Promise<void>): void {
        this._input = this._input.then(action).catch((error: unknown) => {
            if (this._closed) return;
            this._lastError = error instanceof Error ? error : new Error(String(error));
            this._socket.destroy(this._lastError);
        });
    }

    private _finish(): void {
        if (this._closed) return;
        this._closed = true;
        this._outboundCredit.close(this._lastError ?? new Error('TCP connection closed'));
        this._options.onClosed();
        if (this._options.signal.aborted) return;
        const reason = this._protocolError ? 'protocolError'
            : this._lastError ? 'error'
                : this._clientClosed ? 'clientClosed' : 'remoteClosed';
        this._options.send({
            type: 'closed',
            connectionId: this._options.connectionId,
            reason,
            ...(this._lastError ? { message: this._lastError.message } : {}),
        });
    }
}

class ByteCredit {
    private _waiter: { resolve(): void; reject(error: Error): void; } | undefined;
    private _closedError: Error | undefined;

    constructor(private _available: number) { }

    add(bytes: number): boolean {
        if (this._closedError || this._available + bytes > MULTIPLEXED_TCP_WINDOW_BYTES) return false;
        this._available += bytes;
        this._waiter?.resolve();
        this._waiter = undefined;
        return true;
    }

    async take(maxBytes: number): Promise<number> {
        while (this._available === 0) {
            if (this._closedError) throw this._closedError;
            await new Promise<void>((resolve, reject) => { this._waiter = { resolve, reject }; });
        }
        const bytes = Math.min(maxBytes, this._available);
        this._available -= bytes;
        return bytes;
    }

    close(error: Error): void {
        if (this._closedError) return;
        this._closedError = error;
        this._waiter?.reject(error);
        this._waiter = undefined;
    }
}

function fileKind(value: {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
}): ComputeNodeFileKind {
    if (value.isFile()) return 'file';
    if (value.isDirectory()) return 'directory';
    if (value.isSymbolicLink()) return 'symlink';
    if (value.isBlockDevice()) return 'blockDevice';
    if (value.isCharacterDevice()) return 'characterDevice';
    if (value.isFIFO()) return 'fifo';
    if (value.isSocket()) return 'socket';
    return 'other';
}

/** The filesystem root (drive root on Windows) and the home directory. */
async function readStorage(): Promise<ComputeNodeStatus['storage']> {
    const paths = [...new Set([path.parse(process.cwd()).root, os.homedir()])];
    const results = await Promise.all(paths.map(async storagePath => {
        try {
            const value = await statfs(storagePath);
            return {
                path: storagePath,
                totalBytes: value.blocks * value.bsize,
                freeBytes: value.bfree * value.bsize,
                availableBytes: value.bavail * value.bsize,
            };
        } catch {
            return undefined;
        }
    }));
    return results.filter(result => result !== undefined);
}

async function readCgroupCpu(): Promise<{ cgroupQuotaCores?: number; cgroupUsageMicros?: number; }> {
    if (process.platform !== 'linux') return {};
    const [maxText, statText] = await Promise.all([
        readOptionalText('/sys/fs/cgroup/cpu.max'),
        readOptionalText('/sys/fs/cgroup/cpu.stat'),
    ]);
    const result: { cgroupQuotaCores?: number; cgroupUsageMicros?: number; } = {};
    if (maxText) {
        const [quota, period] = maxText.trim().split(/\s+/);
        if (quota !== 'max' && quota !== undefined && period !== undefined) {
            const quotaValue = Number(quota);
            const periodValue = Number(period);
            if (Number.isFinite(quotaValue) && Number.isFinite(periodValue) && periodValue > 0) {
                result.cgroupQuotaCores = quotaValue / periodValue;
            }
        }
    }
    const usage = statText ? /^usage_usec\s+(\d+)$/m.exec(statText)?.[1] : undefined;
    if (usage !== undefined) result.cgroupUsageMicros = Number(usage);
    return result;
}

async function readCgroupMemory(): Promise<{ cgroupCurrentBytes?: number; cgroupLimitBytes?: number; }> {
    if (process.platform !== 'linux') return {};
    const [currentText, maxText] = await Promise.all([
        readOptionalText('/sys/fs/cgroup/memory.current'),
        readOptionalText('/sys/fs/cgroup/memory.max'),
    ]);
    const result: { cgroupCurrentBytes?: number; cgroupLimitBytes?: number; } = {};
    const current = Number(currentText?.trim());
    if (currentText && Number.isSafeInteger(current) && current >= 0) result.cgroupCurrentBytes = current;
    const max = Number(maxText?.trim());
    if (maxText?.trim() !== 'max' && Number.isSafeInteger(max) && max > 0) result.cgroupLimitBytes = max;
    return result;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
    try {
        return await readFileContents(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

function decodeBase64(value: string): Buffer {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('Invalid base64 content');
    }
    return Buffer.from(value, 'base64');
}

function normalizeHeaders(value: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
    return Object.fromEntries(Object.entries(value).flatMap(([name, header]) => (header === undefined ? [] : [[name, header]])));
}

function waitForSocketConnect(socket: Socket, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = (): void => {
            socket.off('connect', connected);
            socket.off('error', failed);
            signal.removeEventListener('abort', aborted);
        };
        const connected = (): void => { cleanup(); resolve(); };
        const failed = (error: Error): void => { cleanup(); reject(error); };
        const aborted = (): void => {
            cleanup();
            reject(signal.reason instanceof Error ? signal.reason : new Error('TCP forwarding cancelled'));
        };
        socket.once('connect', connected);
        socket.once('error', failed);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
    });
}
