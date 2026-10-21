import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { LinkRpcConnection } from '@hediet/linkrpc';
import { type HubConfig, runHub, type RunningHub } from '@hediet/linkrpc-hub';
import { type NodeSocketTransport, SocketServer } from '@hediet/linkrpc-hub/hub/server/node';
import { classifyServiceChange, type DaemonConfig, type ManagedService, parseDaemonConfig, parseDaemonConfigText, setCallLogLevelInText, setServiceEnabledInText, stableKey } from './config';
import { CallLog } from './callLog/callLog';
import type { CallLogLevel } from './callLog/callRecord';
import { ConfigFile } from './configFile';
import { DaemonLog } from './daemonLog';
import { readEndpointDiscovery, writePrivateJson, type EndpointDiscovery } from './discovery';
import { type DaemonStatus, hubDaemonManagementInterface } from './managementInterface';
import { packageVersion } from './packageInfo';
import { HubHome } from './paths';
import { SingleInstanceLock } from './singleInstance';
import { type ServiceHost, ServiceSupervisor } from './supervisor';
import * as path from 'node:path';
import { ManagedEndpoints } from './managedEndpoints';

export interface StartHubDaemonOptions {
    readonly home?: HubHome;
    /** Also write the log to stderr. */
    readonly echoLog?: boolean;
}

interface LocalEndpoint {
    readonly path: string;
    readonly token: string | undefined;
}

/**
 * The per-user hub daemon. Runs a LinkRPC hub with a private local endpoint,
 * supervises the configured services, applies config file changes
 * incrementally, and serves the management API.
 *
 * Reconciliation rules: a change to hub-wide settings restarts the hub and
 * every service; otherwise only added, removed, or changed services are
 * touched, and changes to `enabled`, `restart`, timeouts, or `description`
 * keep the process running. An invalid file keeps the running configuration.
 */
export class HubDaemon {
    public static async start(options: StartHubDaemonOptions = {}): Promise<HubDaemon> {
        const home = options.home ?? HubHome.resolve();
        _ensurePrivateDirs(home);
        const lock = await SingleInstanceLock.acquire(home.lockEndpoint);
        const log = DaemonLog.open(home.logFile, { echo: options.echoLog ?? false });
        const daemon = new HubDaemon(home, lock, log);
        try {
            await daemon._start();
            return daemon;
        } catch (error) {
            log.line(`startup failed: ${_message(error)}`);
            await daemon.shutdown();
            throw error;
        }
    }

    public readonly startedAt = Date.now();
    public readonly version = packageVersion();
    /** Resolves once the daemon has shut down. */
    public readonly done: Promise<void>;

    private readonly _configFile: ConfigFile;
    private _appPath: string;
    private readonly _management: LocalEndpoint & { readonly token: string; };
    private readonly _services = new Map<string, ServiceSupervisor>();
    private readonly _statusListeners = new Set<() => void>();
    private readonly _serviceHost: ServiceHost;
    private _endpoints: ManagedEndpoints | undefined;
    private readonly _endpointRegistrations = new Map<LinkRpcConnection, { dispose(): void } | undefined>();
    private _managementLink: { dispose(): void } | undefined;
    private _hub: RunningHub | undefined;
    private _hubKey: string | undefined;
    private readonly _callLog: CallLog;
    private _callLogAttachment: { dispose(): void } | undefined;
    private _hubStartedAt = 0;
    private _hubError: string | undefined;
    private _seenRevision: string | undefined;
    private _appliedRevision: string | undefined;
    private _appliedAt: number | undefined;
    private _configError: string | undefined;
    private _reconcile: Promise<void> = Promise.resolve();
    private _managementServer: SocketServer | undefined;
    private _watcher: { dispose(): void; } | undefined;
    private _statusChangeScheduled = false;
    private _stopping = false;
    private _shutdown: Promise<void> | undefined;
    private _resolveDone!: () => void;

    private constructor(
        public readonly home: HubHome,
        private readonly _lock: SingleInstanceLock,
        private readonly _log: DaemonLog,
    ) {
        this.done = new Promise(resolve => { this._resolveDone = resolve; });
        this._configFile = new ConfigFile(home.configFile, home.configSchemaFile);
        this._callLog = new CallLog(home.callLogDir, this.startedAt, level => this.setCallLogLevel(level));
        this._appPath = home.defaultAppEndpoint;
        this._management = { path: home.allocEndpoint('management'), token: _token() };
        this._serviceHost = {
            openSocket: (name, service, onConnectionCountChanged) => this._openServiceSocket(name, service, onConnectionCountChanged),
            log: (name, line) => this._log.line(`[${name}] ${line}`),
        };
    }

