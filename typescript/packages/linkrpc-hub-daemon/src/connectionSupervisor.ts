import * as net from 'node:net';
import { LinkRpcConnection, type IMessageTransport } from '@hediet/linkrpc';
import { connectNdjson, parseEndpointUri, runInitializeHandshake, WebSocketTransport, type ResolvedEndpoint } from '@hediet/linkrpc/node';
import { hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import { spawnCommand } from '@hediet/linkrpc-hub/spawn';
import type { ManagedService } from './config';
import { LogBuffer } from './logBuffer';
import type { LogLine, ServiceStatus } from './managementInterface';
import type { ServiceHost, ServiceSocket } from './supervisor';

interface TransportHandle {
    readonly transport: IMessageTransport;
    readonly closed: Promise<void>;
    dispose(): void;
}

type ConnectableEndpoint = Extract<ResolvedEndpoint, { kind: 'socket' | 'ws' | 'cmd-stdio' }>;

/**
 * Keeps a service's `endpoint` connected to the hub: its traffic is relayed
 * through the service's participant socket, so it may serve only the granted
 * `serviceId` and its calls pass the hub's forwarded-call gate. Reconnects with
 * backoff according to the restart policy.
 */
export class ConnectionSupervisor {
    private _state: ServiceStatus['state'] = 'stopped';
    private _error: string | undefined;
    private _since = Date.now();
    private _restarts = 0;
    private _generation = 0;
    private _socket: ServiceSocket | undefined;
    private _target: TransportHandle | undefined;
    private _local: TransportHandle | undefined;
    private _timer: ReturnType<typeof setTimeout> | undefined;
    private _pending: Promise<void> | undefined;
    private _service: ManagedService;
    private readonly _endpoint: ConnectableEndpoint;
    private readonly _logs = new LogBuffer();

    constructor(
        readonly name: string,
        service: ManagedService,
        private readonly _host: ServiceHost,
        private readonly _changed: () => void,
    ) {
        if (service.endpoint === undefined) throw new Error(`service '${name}' has no endpoint`);
        const endpoint = parseEndpointUri(service.endpoint);
        if (endpoint.kind !== 'socket' && endpoint.kind !== 'ws' && endpoint.kind !== 'cmd-stdio') {
            throw new Error('Managed connections require a LinkRPC socket, WebSocket, or cmd-stdio endpoint');
        }
        this._endpoint = endpoint;
        this._service = service;
    }

    get service(): ManagedService { return this._service; }
    status(): ServiceStatus {
        return {
            name: this.name, description: this._service.description, serviceId: this._service.serviceId,
            enabled: this._service.enabled, state: this._state, since: this._since,
            connections: this._state === 'running' ? 1 : 0, restarts: this._restarts, error: this._error,
        };
    }
    logs(limit?: number): LogLine[] {
        return this._logs.lines(limit);
    }
    async sync(): Promise<void> {
        if (!this._service.enabled) return this.dispose();
        if (this._state === 'running' || this._state === 'starting' || this._state === 'backoff') return;
        this._pending = this._connect(++this._generation);
        await this._pending;
    }
    async update(service: ManagedService): Promise<void> {
        const enabledChanged = this._service.enabled !== service.enabled;
        this._service = service;
        if (enabledChanged) await this.sync();
        this._changed();
    }
    input(): never { throw new Error('A connected endpoint has no managed process console'); }
    async restart(): Promise<void> {
        if (!this._service.enabled) throw new Error(`service '${this.name}' is disabled`);
        this._logDaemon('restart requested');
        await this.dispose();
        await this.sync();
    }
    async dispose(): Promise<void> {
        ++this._generation;
        clearTimeout(this._timer);
        this._cleanup();
        await this._pending;
        this._setState('stopped');
    }
    private async _connect(generation: number): Promise<void> {
        this._error = undefined;
        this._setState('starting');
        try {
            const target = await this._openTarget();
            if (generation !== this._generation) { target.dispose(); return; }
            this._target = target;
            this._socket = await this._host.openSocket(this.name, this._service, () => {});
            if (generation !== this._generation) { this._cleanup(); return; }
            const env = this._socket.env;
            const local = await openTransport(parseEndpointUri(env.LINKRPC_ENDPOINT ?? env.HUBRPC_ENDPOINT!), env.LINKRPC_TOKEN ?? env.HUBRPC_TOKEN);
            if (generation !== this._generation) { local.dispose(); this._cleanup(); return; }
            this._local = local;
            // Claims are performed before handing the transport to the remote endpoint.
            const registration = LinkRpcConnection.fromTransport(local.transport);
            await registration.get(hubGrantedServiceIdInterface).register({ serviceId: this._service.serviceId });
            local.transport.setListener(message => target.transport.send(message));
            target.transport.setListener(message => local.transport.send(message));
            this._setState('running');
            void Promise.race([local.closed, target.closed]).then(() => {
                if (generation === this._generation) this._failed(generation, new Error('Endpoint disconnected'));
            });
        } catch (error) {
            if (generation === this._generation) this._failed(generation, error);
        }
    }
    private _failed(generation: number, error: unknown): void {
        this._cleanup();
        this._error = error instanceof Error ? error.message : String(error);
        this._logDaemon(this._error);
        if (this._service.restart === 'never') {
            this._setState('failed');
        } else {
            this._setState('backoff');
            this._timer = setTimeout(() => {
                if (generation !== this._generation) return;
                this._restarts++;
                this._pending = this._connect(generation);
            }, Math.min(30_000, 500 * 2 ** Math.min(this._restarts, 6)));
        }
    }
    private _cleanup(): void {
        this._target?.dispose(); this._target = undefined;
        this._local?.dispose(); this._local = undefined;
        this._socket?.dispose(); this._socket = undefined;
    }
    private _setState(state: ServiceStatus['state']): void {
        this._state = state; this._since = Date.now(); this._changed();
    }
    private _openTarget(): Promise<TransportHandle> {
        if (this._endpoint.kind !== 'cmd-stdio') return openTransport(this._endpoint);
        return openCommandTransport(this._endpoint, line => {
            this._logs.append('stderr', line + '\n');
            this._host.log(this.name, line);
        });
    }
    private _logDaemon(text: string): void {
        this._host.notice?.(this.name, text);
        this._logs.append('daemon', text + '\n');
        this._host.log(this.name, text);
    }
}

/** Spawn the endpoint's command and speak handshake-free newline-delimited JSON-RPC over its stdio. */
async function openCommandTransport(
    endpoint: Extract<ConnectableEndpoint, { kind: 'cmd-stdio' }>,
    onStderrLine: (line: string) => void,
): Promise<TransportHandle> {
    const child = spawnCommand(endpoint.command, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...endpoint.env },
        windowsHide: true,
        ...(endpoint.cwd !== undefined ? { cwd: endpoint.cwd } : {}),
    });
    const kill = () => { if (child.exitCode === null && !child.killed) child.kill(); };
    const closed = new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
    });
    let partial = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
        const lines = (partial + chunk).split(/\r?\n/);
        partial = lines.pop()!;
        for (const line of lines) if (line.length > 0) onStderrLine(line);
    });
    await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
    });
    const { transport } = await connectNdjson({ input: child.stdout!, output: child.stdin!, onClose: kill });
    return { transport, closed, dispose: () => { transport.dispose(); kill(); } };
}

