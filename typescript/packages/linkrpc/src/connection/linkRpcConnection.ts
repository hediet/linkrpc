import { ErrorCode, type JsonRpcMessage, type JsonValue } from '../protocol/jsonRpc';
import { parseMethodName } from '../protocol/methodName';
import { stripLinkRpcWireMeta } from '../protocol/linkRpcEnvelope';
import {
    defaultsInterface,
    directoryInterface,
    schemasInterface,
    type RootPrincipalSet,
    type ServiceIdPattern,
} from '../hub/common/reflection.interfaces';
import { serviceIdMatchesScopes } from '../hub/common/directoryWalk';
import { nodeInterface, type NodeInfo, type TopologyIdGenerator } from '../inspection/node.interfaces';
import {
    topologyInterface,
    trafficInterface,
    type TopologyGraph,
    type ParticipantDescriptorSource,
    type TrafficEvent,
    type TrafficTransitEvent,
    type TrafficWatchResult,
} from '../inspection/inspection.interfaces';
import type {
    InterfaceClient,
    InterfaceDefinition,
    InterfaceHandlers,
    StreamApi,
} from './interfaceDefinition';
import { type MemberType, NotificationType, RequestType } from '../schema/memberTypes';
import { safeParse } from 'zod/v4/core';
import type { IMessageTransport } from '../transport/messageTransport';
import {
    Channel,
    type MessageWithCtx,
    type IncomingCall,
    type IncomingStream,
    type IRequestSender, type Result,
    RpcError,
    type StreamSendOpts,
} from './channel';
import { JsonRpcChannel } from './jsonRpcChannel';
import { bytesToBase64Url } from '../crypto/cryptoProvider';
import {
    EndpointTrafficInspector,
    type EndpointTrafficWatchOptions,
} from '../inspection/endpointTrafficInspector';
import {
    isBareInterfaceTarget,
    validateBarePrefix,
    type BareInterfaceTarget,
} from './bareInterfaceTarget';

export interface LinkRpcConnectionOptions {
    /** Topology node/port ID generator. Defaults to cryptographic randomness. */
    readonly generateTopologyId?: TopologyIdGenerator;
    /**
     * Validate parameters passed through typed interface clients before sending
     * them. Enabled by default. Disable only when interoperating with a peer
     * whose accepted wire shape intentionally differs from the local schema.
     */
    readonly validateOutboundParams?: boolean;
}

/**
 * High-level linkrpc connection. Layers method-name routing and zod-driven
 * validation on top of a plain JSON-RPC channel.
 *
 * Typed proxies built by this class merely forward each call's
 * `interfaceHash` hint to the channel so the signer stamps it into the
 * `$hubrpc` envelope.
 *
 * `TInCtx` is the per-call out-of-band context the connection's transport
 * carries. Default `undefined` covers cross-process and ordinary in-process
 * transports. The hub's self/overlay connections instantiate with a
 * concrete `TInCtx` (e.g. `Participant`) so handlers can see who originated
 * the call.
 *
 * `TOutCtx` is the per-call override / extension bag the outbound sender
 * understands (see {@link SendOpts.ctx}). It only ever flows into the
 * sender as input, so it is a contravariant type parameter. Default `any`
 * keeps the bare `LinkRpcConnection` a valid supertype for holders that do
 * not care about the outbound ctx; pass a concrete shape (e.g.
 * `SigningCallCtx`) to get precise {@link get} typing. The connection
 * itself is agnostic to its contents — it merely forwards the `ctx`
 * defaults supplied to {@link get}.
 */
export class LinkRpcConnection<TInCtx = any, TOutCtx = any> {
    /**
     * Convenience: build a {@link JsonRpcChannel} `Channel` from the
     * given transport and wrap it in an `LinkRpcConnection`. Use this
     * when you have a transport at hand and don't need a decorator
     * stack (e.g. signing).
     */
    public static fromTransport<TInCtx = undefined>(
        transport: IMessageTransport<MessageWithCtx<TInCtx>, JsonRpcMessage>,
        options: LinkRpcConnectionOptions = {},
    ): LinkRpcConnection<TInCtx> {
        return new LinkRpcConnection<TInCtx>(JsonRpcChannel.create<TInCtx>(transport), options);
    }

    /** Underlying JSON-RPC sender — useful for callers that need raw access (e.g. to call hub-served methods that bypass the interface registry). */
    public readonly channel: IRequestSender<TOutCtx>;

    /** key = `${serviceId ?? ""}::${interfaceId}` */
    private readonly _registry = new Map<string, RegisteredInterface>();

    /** Descriptions for services that have been registered with a `serviceDescription`. */
    private readonly _serviceDescriptions = new Map<string, string>();

    /** Root-node-id requirement sets recorded per serviceId. */
    private readonly _serviceRootPrincipalSets = new Map<string, readonly RootPrincipalSet[]>();

    private readonly _directoryWatchers = new Set<DirectoryWatcher>();
    private readonly _directoryListeners = new Set<() => void>();

    private _inspection: InspectionRegistration | undefined;
    private _trafficInspector: EndpointTrafficInspector | undefined;
    private readonly _serviceInspectionRegistrations = new Map<string, InterfaceRegistration[]>();
    private readonly _wireChannel: Channel<TInCtx, TOutCtx> | undefined;
    private readonly _validateOutboundParams: boolean;
    /** Bare-method bindings, keyed by their exact wire prefix. */
    private readonly _bareBindings = new Map<string, BareBinding>();
    private readonly _generateTopologyId: TopologyIdGenerator;

