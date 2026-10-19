import * as net from 'node:net';
import { LinkRpcConnection, type IMessageTransport } from '@hediet/linkrpc';
import { connectNdjson, parseEndpointUri, runInitializeHandshake, WebSocketTransport } from '@hediet/linkrpc/node';
import { hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import type { ManagedService } from './config';
import type { ServiceStatus } from './managementInterface';
import type { ServiceHost, ServiceSocket } from './supervisor';

interface TransportHandle {
    readonly transport: IMessageTransport;
    readonly closed: Promise<void>;
    dispose(): void;
}

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

    constructor(
        readonly name: string,
        private readonly _endpoint: string,
        service: ManagedService,
        private readonly _host: ServiceHost,
        private readonly _changed: () => void,
    ) {
        const endpoint = parseEndpointUri(_endpoint);
        if (endpoint.kind !== 'socket' && endpoint.kind !== 'ws') {
            throw new Error('Managed connections require a LinkRPC socket or WebSocket endpoint');
        }
        this._service = service;
    }

    get service(): ManagedService { return this._service; }
    status(): ServiceStatus {
        return {
            name: this.name, serviceId: this._service.serviceId, enabled: this._service.enabled,
            state: this._state, since: this._since, connections: this._state === 'running' ? 1 : 0,
            restarts: this._restarts, error: this._error,
        };
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
            const target = await openTransport(this._endpoint);
            if (generation !== this._generation) { target.dispose(); return; }
            this._target = target;
            this._socket = await this._host.openSocket(this.name, this._service, () => {});
            if (generation !== this._generation) { this._cleanup(); return; }
            const env = this._socket.env;
            const local = await openTransport(env.LINKRPC_ENDPOINT ?? env.HUBRPC_ENDPOINT!, env.LINKRPC_TOKEN ?? env.HUBRPC_TOKEN);
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
        this._host.notice?.(this.name, this._error);
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
}

async function openTransport(uri: string, token?: string): Promise<TransportHandle> {
    const endpoint = parseEndpointUri(uri);
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
