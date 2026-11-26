import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ConsoleSignal } from '@hediet/linkrpc-infra/console';
import { writePrivateJson } from './discovery';
import type { HubHome } from './paths';
import type { ExitInfo, ServiceProcess, SpawnServiceOptions } from './processIo';

interface ProcHostDiscovery {
    readonly version: 1;
    readonly pid: number;
    readonly endpoint: string;
    readonly token: string;
}

interface ProcessSummary {
    readonly id: string;
    readonly pid: number;
    readonly running: boolean;
    readonly startedAt: number;
    readonly exit?: {
        readonly code: number | null;
        readonly signal: string | null;
        readonly exitedAt: number;
    };
}

interface OutputChunk {
    readonly stream: 'stdout' | 'stderr';
    readonly dataBase64: string;
}

interface RpcResponse {
    readonly id: number;
    readonly result?: unknown;
    readonly error?: { readonly code: number; readonly message: string };
}

interface RpcNotification {
    readonly method: 'output' | 'exit';
    readonly params: Record<string, unknown>;
}

const PROC_HOST_STARTUP_TIMEOUT_MS = 5_000;

/**
 * Locate the compiled `linkrpc-proc-host` Rust binary, if present.
 * Checked in order: `LINKRPC_PROC_HOST_BIN` env var, then adjacent `rust/target/{release,debug}`.
 */