    /**
     * Construct from a {@link Channel} (binds the inbound handler and uses
     * `channel.sender` for outbound calls) or from a bare
     * {@link IRequestSender} (send-only — no inbound handler is registered,
     * useful for bootstrap flows like `createManagedIdentity`).
     */
    constructor(
        channel: Channel<TInCtx, TOutCtx> | IRequestSender<TOutCtx>,
        options: LinkRpcConnectionOptions = {},
    ) {
        this._validateOutboundParams = options.validateOutboundParams !== false;
        this._generateTopologyId = options.generateTopologyId ?? createInspectionId;
        if ('sender' in channel) {
            this._wireChannel = channel;
            this.channel = channel.sender;
            channel.setRequestHandler({
                handleRequest: (c) => this._handleRequest(c),
                handleNotification: (c) => this._handleNotification(c),
            });
        } else {
            this._wireChannel = undefined;
            this.channel = channel;
        }
    }

    /** Get a typed metadata-free client for a bundled bare interface target. */
    public get<TDef extends InterfaceDefinition<any>>(
        target: BareInterfaceTarget<TDef>,
    ): InterfaceClient<TDef>;

    /** Get a typed client for `iface`, routed to the implicit (root) service. */
    public get<TDef extends InterfaceDefinition<any>>(
        iface: TDef,
        opts?: GetOptions<TOutCtx>,
    ): InterfaceClient<TDef>;

    public get<TDef extends InterfaceDefinition<any>>(
        ifaceOrTarget: TDef | BareInterfaceTarget<TDef>,
        opts?: GetOptions<TOutCtx>,
    ): InterfaceClient<TDef> {
        if (isBareInterfaceTarget(ifaceOrTarget)) {
            if (opts !== undefined) {
                throw new Error('get: bare interface targets do not accept service or call options.');
            }
            return this.getBare(ifaceOrTarget.interface, {
                prefix: ifaceOrTarget.prefix,
            });
        }
        return this._buildClient(ifaceOrTarget, opts ?? {}) as InterfaceClient<TDef>;
    }

    /**
     * Get a typed client that emits foreign-protocol bare method names.
     * Unlike {@link get}, these calls carry no LinkRPC interface metadata.
     */
    public getBare<TDef extends InterfaceDefinition<any>>(
        iface: TDef,
        opts: BareGetOptions = {},
    ): InterfaceClient<TDef> {
        const prefix = opts.prefix ?? '';
        validateBarePrefix(prefix, 'getBare');
        for (const [name, member] of Object.entries(iface.members)) {
            if (
                member instanceof RequestType
                && (member.clientStreamSchema !== undefined || member.serverStreamSchema !== undefined)
            ) {
                throw new Error(`getBare: streaming method "${name}" is not supported on foreign wires.`);
            }
        }
        return this._buildBareClient(iface, prefix) as InterfaceClient<TDef>;
    }

    /** Get a service-scoped handle; all interfaces obtained from it route via `serviceId` (form 3). */
    public service(serviceId: string): ServiceHandle<TInCtx, TOutCtx> {
        return new ServiceHandle<TInCtx, TOutCtx>(this, serviceId);
    }

    /** Register handlers for an interface on this connection's server side. */
    public register<TDef extends InterfaceDefinition<any>>(
        iface: TDef,
        handlers: InterfaceHandlers<TDef, TInCtx>,
        opts: RegisterOptions = {},
    ): InterfaceRegistration {
        return this._register(iface, handlers, opts, false);
    }