async function openTransport(endpoint: ResolvedEndpoint, token?: string): Promise<TransportHandle> {
    if (endpoint.kind === 'socket') {
        const socket = net.createConnection(endpoint.path);
        socket.setTimeout(10_000, () => socket.destroy(new Error('Endpoint initialization timed out')));
        const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
        try {
            const { transport } = await connectNdjson({
                input: socket, output: socket, onClose: () => socket.destroy(),
                initialize: { kind: 'client', token: token ?? endpoint.token ?? '' },
            });
            socket.setTimeout(0);
            return { transport, closed, dispose: () => socket.destroy() };
        } catch (error) { socket.destroy(); throw error; }
    }
    if (endpoint.kind === 'ws') {
        const ws = new WebSocket(endpoint.url);
        await new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => {
                clearTimeout(timeout);
                ws.removeEventListener('open', opened);
                ws.removeEventListener('error', failed);
                if (error) { ws.close(); reject(error); } else resolve();
            };
            const opened = () => finish();
            const failed = () => finish(new Error('WebSocket connection failed'));
            const timeout = setTimeout(() => finish(new Error('WebSocket connection timed out')), 10_000);
            ws.addEventListener('open', opened, { once: true });
            ws.addEventListener('error', failed, { once: true });
        });
        const closed = new Promise<void>(resolve => ws.addEventListener('close', () => resolve(), { once: true }));
        const transport = new WebSocketTransport(ws, () => ws.close());
        try {
            await runInitializeHandshake(transport, { kind: 'client', token: token ?? endpoint.token ?? '' });
            return { transport, closed, dispose: () => transport.dispose() };
        } catch (error) { transport.dispose(); throw error; }
    }
    throw new Error('Managed connections require a LinkRPC socket or WebSocket endpoint');
}
