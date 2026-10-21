import { StringDecoder } from 'node:string_decoder';
import type { ConsoleSignal, ConsoleSize } from '@hediet/linkrpc-infra/console';
import type { ParticipantDescriptor } from '@hediet/linkrpc/inspection';
import type { ManagedService } from './config';
import { LogBuffer } from './logBuffer';
import type { LogLine, ServiceState, ServiceStatus } from './managementInterface';
import { spawnPipeProcess, spawnPtyProcess, type ExitInfo, type ServiceProcess } from './processIo';
import { terminateProcessTree } from './processTree';

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** A process that stays up this long resets the backoff. */
const STABLE_AFTER_MS = 10_000;
const KILL_WAIT_MS = 5_000;

/** The hub-side resources a supervisor needs. */
export interface ServiceHost {
    /**
     * Open the private hub socket the service dials (`LINKRPC_ENDPOINT`/`LINKRPC_TOKEN`).
     * `descriptor` describes its peers in the hub's topology; the host picks one by default.
     */
    openSocket(
        name: string,
        service: ManagedService,
        onConnectionCountChanged: (count: number) => void,
        descriptor?: ParticipantDescriptor,
    ): Promise<ServiceSocket>;
    log(name: string, line: string): void;
    output?(name: string, stream: 'stdout' | 'stderr' | 'tty', data: Uint8Array): void;
    /** Supervisor messages, such as exits and restart backoff. */
    notice?(name: string, text: string): void;
    processStarted?(name: string, pid: number | undefined): void;
    processExited?(name: string, exit: { code: number | null; signal: string | null }): void;
}

export interface ServiceSocket {
    readonly env: Readonly<Record<string, string>>;
    dispose(): void;
}

/**
 * Keeps one configured service in its desired state: spawns it with a hub
 * socket, tracks readiness, restarts it with exponential backoff according to
 * its restart policy, and stops it gracefully (hub disconnect, SIGTERM) before
 * killing its process tree. All state transitions are serialized.
 */
export class ServiceSupervisor {
    private _service: ManagedService;
    private _state: ServiceState;
    private _since = Date.now();
    private _process: ServiceProcess | undefined;
    private _socket: ServiceSocket | undefined;
    private _connections = 0;
    private _restarts = 0;
    private _consecutiveFailures = 0;
    private _lastExit: ServiceStatus['lastExit'];
    private _error: string | undefined;
    private _stopping = false;
    private _disposed = false;
    private _backoffTimer: ReturnType<typeof setTimeout> | undefined;
    private _startTimer: ReturnType<typeof setTimeout> | undefined;
    private _stableTimer: ReturnType<typeof setTimeout> | undefined;
    private _ops: Promise<void> = Promise.resolve();
    private readonly _logs = new LogBuffer();
    private readonly _decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8'), tty: new StringDecoder('utf8') };
    private _size: ConsoleSize = { cols: 80, rows: 24 };

    constructor(
        public readonly name: string,
        service: ManagedService,
        private readonly _host: ServiceHost,
        private readonly _onDidChange: () => void,
    ) {
        this._service = service;
        this._state = service.enabled ? 'stopped' : 'disabled';
    }

    public get service(): ManagedService {
        return this._service;
    }

    public status(): ServiceStatus {
        return {
            name: this.name,
            description: this._service.description,
            serviceId: this._service.serviceId,
            enabled: this._service.enabled,
            state: this._state,
            since: this._since,
            pid: this._process?.pid,
            connections: this._connections,
            restarts: this._restarts,
            lastExit: this._lastExit,
            error: this._error,
        };
    }

    public logs(limit?: number): LogLine[] {
        return this._logs.lines(limit);
    }

    public write(data: Uint8Array): void {
        this._running().write(data);
    }

    /** Applies to the running pseudoterminal and to later starts. */
    public resize(size: ConsoleSize): void {
        this._size = size;
        this._process?.resize(size);
    }

    public signal(signal: ConsoleSignal): void {
        this._running().signal(signal);
    }

    private _running(): ServiceProcess {
        if (!this._process) throw new Error('The process is not running');
        return this._process;
    }

    /** Start or stop to match `enabled`. */
    public sync(): Promise<void> {
        return this._enqueue(() => (this._service.enabled ? this._launch() : this._stop('disabled')));
    }