export function findProcHostBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const exe = process.platform === 'win32' ? 'linkrpc-proc-host.exe' : 'linkrpc-proc-host';
    const override = env.LINKRPC_PROC_HOST_BIN;
    if (override && fs.existsSync(override)) return override;
    // When running from the linkrpc monorepo: typescript/packages/linkrpc-hub-daemon/{dist,src}
    const candidates = [
        path.resolve(__dirname, '../../../../rust/target/release', exe),
        path.resolve(__dirname, '../../../../rust/target/debug', exe),
        path.resolve(__dirname, '../../../../../rust/target/release', exe),
        path.resolve(__dirname, '../../../../../rust/target/debug', exe),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

/**
 * Client for the out-of-process Rust `linkrpc-proc-host` supervisor.
 *
 * `linkrpc-proc-host` owns child processes and their Windows Job Objects /
 * Unix process groups independently of `linkrpc-hub-daemon`. Disconnecting
 * from `ProcHostClient` leaves running services untouched so a restarted
 * daemon can reconnect and adopt them with zero downtime.
 */
export class ProcHostClient {
    public static async connectOrStart(
        home: HubHome,
        binaryPath: string,
        log: (line: string) => void,
    ): Promise<ProcHostClient> {
        const discoveryFile = path.join(home.stateDir, 'proc-host.json');
        const existing = _readDiscovery(discoveryFile);
        if (existing) {
            try {
                const client = await ProcHostClient._connect(existing.endpoint, existing.token);
                log(`[proc-host] reattached to existing linkrpc-proc-host (pid ${existing.pid})`);
                return client;
            } catch {
                // Stale discovery file; start a fresh proc-host below.
            }
        }

        const endpoint = home.allocEndpoint('proc-host');
        const token = randomBytes(32).toString('base64url');
        const child = spawn(binaryPath, ['--endpoint', endpoint], {
            env: { ...process.env, LINKRPC_PROC_HOST_TOKEN: token },
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
        });
        child.unref();
        const pid = child.pid;
        if (pid === undefined) {
            throw new Error(`failed to spawn linkrpc-proc-host from ${binaryPath}`);
        }

        const deadline = Date.now() + PROC_HOST_STARTUP_TIMEOUT_MS;
        let lastError: unknown;
        while (Date.now() < deadline) {
            try {
                const client = await ProcHostClient._connect(endpoint, token);
                writePrivateJson(discoveryFile, { version: 1, pid, endpoint, token } satisfies ProcHostDiscovery);
                log(`[proc-host] started linkrpc-proc-host (pid ${pid})`);
                return client;
            } catch (error) {
                lastError = error;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        throw new Error(`linkrpc-proc-host did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }

    private static _connect(endpoint: string, token: string): Promise<ProcHostClient> {
        const target = endpoint.replace(/^npipe:/, '').replace(/^unix:/, '');
        return new Promise((resolve, reject) => {
            const socket = net.connect(target);
            const onErr = (error: Error) => {
                socket.destroy();
                reject(error);
            };
            socket.once('error', onErr);
            socket.once('connect', () => {
                socket.off('error', onErr);
                const client = new ProcHostClient(socket);
                client._request('hello', { token }).then(
                    () => resolve(client),
                    error => {
                        client.disconnect();
                        reject(error);
                    },
                );
            });
        });
    }

    private _nextId = 1;
    private _buffer = '';
    private _closed = false;
    private readonly _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private readonly _outputListeners = new Map<string, (stream: 'stdout' | 'stderr', data: Uint8Array) => void>();
    private readonly _exitListeners = new Map<string, (info: ExitInfo) => void>();

    private constructor(private readonly _socket: net.Socket) {
        _socket.setEncoding('utf8');
        _socket.on('data', (chunk: string) => this._onData(chunk));
        _socket.on('error', () => this._onClose());
        _socket.on('close', () => this._onClose());
    }

    public async list(): Promise<ProcessSummary[]> {
        const res = await this._request('list', {}) as { processes: ProcessSummary[] };
        return res.processes;
    }

    /**
     * If `id` is already running in `linkrpc-proc-host`, adopt it (replaying
     * buffered output and attaching live listeners). Otherwise spawn it.
     * Returns immediately so `ServiceSupervisor` transitions to `starting` synchronously.
     */
    public spawnOrAdopt(id: string, options: SpawnServiceOptions): ServiceProcess {
        let currentPid: number | undefined;
        let detached = false;
        let resolveSpawned!: () => void;
        let resolveExit!: (info: ExitInfo) => void;
        const spawned = new Promise<void>(resolve => { resolveSpawned = resolve; });
        const exited = new Promise<ExitInfo>(resolve => { resolveExit = resolve; });

        this._outputListeners.set(id, (stream, data) => {
            if (!detached) options.onOutput(stream, data);
        });
        this._exitListeners.set(id, info => {
            this._outputListeners.delete(id);
            this._exitListeners.delete(id);
            if (!detached) resolveExit(info);
        });

        void (async () => {
            try {
                const running = (await this.list()).find(p => p.id === id && p.running);
                if (running) {
                    currentPid = running.pid;
                    resolveSpawned();
                    try {
                        const buffered = await this._request('output', { id }) as { chunks: OutputChunk[] };
                        for (const chunk of buffered.chunks) {
                            if (!detached) options.onOutput(chunk.stream, Buffer.from(chunk.dataBase64, 'base64'));
                        }
                    } catch { /* best-effort replay */ }
                    return;
                }

                const env: Record<string, string> = {};
                for (const [k, v] of Object.entries(options.env)) {
                    if (v !== undefined) env[k] = v;
                }
                const summary = await this._request('spawn', {
                    id,
                    command: [...options.command],
                    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                    env,
                    replace: true,
                }) as ProcessSummary;
                currentPid = summary.pid;
                resolveSpawned();
            } catch (error) {
                this._outputListeners.delete(id);
                this._exitListeners.delete(id);
                if (!detached) {
                    resolveExit({
                        code: null,
                        signal: null,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        })();

        return {
            get pid() { return currentPid; },
            spawned,
            exited,
            write: data => {
                if (detached) return;
                void this._request('write', { id, dataBase64: Buffer.from(data).toString('base64') }).catch(err => {
                    options.onError(`stdin failed: ${err instanceof Error ? err.message : String(err)}`);
                });
            },
            resize: () => {},
            signal: (signal: ConsoleSignal) => {
                if (detached) return;
                void this._request('signal', { id, signal }).catch(() => {});
            },
            kill: async () => {
                if (detached) return;
                await this._request('kill', { id }).catch(() => {});
            },
            detach: () => {
                detached = true;
                this._outputListeners.delete(id);
                this._exitListeners.delete(id);
            },
        };
    }

    /** Disconnect from `linkrpc-proc-host` without stopping any running child processes. */
    public disconnect(): void {
        if (this._closed) return;
        this._closed = true;
        this._outputListeners.clear();
        this._exitListeners.clear();
        this._socket.destroy();
    }

    /** Ask `linkrpc-proc-host` to shut down (optionally killing all children). */
    public async shutdownHost(killChildren: boolean): Promise<void> {
        try {
            await this._request('shutdown', { killChildren });
        } finally {
            this.disconnect();
        }
    }

    private _attach(id: string, pid: number, options: SpawnServiceOptions): ServiceProcess {
        let detached = false;
        let resolveExit!: (info: ExitInfo) => void;
        const exited = new Promise<ExitInfo>(resolve => { resolveExit = resolve; });

        this._outputListeners.set(id, (stream, data) => {
            if (!detached) options.onOutput(stream, data);
        });
        this._exitListeners.set(id, info => {
            this._outputListeners.delete(id);
            this._exitListeners.delete(id);
            if (!detached) resolveExit(info);
        });

        return {
            get pid() { return pid; },
            spawned: Promise.resolve(),
            exited,
            write: data => {
                if (detached) return;
                void this._request('write', { id, dataBase64: Buffer.from(data).toString('base64') }).catch(err => {
                    options.onError(`stdin failed: ${err instanceof Error ? err.message : String(err)}`);
                });
            },
            resize: () => {},
            signal: (signal: ConsoleSignal) => {
                if (detached) return;
                void this._request('signal', { id, signal }).catch(() => {});
            },
            kill: async () => {
                if (detached) return;
                await this._request('kill', { id }).catch(() => {});
            },
            detach: () => {
                detached = true;
                this._outputListeners.delete(id);
                this._exitListeners.delete(id);
            },
        };
    }

    private _request(method: string, params: unknown): Promise<unknown> {
        if (this._closed) return Promise.reject(new Error('proc-host connection is closed'));
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            try {
                this._socket.write(`${JSON.stringify({ id, method, params })}\n`);
            } catch (error) {
                this._pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private _onData(chunk: string): void {
        this._buffer += chunk;
        let idx: number;
        while ((idx = this._buffer.indexOf('\n')) !== -1) {
            const line = this._buffer.slice(0, idx).trim();
            this._buffer = this._buffer.slice(idx + 1);
            if (!line) continue;
            let msg: RpcResponse | RpcNotification;
            try {
                msg = JSON.parse(line) as RpcResponse | RpcNotification;
            } catch {
                continue;
            }
            if ('id' in msg && typeof msg.id === 'number') {
                const pending = this._pending.get(msg.id);
                if (!pending) continue;
                this._pending.delete(msg.id);
                if (msg.error) pending.reject(new Error(msg.error.message));
                else pending.resolve(msg.result);
            } else if ('method' in msg) {
                this._onNotification(msg);
            }
        }
    }

    private _onNotification(notif: RpcNotification): void {
        const id = notif.params.id;
        if (typeof id !== 'string') return;
        if (notif.method === 'output') {
            const stream = notif.params.stream;
            const b64 = notif.params.dataBase64;
            if ((stream === 'stdout' || stream === 'stderr') && typeof b64 === 'string') {
                this._outputListeners.get(id)?.(stream, Buffer.from(b64, 'base64'));
            }
        } else if (notif.method === 'exit') {
            const code = typeof notif.params.code === 'number' ? notif.params.code : null;
            const signal = typeof notif.params.signal === 'string' ? notif.params.signal : null;
            this._exitListeners.get(id)?.({ code, signal });
        }
    }

    private _onClose(): void {
        this._closed = true;
        for (const pending of this._pending.values()) {
            pending.reject(new Error('proc-host connection closed'));
        }
        this._pending.clear();
    }
}

function _readDiscovery(filePath: string): ProcHostDiscovery | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ProcHostDiscovery>;
        if (parsed.version === 1 && typeof parsed.pid === 'number' && typeof parsed.endpoint === 'string' && typeof parsed.token === 'string') {
            return parsed as ProcHostDiscovery;
        }
    } catch { /* missing or unreadable */ }
    return undefined;
}