    private _register<TDef extends InterfaceDefinition<any>>(
        iface: TDef,
        handlers: InterfaceHandlers<TDef, TInCtx>,
        opts: RegisterOptions,
        internalInspection: boolean,
    ): InterfaceRegistration {
        const serviceId = opts.serviceId;
        const key = `${serviceId ?? ''}::${iface.info.id}`;
        if (this._registry.has(key)) {
            throw new Error(
                `Interface "${iface.info.id}" already registered${serviceId ? ` under service "${serviceId}"` : ''}.`,
            );
        }

        let serviceMetadataChanged = false;
        if (opts.serviceDescription !== undefined) {
            if (serviceId === undefined) {
                throw new Error('register: `serviceDescription` requires `serviceId`.');
            }
            const existing = this._serviceDescriptions.get(serviceId);
            if (existing !== undefined && existing !== opts.serviceDescription) {
                throw new Error(
                    `register: conflicting descriptions for service "${serviceId}".`,
                );
            }
            this._serviceDescriptions.set(serviceId, opts.serviceDescription);
            serviceMetadataChanged = existing === undefined;
        }

        if (opts.rootPrincipalSets !== undefined) {
            if (serviceId === undefined) {
                throw new Error('register: `rootPrincipalSets` requires `serviceId`.');
            }
            const existing = this._serviceRootPrincipalSets.get(serviceId);
            if (existing !== undefined && !rootPrincipalSetsEqual(existing, opts.rootPrincipalSets)) {
                throw new Error(
                    `register: conflicting rootPrincipalSets for service "${serviceId}".`,
                );
            }
            this._serviceRootPrincipalSets.set(serviceId, opts.rootPrincipalSets);
            serviceMetadataChanged ||= existing === undefined;
        }

        const entry: RegisteredInterface = {
            iface,
            handlers: handlers as Record<string, (p: any, c: any) => any>,
            serviceId,
            internalInspection,
        };
        this._registry.set(key, entry);
        this._notifyDirectoryWatchers(entry, serviceMetadataChanged);

        if (
            !internalInspection
            && serviceId !== undefined
            && this._inspection !== undefined
            && !this._serviceInspectionRegistrations.has(serviceId)
        ) {
            try {
                this._installServiceInspection(serviceId);
            } catch (error) {
                this._registry.delete(key);
                this._notifyDirectoryWatchers(entry);
                throw error;
            }
        }

        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                if (this._registry.get(key) !== entry) return;

                this._registry.delete(key);
                for (const [prefix, binding] of this._bareBindings) {
                    if (binding.entry === entry) this._bareBindings.delete(prefix);
                }
                this._notifyDirectoryWatchers(entry);
                if (
                    serviceId !== undefined
                    && !this._hasBusinessServiceRegistration(serviceId)
                ) {
                    this._removeServiceInspection(serviceId);
                    this._serviceDescriptions.delete(serviceId);
                    this._serviceRootPrincipalSets.delete(serviceId);
                }
            },
        };
    }

    /**
     * Declare the preset interface for form-1 (bare-method) dispatch. The
     * interface must already be registered under the root (no serviceId).
     * Surfaced via `hubrpc.defaults::get`.
     */
    public setPreset(iface: InterfaceDefinition<any>): void {
        const key = `::${iface.info.id}`;
        const entry = this._registry.get(key);
        if (!entry) {
            throw new Error(`setPreset: interface "${iface.info.id}" is not registered under the root service.`);
        }
        // The preset and an explicit empty-prefix binding intentionally share
        // one slot. Legacy setPreset replacement semantics win deterministically.
        this._bareBindings.set('', { prefix: '', entry });
    }

    /**
     * Bind foreign-protocol bare methods to an already registered interface.
     * Matching uses the longest prefix; once selected, a missing member does
     * not fall through to a shorter binding.
     */
    public bindBare(
        iface: InterfaceDefinition<any>,
        opts: { prefix: string; serviceId?: string; },
    ): InterfaceRegistration {
        validateBarePrefix(opts.prefix, 'bindBare');
        const key = `${opts.serviceId ?? ''}::${iface.info.id}`;
        const entry = this._registry.get(key);
        if (!entry) {
            throw new Error(
                `bindBare: interface "${iface.info.id}" is not registered`
                + (opts.serviceId === undefined ? ' under the root service.' : ` under service "${opts.serviceId}".`),
            );
        }
        if (this._bareBindings.has(opts.prefix)) {
            throw new Error(`bindBare: prefix "${opts.prefix}" is already bound.`);
        }
        const binding: BareBinding = { prefix: opts.prefix, entry };
        this._bareBindings.set(opts.prefix, binding);
        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                if (this._bareBindings.get(opts.prefix) === binding) {
                    this._bareBindings.delete(opts.prefix);
                }
            },
        };
    }

    /** Snapshot of every interface currently registered on this connection. */
    public listRegisteredInterfaces(): readonly {
        readonly serviceId: string;
        readonly interfaceId: string;
        readonly interfaceHash: string;
        readonly serviceDescription?: string;
        readonly rootPrincipalSets?: readonly RootPrincipalSet[];
    }[] {
        return Array.from(this._registry.values()).map((r) => {
            const sid = r.serviceId ?? '';
            const item: {
                serviceId: string;
                interfaceId: string;
                interfaceHash: string;
                serviceDescription?: string;
                rootPrincipalSets?: readonly RootPrincipalSet[];
            } = {
                serviceId: sid,
                interfaceId: r.iface.info.id,
                interfaceHash: r.iface.schemaHash,
            };
            const desc = sid === '' ? undefined : this._serviceDescriptions.get(sid);
            if (desc !== undefined) item.serviceDescription = desc;
            const sets = sid === '' ? undefined : this._serviceRootPrincipalSets.get(sid);
            if (sets !== undefined) item.rootPrincipalSets = sets;
            return item;
        });
    }

    /** Subscribe to coarse local directory changes; listeners must re-list. */
    public onDidChangeDirectory(listener: () => void): () => void {
        this._directoryListeners.add(listener);
        return () => this._directoryListeners.delete(listener);
    }

    /**
     * Look up a registered interface definition by id (and optional content
     * hash). Returns `undefined` if no registered interface matches.
     */
    public findRegisteredInterface(
        interfaceId: string,
        hash?: string,
    ): InterfaceDefinition<any> | undefined {
        for (const r of this._registry.values()) {
            if (r.iface.info.id !== interfaceId) continue;
            if (hash !== undefined && r.iface.schemaHash !== hash) continue;
            return r.iface;
        }
        return undefined;
    }

    /**
     * Register the three linkrpc reflection interfaces (`defaults`,
     * `directory`, `schemas`), backed by this connection's live registry.
     *
     * By default they live under the root service (form-2 reachable as
     * `hubrpc.directory::list`). Pass `serviceId` to additionally mount
     * them under a specific service — useful for participants that live
     * behind a hub, so callers can reach reflection via form-3
     * `<serviceId>::hubrpc.directory::list`.
     *
     * Idempotent: re-registering the same `(serviceId, interfaceId)` pair
     * is a no-op.
     */
    public enableReflection(opts: { serviceId?: string; } = {}): InterfaceRegistration {
        const key = `${opts.serviceId ?? ''}::${defaultsInterface.info.id}`;
        if (this._registry.has(key)) return { dispose() { } };
        const prefix = `${opts.serviceId ?? ''}::`;
        for (const iface of [directoryInterface, schemasInterface]) {
            if (this._registry.has(`${prefix}${iface.info.id}`)) {
                throw new Error(
                    `enableReflection: partial reflection registration for service "${opts.serviceId ?? ''}".`,
                );
            }
        }

        const regOpts: RegisterOptions = opts.serviceId !== undefined ?
            { serviceId: opts.serviceId } :
            {};
        const registrations: InterfaceRegistration[] = [];

        registrations.push(this.register(defaultsInterface, {
            get: () => {
                const binding = this._bareBindings.get('');
                if (!binding) return {};
                return {
                    serviceId: binding.entry.serviceId,
                    interfaceId: binding.entry.iface.info.id,
                    interfaceHash: binding.entry.iface.schemaHash,
                };
            },
            listBindings: () => ({
                bindings: Array.from(this._bareBindings.values())
                    .sort((a, b) => a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0)
                    .map((binding) => ({
                        prefix: binding.prefix,
                        serviceId: binding.entry.serviceId,
                        interfaceId: binding.entry.iface.info.id,
                        interfaceHash: binding.entry.iface.schemaHash,
                    })),
            }),
        }, regOpts));

        registrations.push(this.register(directoryInterface, {
            list: ({ interfaceId, interfaceIdPrefix, serviceId, serviceIdScopes, cursor, limit }) => {
                const all = this.listRegisteredInterfaces()
                    .filter((r) => opts.serviceId === undefined || r.serviceId === opts.serviceId)
                    .filter((r) => interfaceId === undefined || r.interfaceId === interfaceId)
                    .filter((r) => interfaceIdPrefix === undefined || r.interfaceId.startsWith(interfaceIdPrefix))
                    .filter((r) => serviceId === undefined || r.serviceId === serviceId)
                    .filter((r) => serviceIdMatchesScopes(r.serviceId, serviceIdScopes));
                const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
                const end = limit === undefined ? all.length : Math.min(all.length, start + limit);
                const page = all.slice(start, end).map((r) => ({
                    serviceId: r.serviceId,
                    interfaceId: r.interfaceId,
                    interfaceHash: r.interfaceHash,
                    serviceDescription: r.serviceDescription,
                    rootPrincipalSets: r.rootPrincipalSets?.map((set) => set.map((p) => ({ ...p }))),
                }));
                return end < all.length ?
                    { items: page, nextCursor: String(end) } :
                    { items: page };
            },
            watch: (params, _ctx, stream) => new Promise((resolve) => {
                const watcher: DirectoryWatcher = {
                    interfaceId: params.interfaceId,
                    interfaceIdPrefix: params.interfaceIdPrefix,
                    serviceId: params.serviceId,
                    serviceIdScopes: params.serviceIdScopes,
                    send: () => stream.send({}),
                };
                this._directoryWatchers.add(watcher);
                const finish = () => {
                    this._directoryWatchers.delete(watcher);
                    resolve({});
                };
                if (stream.signal.aborted) {
                    finish();
                    return;
                }
                stream.signal.addEventListener('abort', finish, { once: true });
            }),
        }, regOpts));

        registrations.push(this.register(schemasInterface, {
            get: ({ interfaceId, hash }) => {
                const iface = this.findRegisteredInterface(interfaceId, hash);
                if (!iface) {
                    throw new RpcError(
                        'Interface not found',
                        ErrorCode.methodNotFound,
                        { reason: 'unknown-interface', interfaceId, hash },
                    );
                }
                return { schema: iface.toSchema() as unknown };
            },
        }, regOpts));

        // A service-scoped reflection set is *also* surfaced at the connection
        // root, so a hub that reads this connection's root directory
        // (`H·root → P`) discovers its `<serviceId>::hubrpc.directory` referral
        // without reaching the (capability-gated) service directory. Keyed
        // separately and guarded above, so the recursive root call is a no-op
        // once root reflection exists.
        if (opts.serviceId !== undefined) {
            try {
                this.enableReflection();
            } catch (error) {
                for (const registration of registrations.reverse()) {
                    registration.dispose();
                }
                throw error;
            }
        }

        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                for (const registration of registrations.reverse()) {
                    registration.dispose();
                }
            },
        };
    }

    private _notifyDirectoryWatchers(
        entry: RegisteredInterface,
        serviceMetadataChanged = false,
    ): void {
        for (const listener of this._directoryListeners) {
            try {
                listener();
            } catch {
                // Directory invalidation observers cannot interrupt registry mutations.
            }
        }
        for (const watcher of this._directoryWatchers) {
            if (watcher.pending) continue;
            const directlyMatches = directoryWatcherMatchesEntry(watcher, entry);
            const metadataMatches = serviceMetadataChanged
                && entry.serviceId !== undefined
                && [...this._registry.values()].some((candidate) =>
                    candidate.serviceId === entry.serviceId
                    && directoryWatcherMatchesEntry(watcher, candidate));
            if (!directlyMatches && !metadataMatches) continue;
            watcher.pending = true;
            queueMicrotask(() => {
                watcher.pending = false;
                if (this._directoryWatchers.has(watcher)) watcher.send();
            });
        }
    }

    /**
     * Enable the root `hubrpc.node::getNodeId` topology-bootstrap service.
     *
     * The generated ids are stable while this registration is active. They are
     * unauthenticated correlation labels only; callers must not use them for
     * identity, capability, or authorization decisions.
     */
    public enableInspection(
        descriptors?: readonly ParticipantDescriptorSource[],
    ): InspectionRegistration {
        if (this._inspection !== undefined) return this._inspection;

        const info: NodeInfo = {
            nodeId: this._generateTopologyId('node'),
            portId: this._generateTopologyId('port'),
            ...(descriptors !== undefined ? { descriptors: [...descriptors] } : {}),
        };
        const registration = this._register(nodeInterface, {
            getNodeId: () => info,
        }, {}, true);

        const trafficInspector = new EndpointTrafficInspector(
            info.nodeId,
            info.portId,
            (active) => this._wireChannel?.setWireMessageObserver(
                active ? trafficInspector.observe : undefined,
            ),
        );
        this._trafficInspector = trafficInspector;
        trafficInspector.start();

        let disposed = false;
        const result: InspectionRegistration = {
            ...info,
            observeTraffic: (observer) => trafficInspector.observeTransits(observer),
            dispose: () => {
                if (disposed) return;
                disposed = true;
                for (const serviceId of [...this._serviceInspectionRegistrations.keys()]) {
                    this._removeServiceInspection(serviceId);
                }
                trafficInspector.dispose();
                if (this._trafficInspector === trafficInspector) {
                    this._trafficInspector = undefined;
                }
                registration.dispose();
                if (this._inspection === result) {
                    this._inspection = undefined;
                }
            },
        };
        this._inspection = result;
        try {
            const services = new Set(
                Array.from(this._registry.values())
                    .filter((entry) =>
                        entry.serviceId !== undefined && !entry.internalInspection)
                    .map((entry) => entry.serviceId!),
            );
            for (const serviceId of services) this._installServiceInspection(serviceId);
        } catch (error) {
            result.dispose();
            throw error;
        }
        return result;
    }

    /** Number of active endpoint traffic stream subscribers. */
    public get trafficObserverCount(): number {
        return this._trafficInspector?.observerCount ?? 0;
    }

    public close(): void {
        this.channel.close();
    }

    // ---- client side ----

    private _buildClient(
        iface: InterfaceDefinition<any>,
        opts: GetOptions<TOutCtx>,
    ): Record<string, (params: any) => any> {
        const { serviceId, ...ctxRest } = opts;
        const baseCtx = ctxRest as unknown as TOutCtx;
        const interfaceHash = iface.schemaHash;
        const proxy: Record<string, (p: any) => any> = {};
        for (const [name, member] of Object.entries(iface.members) as [string, MemberType][]) {
            const wireMethod = serviceId ?
                `${serviceId}::${iface.info.id}::${name}` :
                `${iface.info.id}::${name}`;

            if (member.kind === 'request') {
                const hasStream = member.clientStreamSchema !== undefined ||
                    member.serverStreamSchema !== undefined;

                if (hasStream) {
                    // Streaming-enabled call. Returns a Promise<R> augmented
                    // with `send`. `requestId` resolves once the request has
                    // been allocated by the channel; `send` defers until
                    // then so callers can emit client-stream messages
                    // synchronously after the call returns.
                    const serverStreamSchema = member.serverStreamSchema;
                    proxy[name] = (
                        params: unknown,
                        callOpts?: { onMessage?: (m: unknown) => void; },
                    ) => {
                        const userListener = callOpts?.onMessage;
                        // Symmetric with the server-side handler: parse
                        // inbound stream payloads against the declared
                        // schema and drop anything that doesn't match.
                        // The handler always sees validated data.
                        const onStreamMessage = userListener !== undefined ?
                            (raw: JsonValue) => {
                                if (serverStreamSchema !== undefined) {
                                    const r = safeParse(serverStreamSchema, raw);
                                    if (!r.success) return;
                                    userListener(r.data);
                                    return;
                                }
                                userListener(raw);
                            } :
                            undefined;

                        const channelOpts: StreamSendOpts<TOutCtx> = onStreamMessage !== undefined ?
                            { ctx: baseCtx, interfaceHash, onStreamMessage } :
                            { ctx: baseCtx, interfaceHash };
                        this._validateOutboundParamsFor(member, wireMethod, params);
                        const call = this.channel.sendRequestWithStream(
                            wireMethod,
                            params as JsonValue | undefined,
                            channelOpts,
                        );
                        const result = call.result.then((raw) => {
                            const checked = safeParse(
                                (member as RequestType).resultSchema,
                                raw === null ? undefined : raw,
                            );
                            if (!checked.success) {
                                throw new RpcError(
                                    `Invalid result for ${wireMethod}`,
                                    ErrorCode.internalError,
                                    { issues: checked.error.issues as unknown as JsonValue },
                                );
                            }
                            return raw;
                        });

                        return Object.assign(result, {
                            send: async (payload: unknown) => call.send(payload as JsonValue),
                            cancel: async (reason?: string) => call.cancel(reason),
                            dispose: (reason?: string) => call.dispose?.(reason),
                            ping: () => call.ping(),
                        });
                    };
                } else {
                    const resultSchema = (member as RequestType).resultSchema;
                    proxy[name] = async (params: unknown) => {
                        const sendOpts = { ctx: baseCtx, interfaceHash };
                        this._validateOutboundParamsFor(member, wireMethod, params);
                        const raw = await this.channel.sendRequest(
                            wireMethod,
                            params as JsonValue | undefined,
                            sendOpts,
                        );
                        // Client-side result data validation: the peer might be
                        // a foreign / older server that never validated its own
                        // output, so verify the declared `resultSchema` here too.
                        // Validate as a gate (return `raw` unchanged on success);
                        // a wire `null` maps to `undefined` for the check, matching
                        // the server's `undefined → null` void convention.
                        const checked = safeParse(resultSchema, raw === null ? undefined : raw);
                        if (!checked.success) {
                            throw new RpcError(
                                `Invalid result for ${wireMethod}`,
                                ErrorCode.internalError,
                                { issues: checked.error.issues as unknown as JsonValue },
                            );
                        }
                        return raw;
                    };
                }
            } else {
                proxy[name] = async (params: unknown) => {
                    const sendOpts = { ctx: baseCtx, interfaceHash };
                    this._validateOutboundParamsFor(member, wireMethod, params);
                    void this.channel.sendNotification(
                        wireMethod,
                        params as JsonValue | undefined,
                        sendOpts,
                    );
                };
            }
        }
        return proxy;
    }

    private _buildBareClient(
        iface: InterfaceDefinition<any>,
        prefix: string,
    ): Record<string, (params: any) => any> {
        const proxy: Record<string, (params: any) => any> = {};
        for (const [name, member] of Object.entries(iface.members) as [string, MemberType][]) {
            const wireMethod = `${prefix}${name}`;
            if (member instanceof RequestType) {
                proxy[name] = async (params: unknown) => {
                    this._validateOutboundParamsFor(member, wireMethod, params);
                    const raw = await this.channel.sendRequest(
                        wireMethod,
                        params as JsonValue | undefined,
                    );
                    const validationValue = raw === null && isVoidResultSchema(member.resultSchema)
                        ? undefined
                        : raw;
                    const checked = safeParse(member.resultSchema, validationValue);
                    if (!checked.success) {
                        throw new RpcError(
                            `Invalid result for ${wireMethod}`,
                            ErrorCode.internalError,
                            { issues: checked.error.issues as unknown as JsonValue },
                        );
                    }
                    return validationValue;
                };
            } else {
                proxy[name] = (params: unknown) => {
                    this._validateOutboundParamsFor(member, wireMethod, params);
                    void this.channel.sendNotification(
                        wireMethod,
                        params as JsonValue | undefined,
                    );
                };
            }
        }
        return proxy;
    }

    private _validateOutboundParamsFor(
        member: MemberType,
        wireMethod: string,
        params: unknown,
    ): void {
        if (!this._validateOutboundParams) return;
        const checked = safeParse(member.paramsSchema, params);
        if (checked.success) return;
        throw new RpcError(
            `Invalid params for ${wireMethod}`,
            ErrorCode.invalidParams,
            { issues: checked.error.issues as unknown as JsonValue },
        );
    }

    // ---- server side ----

    private async _handleRequest(call: IncomingCall<TInCtx>): Promise<Result> {
        const parsed = this._parseRouted(call.method);
        if (!parsed.ok) return notFound(parsed.reason, call.method);

        const { entry, memberName } = parsed;
        const member = entry.iface.members[memberName];
        if (!member) return notFound('unknown-method', call.method);

        const handler = entry.handlers[memberName] as
            | ((params: unknown, ctx: TInCtx, stream: StreamApi<unknown, unknown>) => unknown)
            | undefined;
        if (!handler) return notFound('unknown-method', call.method);

        // Keep call.params intact for chained-hub verification and transport
        // middleware; only the terminal application-schema view is stripped.
        const userParams = stripLinkRpcWireMeta(call.params);
        const parsedParams = safeParse((member as MemberType).paramsSchema, userParams);
        if (!parsedParams.success) {
            return {
                error: {
                    code: ErrorCode.invalidParams,
                    message: 'Invalid params',
                    data: { issues: parsedParams.error.issues as unknown as JsonValue },
                },
            };
        }

        if (!(member instanceof RequestType)) {
            // Caller used request semantics on a notification-only method.
            return notFound('unknown-method', call.method);
        }

        const stream = this._buildStreamApi(call.stream, call.signal, member);
        try {
            const pendingResult = handler(parsedParams.data, call.context, stream);
            const result = await pendingResult;
            // Result data validation: a handler must return what its declared
            // `resultSchema` promises. Symmetric with the inbound `paramsSchema`
            // check above (and the stream-payload checks) — without it, result
            // schemas are compile-time only and a buggy handler ships malformed
            // data that blows up deep in the caller. On a mismatch we fail the
            // call with `internalError` (the fault is the callee's, not the
            // caller's). Conformant results are sent unchanged (we validate as a
            // gate, not to strip), so extra keys behave exactly as before.
            const checked = safeParse((member as RequestType).resultSchema, result);
            if (!checked.success) {
                return {
                    error: {
                        code: ErrorCode.internalError,
                        message: `Invalid result for ${call.method}`,
                        data: { issues: checked.error.issues as unknown as JsonValue },
                    },
                };
            }
            return { result: result === undefined ? null : (result as JsonValue) };
        } catch (e) {
            if (e instanceof RpcError) {
                return { error: { code: e.code, message: e.message, data: e.data } };
            }
            return {
                error: {
                    code: ErrorCode.internalError,
                    message: e instanceof Error ? e.message : String(e),
                },
            };
        }
        // Inbound stream listener is auto-detached by JsonRpcChannel when
        // the handler's response settles — no manual unregister needed.
    }

    private _buildStreamApi(
        callStream: IncomingStream,
        signal: AbortSignal,
        member: RequestType<unknown, unknown, unknown, unknown, unknown>,
    ): StreamApi<unknown, unknown> {
        return {
            send: (payload: unknown) => {
                if (member.serverStreamSchema) {
                    const r = safeParse(member.serverStreamSchema, payload);
                    if (!r.success) {
                        throw new Error(
                            `Server stream payload failed schema validation: ${r.error.message}`,
                        );
                    }
                }
                return callStream.send(payload as JsonValue);
            },
            onMessage: (listener: (payload: unknown) => void) => {
                callStream.onMessage((raw) => {
                    if (member.clientStreamSchema) {
                        const r = safeParse(member.clientStreamSchema, raw);
                        if (!r.success) return; // drop invalid client stream payload
                        listener(r.data);
                        return;
                    }
                    // No declared client stream schema => the method does
                    // not accept client-emitted stream messages. Drop.
                });
            },
            ping: () => callStream.ping(),
            signal,
        };
    }

    private _handleNotification(call: IncomingCall<TInCtx>): void {
        const parsed = this._parseRouted(call.method);
        if (!parsed.ok) return;
        const { entry, memberName } = parsed;
        const member = entry.iface.members[memberName];
        if (!(member instanceof NotificationType)) return;
        const handler = entry.handlers[memberName] as
            | ((params: unknown, ctx: TInCtx) => unknown)
            | undefined;
        if (!handler) return;

        const userParams = stripLinkRpcWireMeta(call.params);
        const parsedParams = safeParse(member.paramsSchema, userParams);
        if (!parsedParams.success) return;
        void handler(parsedParams.data, call.context);
    }

    private _parseRouted(method: string):
        | { ok: true; entry: RegisteredInterface; memberName: string; }
        | { ok: false; reason: string; } {
        const parsed = parseMethodName(method);
        if (!parsed) return { ok: false, reason: 'bad-method-grammar' };

        if (parsed.kind === 'bare') {
            let selected: BareBinding | undefined;
            for (const binding of this._bareBindings.values()) {
                if (
                    parsed.member.startsWith(binding.prefix)
                    && (selected === undefined || binding.prefix.length > selected.prefix.length)
                ) {
                    selected = binding;
                }
            }
            if (!selected) return { ok: false, reason: 'no-preset' };
            return {
                ok: true,
                entry: selected.entry,
                memberName: parsed.member.slice(selected.prefix.length),
            };
        }

        const serviceId = parsed.kind === 'full' ? parsed.serviceId : undefined;
        const key = `${serviceId ?? ''}::${parsed.interfaceId}`;
        const entry = this._registry.get(key);
        if (!entry) {
            return {
                ok: false,
                reason: serviceId ? 'unknown-service' : 'unknown-interface',
            };
        }
        return { ok: true, entry, memberName: parsed.member };
    }

    private _installServiceInspection(serviceId: string): void {
        if (this._serviceInspectionRegistrations.has(serviceId)) return;
        const info = this._inspection;
        const trafficInspector = this._trafficInspector;
        if (info === undefined || trafficInspector === undefined) return;

        const registrations: InterfaceRegistration[] = [];
        const opts = { serviceId };
        try {
            registrations.push(this._register(nodeInterface, {
                getNodeId: () => ({ nodeId: info.nodeId, portId: info.portId }),
            }, opts, true));
            registrations.push(this._register(topologyInterface, {
                getGraph: () => this._endpointGraph(serviceId, info),
                watchGraph: async (_params, _ctx, stream) => {
                    await waitForAbort(stream.signal);
                    return {};
                },
            }, opts, true));
            registrations.push(this._register(trafficInterface, {
                watch: ({ methodPrefix, trafficIgnoreKey, focusRequest }, _ctx, stream) =>
                    this._watchTraffic(
                        trafficInspector,
                        { methodPrefix, trafficIgnoreKey, focusRequest },
                        stream,
                    ),
                watchWithPayloads: ({
                    methodPrefix,
                    maxPayloadBytes,
                    trafficIgnoreKey,
                    focusRequest,
                }, _ctx, stream) =>
                    this._watchTraffic(
                        trafficInspector,
                        {
                            methodPrefix,
                            maxPayloadBytes,
                            trafficIgnoreKey,
                            focusRequest,
                        },
                        stream,
                    ),
            }, opts, true));
        } catch (error) {
            for (const registration of registrations.reverse()) registration.dispose();
            throw error;
        }
        this._serviceInspectionRegistrations.set(serviceId, registrations);
    }

    private _removeServiceInspection(serviceId: string): void {
        const registrations = this._serviceInspectionRegistrations.get(serviceId);
        if (registrations === undefined) return;
        this._serviceInspectionRegistrations.delete(serviceId);
        for (const registration of registrations.reverse()) registration.dispose();
    }

    private _hasBusinessServiceRegistration(serviceId: string): boolean {
        return Array.from(this._registry.values()).some((entry) =>
            entry.serviceId === serviceId && !entry.internalInspection);
    }

    private _endpointGraph(serviceId: string, info: NodeInfo): TopologyGraph {
        return {
            observerServiceId: serviceId,
            entryNodeId: info.nodeId,
            nodes: [{
                nodeId: info.nodeId,
                kind: 'endpoint',
                ...(info.descriptors !== undefined ? { descriptors: info.descriptors } : {}),
                ports: [{ portId: info.portId }],
            }],
            links: [],
            routes: [{
                serviceId,
                nodeId: info.nodeId,
                portId: info.portId,
                match: 'exact',
            }],
        };
    }

    private async _watchTraffic<TClient>(
        inspector: EndpointTrafficInspector,
        options: EndpointTrafficWatchOptions,
        stream: StreamApi<TClient, TrafficEvent>,
    ): Promise<TrafficWatchResult> {
        const subscription = inspector.subscribe(options, (event) => stream.send(event));
        const dispose = () => subscription.dispose();
        if (stream.signal.aborted) {
            dispose();
        } else {
            stream.signal.addEventListener('abort', dispose, { once: true });
        }
        try {
            return await subscription.closed;
        } finally {
            stream.signal.removeEventListener('abort', dispose);
            subscription.dispose();
        }
    }
}