    /** Apply a change that keeps the process (see `classifyServiceChange`); only `enabled` starts or stops it. */
    public update(service: ManagedService): Promise<void> {
        const enabledChanged = service.enabled !== this._service.enabled;
        this._service = service;
        if (!enabledChanged) {
            this._onDidChange();
            return Promise.resolve();
        }
        this._logDaemon(service.enabled ? 'enabled' : 'disabled');
        return this.sync();
    }

    public restart(): Promise<void> {
        return this._enqueue(async () => {
            if (!this._service.enabled) throw new Error(`service '${this.name}' is disabled`);
            this._logDaemon('restart requested');
            await this._stop('stopped');
            this._consecutiveFailures = 0;
            await this._launch();
        });
    }

    /** Stop the service for good. */
    public dispose(): Promise<void> {
        this._disposed = true;
        return this._enqueue(() => this._stop('stopped'), { evenIfDisposed: true });
    }

    private _enqueue(op: () => Promise<void>, options: { evenIfDisposed?: boolean; } = {}): Promise<void> {
        const run = this._ops.then(() => (this._disposed && !options.evenIfDisposed ? undefined : op()));
        this._ops = run.catch(error => this._logDaemon(`error: ${_message(error)}`));
        return run;
    }

    private async _launch(): Promise<void> {
        if (this._disposed || !this._service.enabled || this._process || this._backoffTimer) return;
        await this._spawn();
    }

    private async _spawn(): Promise<void> {
        const service = this._service;
        try {
            if (service.rpc) {
                this._socket ??= await this._host.openSocket(this.name, service, count => this._onConnections(count));
            }
        } catch (error) {
            this._error = `cannot connect to the hub: ${_message(error)}`;
            this._logDaemon(this._error);
            this._setState('failed');
            return;
        }
        const env = { ...process.env };
        if (!service.rpc) {
            for (const key of Object.keys(env)) {
                if (/^(LINKRPC|HUBRPC)_(ENDPOINT|TOKEN)$/i.test(key)) delete env[key];
            }
        }
        const options = {
            command: service.command,
            env: { ...env, ...service.env, ...this._socket?.env },
            ...(service.cwd !== undefined ? { cwd: service.cwd } : {}),
            onOutput: (stream: 'stdout' | 'stderr' | 'tty', data: Uint8Array) => this._appendOutput(stream, data),
            onError: (message: string) => this._logDaemon(message),
        };
        let spawned: ServiceProcess;
        try {
            spawned = service.tty ? await spawnPtyProcess({ ...options, size: this._size }) : spawnPipeProcess(options);
        } catch (error) {
            this._onSpawnFailed(_message(error));
            return;
        }
        this._process = spawned;
        this._error = undefined;
        this._setState('starting');
        void spawned.spawned.then(() => {
            if (this._process === spawned) this._host.processStarted?.(this.name, spawned.pid);
        });
        if (!service.rpc || service.readiness === 'spawned') {
            void spawned.spawned.then(() => {
                if (this._process === spawned && this._state === 'starting') this._markRunning();
            });
        } else {
            this._startTimer = setTimeout(() => {
                if (this._process !== spawned || this._state !== 'starting') return;
                this._error = `did not connect to the hub within ${service.startTimeoutMs} ms`;
                this._logDaemon(this._error);
                void spawned.kill();
            }, service.startTimeoutMs);
        }
        void spawned.exited.then(info => this._onExit(spawned, info));
    }

    private _onSpawnFailed(error: string): void {
        this._lastExit = { code: null, signal: null, at: Date.now() };
        this._error = `cannot start: ${error}`;
        this._logDaemon(this._error);
        this._releaseSocket();
        this._setState('failed');
    }