    public status(): DaemonStatus {
        return {
            pid: process.pid,
            version: this.version,
            startedAt: this.startedAt,
            endpoint: this._appPath,
            configFile: this.home.configFile,
            logFile: this.home.logFile,
            config: { revision: this._appliedRevision, appliedAt: this._appliedAt, error: this._configError },
            hub: {
                startedAt: this._hubStartedAt,
                listeners: this._hub?.listeners.map(({ type, address }) => ({ type, address })) ?? [],
                error: this._hubError,
            },
            callLog: this._callLog.status(),
            services: [...this._services.values()]
                .map(service => service.status())
                .sort((a, b) => a.name.localeCompare(b.name)),
        };
    }

    /** Coalesced: fires at most once per microtask turn. */
    public onDidChangeStatus(listener: () => void): { dispose(): void; } {
        this._statusListeners.add(listener);
        return { dispose: () => this._statusListeners.delete(listener) };
    }

    /**
     * Re-read the config file and apply what changed. Without `force`, an
     * unchanged file is a no-op; with it, a hub that failed to start is retried.
     */
    public reload(options: { force?: boolean; } = {}): Promise<void> {
        return this._serialize(() => this._reload(options.force ?? false));
    }

    public restartService(name: string): Promise<void> {
        return this._service(name).restart();
    }

    /** Persist `enabled` in the config file and apply it. */
    public async setServiceEnabled(name: string, enabled: boolean): Promise<void> {
        const document = this._configFile.read();
        this._configFile.write(setServiceEnabledInText(document.text, name, enabled), document.revision);
        await this.reload();
    }

    /** Persist `callLog.level` in the config file and apply it; the hub keeps running. */
    public async setCallLogLevel(level: CallLogLevel): Promise<void> {
        const document = this._configFile.read();
        this._configFile.write(setCallLogLevelInText(document.text, level), document.revision);
        await this.reload();
    }

    public async setConfig(text: string, expectedRevision: string): Promise<string> {
        const revision = this._configFile.write(text, expectedRevision);
        await this.reload();
        return revision;
    }

    public shutdown(): Promise<void> {
        this._shutdown ??= this._doShutdown();
        return this._shutdown;
    }

    private async _start(): Promise<void> {
        this._log.line(`starting LinkRPC hub daemon ${this.version} (pid ${process.pid})`);
        this._configFile.ensureExists();
        const document = this._configFile.read();
        this._seenRevision = document.revision;
        let config: DaemonConfig;
        try {
            config = parseDaemonConfigText(document.text);
            this._appliedRevision = document.revision;
            this._appliedAt = Date.now();
        } catch (error) {
            this._configError = _message(error);
            this._log.line(`config is invalid; starting without services: ${this._configError}`);
            config = parseDaemonConfig({});
        }
        await this._serialize(() => this._apply(config));
        await this._startManagementServer();
        writePrivateJson(this.home.managementFile, this._discovery(this._management));
        this._watcher = this._configFile.watch(() => void this.reload());
        this._log.line(`ready: hub endpoint ${this._appPath}`);
    }

    private async _reload(force: boolean): Promise<void> {
        if (this._stopping) return;
        const document = this._configFile.read();
        if (!force && document.revision === this._seenRevision) return;
        this._seenRevision = document.revision;
        let config: DaemonConfig;
        try {
            config = parseDaemonConfigText(document.text);
        } catch (error) {
            this._configError = _message(error);
            this._log.line(`config is invalid; keeping the running configuration: ${this._configError}`);
            this._changed();
            return;
        }
        this._configError = undefined;
        await this._apply(config);
        this._appliedRevision = document.revision;
        this._appliedAt = Date.now();
        this._changed();
    }