/**
 * Options when obtaining a typed client for an interface.
 *
 *  - `serviceId`: route to a specific service (form 3). Omit for form 2
 *    (implicit / root service on the connection).
 *  - any `TOutCtx` property: a per-client default merged into the `ctx`
 *    of every call issued through the returned proxy (e.g.
 *    `signerOverride`, `capsOverride` for a signing channel). The
 *    connection forwards these verbatim; it does not interpret them.
 *
 * Schema-version pinning travels as interface-level call metadata
 * ({@link SendOpts.interfaceHash}); the typed proxy stamps
 * `iface.schemaHash` automatically, independent of `TOutCtx`.
 */
export type GetOptions<TOutCtx = undefined> = {
    serviceId?: string;
} & Partial<TOutCtx>;

/** Options for a metadata-free, bare-method typed client. */
export interface BareGetOptions {
    prefix?: string;
}

export interface RegisterOptions {
    /**
     * If set, this interface is mounted under this service id (form 3).
     */
    serviceId?: string;
    /**
     * Optional human description recorded for `serviceId` and surfaced
     * through `hubrpc.directory::list`. Requires `serviceId`. The first
     * registration's description wins; any later registration that
     * supplies a *different* non-undefined description throws.
     */
    serviceDescription?: string;
    /**
     * Root node ids required to access `serviceId`, in CNF (AND of OR-sets):
     * the caller must satisfy **every** set, and a set is satisfied by **any
     * one** of its node ids. Surfaced through `hubrpc.directory::list`.
     * Requires `serviceId`. Recorded per service; a later registration that
     * supplies a *different* value for the same `serviceId` throws.
     */
    rootPrincipalSets?: readonly RootPrincipalSet[];
}

