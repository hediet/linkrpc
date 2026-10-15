import {
    ErrorCode, LinkRpcConnection, RpcError,
    type InterfaceDeclarations, type InterfaceDefinition, type InterfaceHandlers, type InterfaceRegistration, type MemberMap,
    type RegisterOptions,
} from '@hediet/linkrpc';
import { hubFromConnection } from '@hediet/linkrpc/hub/client';
import { createManagedSigningChannel, hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import { startEndpoint, type EndpointConnection, type StartEndpointOptions, type StartedEndpoint } from '@hediet/linkrpc/node';

export type ParticipantEndpoint =
    | { readonly type: 'stdio'; }
    | { readonly type: 'fromEnv'; }
    | (Required<Pick<StartEndpointOptions, 'endpoint'>> & Pick<StartEndpointOptions, 'token'>);

export interface ParticipantHostOptions {
    /** Defaults to fromEnv. Explicit stdio ignores LINKRPC_ENDPOINT. */
    readonly endpoint?: ParticipantEndpoint;
    readonly registrationMode: 'all' | 'root' | 'grantedServiceId';
    /** Optionally claim a descendant of the granted namespace. Invalid claims reject. */
    readonly serviceId?: string;
    /** Requires a peer provisioned with the managed-identity overlay. */
    readonly managedIdentity?: boolean;
    readonly signal?: AbortSignal;
    readonly onError?: StartEndpointOptions['onError'];
    /** Called once per peer. Return cleanup for resources owned by this connection. */
    readonly setup: (
        context: ParticipantHostContext,
    ) => void | { dispose(): void } | AsyncDisposable
        | Promise<void | { dispose(): void } | AsyncDisposable>;
}

export interface ParticipantHostContext {
    readonly connection: LinkRpcConnection;
    readonly services: ParticipantServices;
    /** The claimed namespace, or undefined for root-only registration. */
    readonly serviceId: string | undefined;
    /** Aborted on peer disconnect or host shutdown, including during setup. */
    readonly signal: AbortSignal;
}

export interface ParticipantHostHandle {
    /** Resolved endpoint without credentials, including the bound listener port. */
    readonly endpoint: string;
    /** Resolves after endpoint shutdown and all per-peer cleanup. */
    readonly done: Promise<void>;
    dispose(): Promise<void>;
}

export async function hostParticipant(options: ParticipantHostOptions): Promise<ParticipantHostHandle> {
    options.signal?.throwIfAborted();
    if (options.registrationMode !== 'all' && options.registrationMode !== 'root' && options.registrationMode !== 'grantedServiceId') {
        throw new Error('registrationMode must be all, root, or grantedServiceId.');
    }
    if (options.registrationMode === 'root' && options.serviceId !== undefined) {
        throw new Error('serviceId requires all or grantedServiceId registration mode.');
    }
    const peers = new Set<ParticipantPeer>();
    const cleanupErrors: unknown[] = [];
    let endpoint: StartedEndpoint | undefined;
    let stopping = false;
    const stop = () => {
        stopping = true;
        endpoint?.dispose();
        for (const peer of peers) peer.dispose();
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    const selection = options.endpoint;
    const endpointOptions = selection === undefined || ('type' in selection && selection.type === 'fromEnv')
        ? {}
        : 'type' in selection ? { endpoint: 'stdio:' } : selection;
    try {
        endpoint = await startEndpoint({
            ...endpointOptions,
            onError: options.onError,
            onConnection: async source => {
                const peer = new ParticipantPeer(source, options);
                peers.add(peer);
                void peer.done.then(
                    () => peers.delete(peer),
                    error => {
                        cleanupErrors.push(error);
                        peers.delete(peer);
                        const report = options.onError ?? (error => process.emitWarning(error));
                        try {
                            report(error instanceof Error ? error : new Error(String(error)));
                        } catch (reportError) {
                            process.emitWarning(new Error('hostParticipant onError callback threw', { cause: reportError }));
                        }
                    },
                );
                if (stopping) peer.dispose();
                await peer.ready;
            },
        });
        if (stopping) {
            stop();
            options.signal?.throwIfAborted();
        }
    } catch (error) {
        stop();
        await Promise.allSettled([...peers].map(peer => peer.done));
        options.signal?.removeEventListener('abort', stop);
        throw error;
    }
    const done = endpoint.closed.then(async () => {
        stop();
        await Promise.allSettled([...peers].map(peer => peer.done));
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Participant cleanup failed');
    }).finally(() => options.signal?.removeEventListener('abort', stop));
    return { endpoint: endpoint.endpoint, done, dispose: () => { stop(); return done; } };
}

/** Registers each implementation at the addresses selected by the host policy. */
export class ParticipantServices {
    private readonly _registrations = new Set<InterfaceRegistration>();
    private _disposed = false;

    constructor(
        private readonly _connection: LinkRpcConnection,
        private readonly _mode: ParticipantHostOptions['registrationMode'],
        public readonly serviceId: string | undefined,
    ) {}

    public register<TDef extends InterfaceDefinition<MemberMap, InterfaceDeclarations>>(
        iface: TDef,
        handlers: InterfaceHandlers<TDef>,
        options: Omit<RegisterOptions, 'serviceId'> = {},
    ): InterfaceRegistration {
        if (this._disposed) throw new Error('Participant services are disposed');
        const registrations: InterfaceRegistration[] = [];
        try {
            if (this.serviceId !== undefined) {
                registrations.push(this._connection.register(iface, handlers, { ...options, serviceId: this.serviceId }));
            } else if (options.serviceDescription !== undefined || options.rootPrincipalSets !== undefined) {
                throw new Error('Service metadata requires a granted service ID');
            }
            if (this._mode !== 'grantedServiceId') {
                registrations.push(this._connection.register(iface, handlers));
            }
        } catch (error) {
            for (const registration of registrations) registration.dispose();
            throw error;
        }
        const registration: InterfaceRegistration = {
            dispose: () => {
                for (const item of registrations) item.dispose();
                this._registrations.delete(registration);
            },
        };
        this._registrations.add(registration);
        return registration;
    }

    public dispose(): void {
        this._disposed = true;
        for (const registration of this._registrations) registration.dispose();
    }
}

class ParticipantPeer {
    private readonly _abort = new AbortController();
    private _connection: LinkRpcConnection | undefined;
    private _services: ParticipantServices | undefined;
    private _setupResult: Awaited<ReturnType<ParticipantHostOptions['setup']>> = undefined;
    public readonly ready: Promise<void>;
    public readonly done: Promise<void>;

    constructor(
        private readonly _source: EndpointConnection,
        private readonly _options: ParticipantHostOptions,
    ) {
        this.ready = Promise.resolve().then(() => this._setup());
        this.done = _source.closed.then(async () => {
            this._abort.abort();
            try {
                await this.ready;
            } catch {
                // Startup errors are propagated by onConnection; cleanup still runs.
            }
            try {
                if (this._setupResult && Symbol.asyncDispose in this._setupResult) {
                    await this._setupResult[Symbol.asyncDispose]();
                } else if (this._setupResult) {
                    this._setupResult.dispose();
                }
            } finally {
                this._services?.dispose();
                this._connection?.close();
            }
        });
    }

    public dispose(): void {
        this._abort.abort();
        this._source.dispose();
    }

    private async _setup(): Promise<void> {
        try {
            this._abort.signal.throwIfAborted();
            // A participant does not grant namespaces. Let peer discovery receive
            // method-not-found even when both peers are still bootstrapping.
            this._source.resumeRequests([`${hubGrantedServiceIdInterface.info.id}::get`]);
            const channel = this._options.managedIdentity
                ? (await createManagedSigningChannel(this._source.channel)).channel
                : this._source.channel;
            const connection = this._connection = new LinkRpcConnection(channel);
            const serviceId = await this._claimNamespace(connection);
            this._abort.signal.throwIfAborted();
            const services = this._services = new ParticipantServices(connection, this._options.registrationMode, serviceId);
            this._setupResult = await this._options.setup({
                connection, services, serviceId, signal: this._abort.signal,
            });
            this._abort.signal.throwIfAborted();
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    private async _claimNamespace(connection: LinkRpcConnection): Promise<string | undefined> {
        if (this._options.registrationMode === 'root') return undefined;
        const hub = hubFromConnection(connection);
        let grant: string | undefined;
        try {
            grant = (await hub.getConnectionInfo()).grantedServiceIdNamespace || undefined;
        } catch (error) {
            if (!(error instanceof RpcError && error.origin === 'remote' && error.code === ErrorCode.methodNotFound)) {
                throw error;
            }
        }
        this._abort.signal.throwIfAborted();
        if (grant === undefined) {
            if (this._options.registrationMode === 'grantedServiceId' || this._options.serviceId !== undefined) {
                throw new Error('Peer did not grant a service ID namespace');
            }
            return undefined;
        }
        const serviceId = this._options.serviceId ?? grant;
        if (serviceId !== grant && !serviceId.startsWith(`${grant}/`)) {
            throw new Error(`Requested serviceId "${serviceId}" is outside the hub-granted namespace "${grant}"`);
        }
        await hub.registerServiceIdNamespace(serviceId);
        return serviceId;
    }
}