    private async _apply(config: DaemonConfig): Promise<void> {
        // The call log is not a hub setting: it follows the config without a hub restart.
        this._callLog.configure(config.callLog);
        const hubKey = stableKey({ hub: config.hub, localEndpoint: config.localEndpoint });
        if (hubKey !== this._hubKey || !this._hub) {
            if (this._hub) this._log.line('hub settings changed; restarting the hub and all services');
            await this._disposeAllServices();
            const endpointSnapshot = this._endpoints?.snapshot();
            await this._endpoints?.dispose();
            this._endpoints = undefined;
            for (const [connection, registration] of this._endpointRegistrations) {
                registration?.dispose();
                this._endpointRegistrations.set(connection, undefined);
            }
            this._managementLink?.dispose();
            this._callLogAttachment?.dispose();
            this._callLogAttachment = undefined;
            this._hub?.dispose();
            this._hub = undefined;
            fs.rmSync(this.home.discoveryFile, { force: true });
            this._hubKey = hubKey;
            this._appPath = config.localEndpoint.path ?? this.home.defaultAppEndpoint;
            try {
                this._hub = await this._startHub(config);
                this._endpoints = new ManagedEndpoints({
                    file: path.join(this.home.stateDir, 'endpoints.json'),
                    servicePrefix: `${config.hub.hubServiceId}/services`,
                    consolePrefix: `${config.hub.hubServiceId}/daemon/consoles`,
                    host: this._serviceHost,
                });
                await this._endpoints.restore(endpointSnapshot);
                for (const connection of this._endpointRegistrations.keys()) {
                    this._endpointRegistrations.set(connection, this._endpoints.register(connection));
                }
                const serviceId = `${config.hub.hubServiceId}/daemon`;
                const link = this._hub.hub.attachOut({ routePrefixes: [serviceId] });
                const connection = LinkRpcConnection.fromTransport(link.transport);
                this._endpoints.register(connection, serviceId);
                connection.enableReflection({ serviceId });
                this._managementLink = { dispose: () => { connection.close(); link.dispose(); } };
                this._callLogAttachment = this._callLog.attach(this._hub.inspection, connection, serviceId);
                this._hubStartedAt = Date.now();
                this._hubError = undefined;
                writePrivateJson(this.home.discoveryFile, this._discovery({ path: this._appPath, token: config.localEndpoint.token }));
            } catch (error) {
                this._hubError = _message(error);
                this._log.line(`the hub failed to start: ${this._hubError}`);
            }
            this._changed();
        }
        const removed = [...this._services.keys()].filter(name => !Object.hasOwn(config.services, name));
        // Stop removed services first: a renamed service must release its resources (ports, devices)
        // before its successor starts.
        await Promise.all(removed.map(name => this._removeService(name)));
        await Promise.all(Object.entries(config.services).map(([name, service]) => this._applyService(name, service)));
    }

    private async _applyService(name: string, service: ManagedService): Promise<void> {
        const existing = this._services.get(name);
        if (existing) {
            const change = classifyServiceChange(existing.service, service);
            if (change === 'none') return;
            if (change === 'inPlace') {
                await existing.update(service);
                return;
            }
            this._log.line(`[${name}] configuration changed; restarting`);
            await existing.dispose();
        } else {
            this._log.line(`[${name}] added`);
        }
        const supervisor = new ServiceSupervisor(name, service, this._serviceHost, () => this._changed());
        this._services.set(name, supervisor);
        this._changed();
        await supervisor.sync();
    }

    private async _removeService(name: string): Promise<void> {
        const supervisor = this._services.get(name)!;
        this._services.delete(name);
        this._log.line(`[${name}] removed`);
        this._changed();
        await supervisor.dispose();
    }

    private async _disposeAllServices(): Promise<void> {
        const services = [...this._services.values()];
        this._services.clear();
        await Promise.all(services.map(service => service.dispose()));
        this._changed();
    }

    private _startHub({ hub: hubConfig, localEndpoint }: DaemonConfig): Promise<RunningHub> {
        const config: HubConfig = {
            ...hubConfig,
            listeners: [
                ...hubConfig.listeners,
                {
                    type: 'socket',
                    path: this._appPath,
                    handlers: [localEndpoint.token !== undefined
                        ? { token: 'static', value: localEndpoint.token }
                        : { token: 'anonymous' }],
                },
            ],
        };
        return runHub({
            config,
            log: line => this._log.line(`[hub] ${line}`),
            identityStoreDir: this.home.identityDir,
        });
    }

    private async _openServiceSocket(
        name: string,
        service: ManagedService,
        onConnectionCountChanged: (count: number) => void,
    ) {
        if (!this._hub) throw new Error('the hub is not running');
        return this._hub.openParticipantSocket({
            path: this.home.allocEndpoint(`service-${name}`),
            provision: {
                grantedServiceId: service.serviceId,
                managedIdentity: service.managedIdentity ? { slot: `service:${name}` } : undefined,
            },
            onConnectionCountChanged,
        });
    }