    private _onExit(process: ServiceProcess, info: ExitInfo): void {
        if (this._process !== process) return;
        this._process = undefined;
        this._clearProcessTimers();
        this._lastExit = { code: info.code, signal: info.signal, at: Date.now() };
        if (info.error === undefined) this._host.processExited?.(this.name, { code: info.code, signal: info.signal });
        if (this._stopping) return;

        const failed = info.error !== undefined || info.code !== 0 || info.signal !== null;
        if (info.error !== undefined) this._error = `cannot start: ${info.error}`;
        else if (failed) this._error ??= _describeExit(info);
        const policy = this._service.restart;
        const restart = !this._disposed && this._service.enabled
            && (policy === 'always' || (policy === 'on-failure' && failed));
        if (!restart) {
            this._logDaemon(_describeExit(info));
            this._releaseSocket();
            this._setState(failed ? 'failed' : 'stopped');
            return;
        }
        const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this._consecutiveFailures);
        this._consecutiveFailures++;
        this._logDaemon(`${_describeExit(info)}; restarting in ${delay} ms`);
        const timer = setTimeout(() => {
            void this._enqueue(async () => {
                if (this._backoffTimer !== timer) return;
                this._backoffTimer = undefined;
                this._restarts++;
                await this._spawn();
            });
        }, delay);
        this._backoffTimer = timer;
        this._setState('backoff');
    }

    private async _stop(finalState: 'stopped' | 'disabled'): Promise<void> {
        clearTimeout(this._backoffTimer);
        this._backoffTimer = undefined;
        const running = this._process;
        if (running) {
            this._stopping = true;
            this._setState('stopping');
            try {
                await this._terminate(running);
            } finally {
                this._stopping = false;
                this._process = undefined;
                this._clearProcessTimers();
            }
        }
        this._releaseSocket();
        this._error = undefined;
        this._setState(finalState);
    }

    /** Disconnecting from the hub is the portable stop request; POSIX also gets SIGTERM. */
    private async _terminate(running: ServiceProcess): Promise<void> {
        // Windows pipe children without an RPC connection have no graceful stop channel.
        const canStopGracefully = process.platform !== 'win32' || this._connections > 0;
        this._releaseSocket();
        const pid = running.pid;
        if (canStopGracefully) {
            if (pid !== undefined) terminateProcessTree(pid);
            if (await _settlesWithin(running.exited, this._service.stopTimeoutMs)) return;
            this._logDaemon(`did not stop within ${this._service.stopTimeoutMs} ms; killing`);
        }
        await running.kill();
        if (!await _settlesWithin(running.exited, KILL_WAIT_MS)) this._logDaemon('process did not exit after kill');
    }

    private _onConnections(count: number): void {
        this._connections = count;
        if (count > 0 && this._state === 'starting' && this._service.readiness === 'connected') {
            this._markRunning();
        } else {
            this._onDidChange();
        }
    }

    private _markRunning(): void {
        clearTimeout(this._startTimer);
        this._startTimer = undefined;
        this._stableTimer = setTimeout(() => {
            this._consecutiveFailures = 0;
        }, STABLE_AFTER_MS);
        this._setState('running');
    }

    private _releaseSocket(): void {
        this._socket?.dispose();
        this._socket = undefined;
        this._connections = 0;
    }

    private _clearProcessTimers(): void {
        clearTimeout(this._startTimer);
        clearTimeout(this._stableTimer);
        this._startTimer = undefined;
        this._stableTimer = undefined;
    }

    private _setState(state: ServiceState): void {
        if (this._state !== state) {
            this._state = state;
            this._since = Date.now();
        }
        this._onDidChange();
    }

    private _appendOutput(stream: 'stdout' | 'stderr' | 'tty', data: Uint8Array): void {
        this._host.output?.(this.name, stream, data);
        const text = this._decoders[stream].write(Buffer.from(data));
        const logStream = stream === 'stderr' ? 'stderr' : 'stdout';
        for (const line of this._logs.append(logStream, stream === 'tty' ? _stripTerminalControls(text) : text)) {
            this._host.log(this.name, line);
        }
    }

    private _logDaemon(text: string): void {
        this._host.notice?.(this.name, text);
        this._logs.append('daemon', text + '\n');
        this._host.log(this.name, text);
    }
}

/** Keep TTY log lines readable: drop escape sequences, carriage returns, and other controls. */
function _stripTerminalControls(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])|[\x00-\x09\x0b-\x1f\x7f]/g, '');
}

function _describeExit(info: ExitInfo): string {
    if (info.error !== undefined) return `failed to start: ${info.error}`;
    if (info.signal !== null) return `killed by ${info.signal}`;
    return `exited with code ${info.code}`;
}

function _settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), ms);
        void promise.then(() => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

function _message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