/** A live interface registration. Disposing it removes dispatch and reflection state. */
export interface InterfaceRegistration {
    /** Remove this exact registration. Idempotent. */
    dispose(): void;
}

/** Generated topology identity and its live root-interface registration. */
export interface InspectionRegistration extends InterfaceRegistration, NodeInfo {
    /**
     * Observe this endpoint's full-payload traffic in-process. Wire observation
     * remains disabled until either this or an RPC traffic watch is active.
     */
    observeTraffic(observer: (transit: TrafficTransitEvent) => void): InterfaceRegistration;
}

function createInspectionId(kind: 'node' | 'port'): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `${kind}:${bytesToBase64Url(bytes)}`;
}

/** Structural equality for two CNF root-node-id requirement collections. */
function rootPrincipalSetsEqual(
    a: readonly RootPrincipalSet[],
    b: readonly RootPrincipalSet[],
): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const sa = a[i];
        const sb = b[i];
        if (sa.length !== sb.length) return false;
        for (let j = 0; j < sa.length; j++) {
            if (sa[j].principal !== sb[j].principal) return false;
            if ((sa[j].transitive === true) !== (sb[j].transitive === true)) return false;
        }
    }
    return true;
}

interface RegisteredInterface {
    iface: InterfaceDefinition<any>;
    handlers: Record<string, (params: any, ctx: any) => any>;
    serviceId: string | undefined;
    internalInspection: boolean;
}