    private async _startManagementServer(): Promise<void> {
        const server = await SocketServer.start({
            endpoint: this._management.path,
            isTokenAccepted: async token => _tokensEqual(token, this._management.token),
        });
        server.setConnectionHandler((transport: NodeSocketTransport) => {
            const connection = LinkRpcConnection.fromTransport(transport);
            this._registerManagement(connection);
            transport.onDidClose(() => {
                this._endpointRegistrations.get(connection)?.dispose();
                this._endpointRegistrations.delete(connection);
                connection.close();
            });
        });
        this._managementServer = server;
    }

    private _registerManagement(connection: LinkRpcConnection): void {
        this._endpointRegistrations.set(connection, this._endpoints?.register(connection));
        connection.register(hubDaemonManagementInterface, {
            getStatus: () => this.status(),
            watchStatus: async (_params, _ctx, stream) => {
                await stream.send(this.status());
                const subscription = this.onDidChangeStatus(() => {
                    stream.send(this.status()).catch(() => { /* the watcher went away */ });
                });
                try {
                    await new Promise<void>(resolve => {
                        if (stream.signal.aborted) resolve();
                        else stream.signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                } finally {
                    subscription.dispose();
                }
                return {};
            },
            reloadConfig: async () => {
                await this.reload({ force: true });
                return this.status();
            },
            getConfig: () => this._configFile.read(),
            setConfig: async ({ text, expectedRevision }) => ({ revision: await this.setConfig(text, expectedRevision) }),
            setServiceEnabled: async ({ name, enabled }) => {
                await this.setServiceEnabled(name, enabled);
                return {};
            },
            restartService: async ({ name }) => {
                await this.restartService(name);
                return {};
            },
            getServiceLogs: ({ name, limit }) => ({ lines: this._service(name).logs(limit) }),
            setCallLogLevel: async ({ level }) => {
                await this.setCallLogLevel(level);
                return {};
            },
            queryCalls: async ({ filter, limit }) => {
                const { calls, truncated } = await this._callLog.query(filter ?? {}, limit);
                return { calls: [...calls], truncated };
            },
            watchCalls: async ({ filter }, _ctx, stream) => {
                const subscription = this._callLog.watch(filter ?? {}, record => {
                    stream.send(record).catch(() => { /* the watcher went away */ });
                });
                try {
                    await new Promise<void>(resolve => {
                        if (stream.signal.aborted) resolve();
                        else stream.signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                } finally {
                    subscription.dispose();
                }
                return {};
            },
            shutdown: () => {
                setTimeout(() => void this.shutdown(), 0);
                return {};
            },
        });
        connection.enableReflection();
    }

    private _service(name: string): ServiceSupervisor {
        const service = this._services.get(name);
        if (!service) throw new Error(`unknown service '${name}'`);
        return service;
    }

    private _discovery(endpoint: LocalEndpoint): EndpointDiscovery {
        return {
            version: 1,
            pid: process.pid,
            endpoint: endpoint.path,
            ...(endpoint.token !== undefined ? { token: endpoint.token } : {}),
        };
    }

    private _serialize(op: () => Promise<void>): Promise<void> {
        const run = this._reconcile.then(op);
        this._reconcile = run.catch(error => this._log.line(`reconcile failed: ${_message(error)}`));
        return run;
    }

    private _changed(): void {
        if (this._statusChangeScheduled) return;
        this._statusChangeScheduled = true;
        queueMicrotask(() => {
            this._statusChangeScheduled = false;
            for (const listener of [...this._statusListeners]) listener();
        });
    }

    private async _doShutdown(): Promise<void> {
        this._stopping = true;
        this._log.line('shutting down');
        this._watcher?.dispose();
        await this._reconcile;
        for (const file of [this.home.discoveryFile, this.home.managementFile]) {
            if (readEndpointDiscovery(file)?.pid === process.pid) fs.rmSync(file, { force: true });
        }
        await this._disposeAllServices();
        await this._endpoints?.dispose();
        this._managementLink?.dispose();
        this._callLogAttachment?.dispose();
        this._hub?.dispose();
        this._hub = undefined;
        await this._callLog.close();
        this._managementServer?.dispose();
        this._statusListeners.clear();
        this._log.line('stopped');
        await this._log.close();
        this._lock.dispose();
        this._resolveDone();
    }
}

function _ensurePrivateDirs(home: HubHome): void {
    for (const dir of [home.configDir, home.stateDir, home.runtimeDir]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== 'win32') fs.chmodSync(home.runtimeDir, 0o700);
}

function _token(): string {
    return randomBytes(32).toString('base64url');
}

function _tokensEqual(candidate: string | undefined, expected: string): boolean {
    if (candidate === undefined) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function _message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