interface DirectoryWatcher {
    readonly interfaceId: string | undefined;
    readonly interfaceIdPrefix: string | undefined;
    readonly serviceId: string | undefined;
    readonly serviceIdScopes: readonly ServiceIdPattern[] | undefined;
    readonly send: () => void;
    pending?: boolean;
}

function directoryWatcherMatchesEntry(
    watcher: DirectoryWatcher,
    entry: RegisteredInterface,
): boolean {
    const serviceId = entry.serviceId ?? '';
    return (watcher.interfaceId === undefined || watcher.interfaceId === entry.iface.info.id)
        && (watcher.interfaceIdPrefix === undefined
            || entry.iface.info.id.startsWith(watcher.interfaceIdPrefix))
        && (watcher.serviceId === undefined || watcher.serviceId === serviceId)
        && serviceIdMatchesScopes(serviceId, watcher.serviceIdScopes);
}

interface BareBinding {
    readonly prefix: string;
    readonly entry: RegisteredInterface;
}

function isVoidResultSchema(schema: { _zod?: { def?: { type?: string; }; }; }): boolean {
    const type = schema._zod?.def?.type;
    return type === 'void' || type === 'undefined';
}


/** Service-scoped handle returned by `connection.service(id)`. */
export class ServiceHandle<TInCtx = undefined, TOutCtx = undefined> {
    constructor(
        private readonly _connection: LinkRpcConnection<TInCtx, TOutCtx>,
        private readonly _serviceId: string,
    ) { }

    public get<TDef extends InterfaceDefinition<any>>(
        iface: TDef,
        opts: Partial<TOutCtx> = {},
    ): InterfaceClient<TDef> {
        return this._connection.get(iface, { ...opts, serviceId: this._serviceId } as GetOptions<TOutCtx>);
    }

    public register<TDef extends InterfaceDefinition<any>>(
        iface: TDef,
        handlers: InterfaceHandlers<TDef, TInCtx>,
        opts: Omit<RegisterOptions, 'serviceId'> = {},
    ): InterfaceRegistration {
        return this._connection.register(iface, handlers, { ...opts, serviceId: this._serviceId });
    }
}

function notFound(reason: string, method: string): Result {
    return {
        error: {
            code: ErrorCode.methodNotFound,
            message: `Method not found: ${method}`,
            data: { reason, method },
        },
    };
}

function isInspectionInterface(iface: InterfaceDefinition<any>): boolean {
    return iface === nodeInterface
        || iface === topologyInterface
        || iface === trafficInterface;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
    });
}
