/**
 * The hub engine: turn one {@link HubConfig} into a running {@link Hub} with all
 * its listeners and endpoints wired up. `serve`, `connect`, and `tunnel` are
 * thin config synthesizers over this; the client commands run it in-process
 * (via the private control socket) when given `-c, --config`.
 *
 * Wiring rules, per transport:
 * - **listener** → a {@link SocketServer}/{@link WebSocketServer} fronted by a
 *   {@link HubConnectionAcceptor}; peers claim their own service ids.
 * - **endpoint** (`ws`/`socket`/`cmd-stdio`/`uri`) → a far end we dial: open the
 *   raw transport, claim our `claimServiceIds` through its connection-granted
 *   namespace, `hub.attach` it for inbound routing, `claimPrefix` its
 *   `routeServiceIds`, and `setUplink` it when it is the `defaultRoute`. Lost
 *   far-end links reconnect and repeat that registration before routing resumes.
 * - **endpoint** (`cmd-env`) → a child spawned against a private hub socket; it
 *   joins this hub as a participant and claims its own prefix.
 */
import {
    type HubRpcConnection,
    type Identity,
    KeypairSigningIdentity,
    type ManagedIdentityStorageBackend,
    type PrincipalId,
    type SigningIdentity,
} from '@vscode/hubrpc';
import {
    CapabilityProposalIssuer,
    Hub,
    HubConnectionAcceptor,
    createHubServiceInterfaces,
    createFlowLogger,
    createSqliteIdentityKeystore,
    fetchFullDirectory,
    registerConnectionTokenBinderService,
    anonymousHandler,
    staticTokenHandler,
    boundTokenHandler,
    resolveConnectionHandler,
    type ConnectionHandlerFactory,
    type RootProvision,
    type HubServices,
    type RegisterConnectionTokenBinderOptions,
    type SqliteIdentityKeystore,
    type SqliteIdentitySlot,
} from '../hub/server';
import {
    type NodeSocketTransport,
    type NodeWebSocketTransport,
    SocketServer,
    WebSocketServer,
} from '../hub/server/node';
import {
    loadOrCreateIdentity,
} from '@vscode/hubrpc/node';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
    ConnectionHandlerConfig,
    ConnectionTokenBinderConfig,
    EndpointConfig,
    HubConfig,
    ListenerConfig,
    ParticipantConnectorConfig,
    ProvisionConfig,
} from '../config';
import { spawnCommand } from '../spawn';
import { HubAccessManifestHost, registerHubAccessManifest } from './hubAccessManifest';
import { hubAccessManifestInterface } from '@vscode/hubrpc/hub/common';
import { runManifestApprover } from './manifestApprover';
import { endpointCommand, endpointLabel, forwardStdin, killChild, pipeChildLogs } from './cmdEndpoint';
import { configureParticipants } from './configuredParticipants';
import { RouteTable } from './routeTable';
import { TokenIdentityStore } from '../hub/server/tokenIdentityStore';

/**
 * Resolved forward-checking policy: the listener-acceptor flags plus the
 * admin id used to install the signed front doors, and the consent front-door
 * config the acceptor installs at each overlay root.
 */
interface ForwardCheckingState {
    readonly verifyForwardedCalls: boolean;
    readonly requireForwardedCapability: boolean;
    readonly adminIds: readonly PrincipalId[];
    readonly hubServiceId: string;
    /** Installs the consent front door (`hubAccess::*`) at an overlay root. */
    readonly installHubAccess?: (root: HubRpcConnection<unknown>) => void;
}

/** Where persistent managed identities for `managedIdentity` slots are stored. */
const PROVISION_SUBDIR = 'provisioned-identities';

export interface RunHubOptions {
    readonly config: HubConfig;
    /** Sink for human log lines (child output, listener bindings). Default: stderr. */
    readonly log?: (line: string) => void;
    /**
     * Forward this process's stdin to the single `cmd-*` endpoint. Throws at
     * startup when more than one `cmd-*` endpoint is configured.
     */
    readonly cmdInteractive?: boolean;
    /**
     * Log every JSON-RPC message routed through the hub to {@link log}, one
     * coalesced flow per line (the same rendering as the VS Code "hubrpc
     * Flows" channel). Off by default — when omitted the hub installs no
     * transit observer and pays no cost.
     */
    readonly logMessages?: boolean;
}

/** A bound listener, reported for logging / `serve` startup output. */
export interface ListenerInfo {
    readonly type: ListenerConfig['type'];
    readonly address: string;
}

/** A running hub. Connect a local client via {@link controlEndpoint}. */
export interface RunningHub {
    readonly hub: Hub;
    readonly listeners: readonly ListenerInfo[];
    /** Private local socket (allow-all) for in-process CLI clients. */
    readonly controlEndpoint: { readonly path: string; readonly token: string; };
    dispose(): void;
}

/** Build + start a hub from a config. Resolves once all transports are wired. */
export async function runHub(opts: RunHubOptions): Promise<RunningHub> {
    const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
    const config = opts.config;
    // Off by default: only attach a transit observer when message logging is
    // requested, so a plain hub pays no inspection cost.
    const flowLogger = opts.logMessages ? createFlowLogger({ log }) : undefined;
    const hub = flowLogger ? new Hub({ onTransit: flowLogger.onTransit }) : new Hub();

    const routes = new RouteTable();
    const disposers: Array<() => void> = [];
    const listeners: ListenerInfo[] = [];

    // Shared connection-token store: trusted binder endpoints
    // (`connectionTokenBinder`) populate it via
    // `connectionTokenBinder::bindConnectionToken`; `managedIdentity: { mode:
    // "fromToken" }` / `grantedServiceId: { mode: "fromToken" }` listeners
    // redeem from it. One per hub.
    const tokenStore = new TokenIdentityStore();

    // Shared managed-identity provisioner: maps an identity slot to a lazily
    // loaded, cached persistent identity. Used by handlers (config + bound
    // tokens) and cmd-env endpoints alike.
    const identities = new IdentityProvisioner();

    const forwardChecking = await _setupForwardChecking(hub, config, log, disposers, tokenStore);

    if (flowLogger) disposers.push(() => flowLogger.dispose());

    const cmdEndpointCount =
        config.endpoints.filter((e) => e.kind === 'cmd-env' || e.kind === 'cmd-stdio').length
        + Object.values(config.namedEndpoints).filter(
            (e) => e.kind === 'cmd-env' || e.kind === 'cmd-stdio',
        ).length;
    if (opts.cmdInteractive && cmdEndpointCount > 1) {
        throw new Error(
            `--cmd-interactive requires exactly one cmd endpoint, found ${cmdEndpointCount}`,
        );
    }
    const interactive = opts.cmdInteractive === true && cmdEndpointCount === 1;

    const dispose = (): void => {
        for (const d of disposers.reverse()) {
            try {
                d();
            } catch { /* best effort */ }
        }
    };

    try {
        // Private control socket: local CLI clients connect here (allow-all).
        const controlEndpoint = await _startControlSocket(hub, disposers);

        for (const listener of config.listeners) {
            const info = await _wireListener(
                hub,
                listener,
                forwardChecking,
                config.hubServiceId,
                disposers,
                log,
                tokenStore,
                identities,
            );
            listeners.push(info);
        }

        // namedEndpoints are folded into endpoints; the map key is their label.
        const planned: Array<{ label: string; ep: EndpointConfig; }> = [
            ...config.endpoints.map((ep) => ({ label: endpointLabel(ep), ep })),
            ...Object.entries(config.namedEndpoints).map(([label, ep]) => ({
                label: endpointLabel(ep, label),
                ep,
            })),
        ];

        // Validate conflicts across both reusable connector participants and the
        // host-specific cmd-env participants before starting either category.
        for (const { label, ep } of planned) {
            for (const serviceId of ep.routeServiceIds) routes.claim(serviceId, label);
            if (ep.defaultRoute) routes.setDefault(label);
        }

        const connectorParticipants = planned
            .filter((entry): entry is { label: string; ep: ParticipantConnectorConfig; } =>
                entry.ep.kind !== 'cmd-env')
            .map(({ label, ep }) => ({ name: label, config: ep }));
        const configuredParticipants = configureParticipants({
            participants: connectorParticipants,
            attachParticipant: transport => {
                const link = hub.attach(transport);
                return {
                    claimPrefix: prefix => link.claimPrefix(prefix),
                    setDefaultRoute: () => hub.setUplink(transport),
                    identifyPeer: () => link.identifyPeer(),
                    request: (method, params, timeoutMs) =>
                        link.request(method, params, timeoutMs),
                    dispose: () => link.dispose(),
                };
            },
            log,
            cmdInteractive: interactive
                && connectorParticipants.some(entry => entry.config.kind === 'cmd-stdio'),
        });
        disposers.push(() => configuredParticipants.dispose());

        for (const { label, ep } of planned) {
            if (ep.kind !== 'cmd-env') continue;
            await _wireCmdEnvEndpoint(
                hub, label, ep, log, interactive, forwardChecking, config.hubServiceId, tokenStore, identities, disposers,
            );
        }

        return { hub, listeners, controlEndpoint, dispose };
    } catch (e) {
        dispose();
        throw e;
    }
}

// -- forward checking -----------------------------------------------------

/**
 * Install the hub's global services and, when {@link HubConfig.forwardChecking}
 * is enabled, the `hubAccess` consent front door + the hub-served
 * `hubAccessManifest`.
 *
 * The hub itself is **keyless park-and-relay**: a `hubAccess` request is parked
 * as a desired manifest entry and blocks; an *approver* decides it by relaying a
 * signed capability via `setCurrent`. Approvers are manifest **clients** (over a
 * connection), never special cases inside the hub:
 *
 *  - The built-in **terminal approver** ({@link runManifestApprover}) is started
 *    when stdin is a TTY and {@link HubConfig.consentApprover} is not `false`.
 *    It mints with the hub's persistent admin identity (loaded only then) and
 *    consents on stdin. It reaches the manifest over the in-process services
 *    connection — the same path a remote approver would use.
 *  - A non-interactive hub is **keyless**: it loads no key, and grants come
 *    solely from external approvers (configured `rootPrincipalIds`) deciding via
 *    the manifest with their own self-signed capabilities.
 *
 * Returns the acceptor flags to apply to every inbound listener, or `undefined`
 * for an open (unchecked) hub.
 */
async function _setupForwardChecking(
    hub: Hub,
    config: HubConfig,
    log: (line: string) => void,
    disposers: Array<() => void>,
    tokenStore: TokenIdentityStore,
): Promise<ForwardCheckingState | undefined> {
    const fc = config.forwardChecking;
    const verifySignatures = fc === true ? true : fc === false ? false : fc.verifySignatures;
    const requireCapability = fc === true ? true : fc === false ? false : fc.requireCapability;

    if (!verifySignatures && !requireCapability) {
        // Open hub: no admin identity, no signed register, no consent surface.
        const openServices = createHubServiceInterfaces(hub, { hubServiceId: config.hubServiceId });
        _registerCentralConnectionTokenBinder(openServices, config, tokenStore, log);
        return undefined;
    }

    // The hub is keyless park-and-relay. A persistent admin signing identity is
    // loaded only to back the built-in *terminal approver*, which exists only
    // when stdin is a TTY and `consentApprover` is not `false`. Everything else
    // (non-interactive, or `consentApprover: false`) runs without a hub key and
    // relies on external approvers.
    const interactive = process.stdin.isTTY === true;
    const approverEnabled = requireCapability && interactive && config.consentApprover !== false;
    let admin: SigningIdentity | undefined;
    let adminId: PrincipalId | undefined;
    if (approverEnabled) {
        const persisted = await loadOrCreateIdentity({
            id: config.adminIdentitySlot,
            storeDir: _provisionDir(),
        });
        admin = KeypairSigningIdentity.fromKeypair(persisted.keypair);
        adminId = admin.publicSigningIdentity.principal;
    }

    const services = createHubServiceInterfaces(hub, {
        hubServiceId: config.hubServiceId,
    });
    _registerCentralConnectionTokenBinder(services, config, tokenStore, log);

    // The accepted capability roots: the hub's own admin identity (when a local
    // approver exists), plus any externally configured roots (e.g. a remote
    // vscode/CLI approver). These are both the forwarded-call gate's trust
    // anchors and the `acceptableRootIds` the manifest advertises to approvers.
    const adminIds: PrincipalId[] = [
        ...(adminId !== undefined ? [adminId] : []),
        ...config.rootPrincipalIds,
    ];

    // Install the keyless consent surface: the manifest host registers
    // `hubAccess` DIRECTLY at each overlay root (no hub-side directory), parking
    // every request as a manifest entry and awaiting a relayed capability. The
    // host never mints — approvers (terminal or remote) do.
    let installHubAccess: ((root: HubRpcConnection<unknown>) => void) | undefined;
    if (requireCapability) {
        const manifest = new HubAccessManifestHost({ acceptableRootIds: adminIds, log });
        registerHubAccessManifest(
            services.connection as unknown as HubRpcConnection,
            manifest,
            { serviceId: services.hubServiceId },
        );
        installHubAccess = (root) => manifest.registerHubAccessAtRoot(root);

        // Start the built-in terminal approver as an ordinary manifest client
        // over the in-process services connection (RPC, never the host object).
        // It mints with the hub admin identity and consents on stdin.
        if (approverEnabled && admin !== undefined) {
            const approverServiceId = config.consentApprover === true
                ? services.hubServiceId
                : (config.consentApprover as { serviceId: string }).serviceId;
            const approver = runManifestApprover({
                manifest: services.connection.service(approverServiceId).get(hubAccessManifestInterface),
                fetchDirectory: () => fetchFullDirectory(services.connection as unknown as HubRpcConnection, approverServiceId),
                issuer: new CapabilityProposalIssuer(admin),
                ownPrincipalId: adminId,
                log,
            });
            disposers.push(() => approver.dispose());
        }
    }

    if (requireCapability && adminIds.length === 0) {
        log(
            'WARNING: requireCapability is on but this hub has no accepted roots '
            + '(no local approver — non-interactive or consentApprover:false — and '
            + 'no rootPrincipalIds configured). No capability can be issued or '
            + 'accepted — every access request will hang in the manifest with no one '
            + 'able to approve it. Configure rootPrincipalIds or enable the approver.',
        );
    }

    log(
        `forward checking on (verifySignatures=${verifySignatures}, `
        + `requireCapability=${requireCapability}, admin=${adminId ?? '(keyless)'}`
        + `${config.rootPrincipalIds.length > 0 ? `, extraRoots=[${config.rootPrincipalIds.join(', ')}]` : ''})`,
    );
    return {
        verifyForwardedCalls: verifySignatures,
        requireForwardedCapability: requireCapability,
        adminIds,
        hubServiceId: services.hubServiceId,
        ...(installHubAccess !== undefined ? { installHubAccess } : {}),
    };
}

/**
 * Offer the connection-token binder as a **routable hub service** under
 * `${hubServiceId}::connectionTokenBinder`, in addition to the per-endpoint
 * root form each `cmd-env` binder installs on its own overlay root.
 *
 * The mint policy is the union of every configured `cmd-env` binder's prefixes:
 * a call may bind an `identitySlot` under any configured `identitySlotPrefix`
 * and a `serviceIdNamespace` under any configured `serviceIdPrefix`. Skipped
 * entirely when no endpoint configures a binder.
 *
 * Forwarded calls to this serviceId go through the hub's forwarded-call gate, so
 * on a checked hub a capability is required. On an **open** hub (no gate) it is
 * reachable unauthenticated — consistent with an open hub's trust-all posture,
 * but note that this is a privileged minter.
 */
function _registerCentralConnectionTokenBinder(
    services: HubServices,
    config: HubConfig,
    tokenStore: TokenIdentityStore,
    log: (line: string) => void,
): void {
    const binders: ConnectionTokenBinderConfig[] = [
        ...config.endpoints,
        ...Object.values(config.namedEndpoints),
    ]
        .filter((ep) => ep.kind === 'cmd-env' && ep.connectionTokenBinder !== undefined)
        .map((ep) => ep.connectionTokenBinder as ConnectionTokenBinderConfig);
    if (binders.length === 0) return;

    const identitySlotPrefixes = binders
        .map((b) => b.identitySlotPrefix)
        .filter((p): p is string => p !== undefined);
    const serviceIdPrefixes = binders
        .map((b) => b.serviceIdPrefix)
        .filter((p): p is string => p !== undefined);

    registerConnectionTokenBinderService(
        services.connection as unknown as HubRpcConnection<unknown>,
        {
            store: tokenStore,
            identitySlotPrefixes,
            serviceIdPrefixes,
            serviceId: services.hubServiceId,
        },
    );
    log(`connectionTokenBinder served on ${services.hubServiceId}::connectionTokenBinder`);
}


async function _startControlSocket(
    hub: Hub,
    disposers: Array<() => void>,
): Promise<{ path: string; token: string; }> {
    const socketPath = SocketServer.allocSocketPath();
    const token = randomBytes(16).toString('hex');
    const server = await SocketServer.start({ endpoint: socketPath });
    // No policy / provision: a local control client just routes calls, admitted
    // anonymously (any token) with no root services beyond the base front door.
    const acceptor = new HubConnectionAcceptor<NodeSocketTransport>({
        server,
        hub,
        handlers: [anonymousHandler({})],
    });
    disposers.push(() => {
        acceptor.dispose();
        server.dispose();
        _unlinkSocket(socketPath);
    });
    return { path: socketPath, token };
}

// -- listeners ------------------------------------------------------------

/**
 * Build the forward-checking gate options spread into a {@link
 * HubConnectionAcceptor}. Shared by inbound listeners and spawned `cmd-env`
 * children, so a child participant's forwarded calls are gated identically to
 * an external peer's (otherwise capability enforcement would silently apply
 * only to listeners, leaving spawned services ungated).
 */
function _buildGate(
    forwardChecking: ForwardCheckingState | undefined,
    hubServiceId: string,
) {
    const forwardPolicy = !forwardChecking || !forwardChecking.verifyForwardedCalls
        ? { verifyForwardedCalls: false as const }
        : forwardChecking.requireForwardedCapability
            ? {
                verifyForwardedCalls: true as const,
                requireForwardedCapability: true as const,
                adminIds: forwardChecking.adminIds,
            }
            : {
                verifyForwardedCalls: true as const,
                adminIds: forwardChecking.adminIds,
            };
    return forwardChecking
        ? {
            ...forwardPolicy,
            hubServiceId: forwardChecking.hubServiceId,
            ...(forwardChecking.installHubAccess !== undefined ? { installHubAccess: forwardChecking.installHubAccess } : {}),
        }
        : { ...forwardPolicy, hubServiceId };
}

async function _wireListener(
    hub: Hub,
    listener: ListenerConfig,
    forwardChecking: ForwardCheckingState | undefined,
    hubServiceId: string,
    disposers: Array<() => void>,
    log: (line: string) => void,
    tokenStore: TokenIdentityStore,
    identities: IdentityProvisioner,
): Promise<ListenerInfo> {
    const gate = _buildGate(forwardChecking, hubServiceId);
    const handlers = _buildHandlers(listener.handlers, tokenStore, identities);
    // Pre-handshake gate: admit a token iff some handler would claim it (the
    // handler chain then re-resolves and provisions at wiring time).
    const isTokenAccepted = (token: string | undefined): Promise<boolean> =>
        Promise.resolve(resolveConnectionHandler(handlers, token) !== undefined);

    if (listener.type === 'websocket') {
        const server = await WebSocketServer.start({
            host: listener.host,
            port: listener.port,
            path: listener.path,
            isTokenAccepted,
            allowedOrigins: listener.allowedOrigins,
            maxPayload: listener.maxPayload,
            requestListener: listener.healthPath
                ? _healthHandler(listener.healthPath)
                : undefined,
        });
        const acceptor = new HubConnectionAcceptor<NodeWebSocketTransport>({
            server,
            hub,
            ...gate,
            handlers,
        });
        disposers.push(() => {
            acceptor.dispose();
            server.dispose();
        });
        const address = `ws://${listener.host}:${server.port}${listener.path}`;
        log(`listening (websocket) on ${address}`);
        return { type: 'websocket', address };
    }

    // socket
    const server = await SocketServer.start({
        endpoint: listener.path,
        isTokenAccepted,
    });
    const acceptor = new HubConnectionAcceptor<NodeSocketTransport>({
        server,
        hub,
        ...gate,
        handlers,
    });
    disposers.push(() => {
        acceptor.dispose();
        server.dispose();
        _unlinkSocket(listener.path);
    });
    log(`listening (socket) on ${listener.path}`);
    return { type: 'socket', address: listener.path };
}

/**
 * Map a config {@link ProvisionConfig} to a resolved {@link RootProvision}:
 * turn `managedIdentity.slot` into a lazy resolver, `grantedServiceId` into a
 * namespace, and `connectionTokenBinder` into registrar options.
 */
function _provisionFromConfig(
    provision: ProvisionConfig,
    tokenStore: TokenIdentityStore,
    identities: IdentityProvisioner,
): RootProvision {
    return {
        ...(provision.grantedServiceId !== undefined
            ? { grantedServiceIdNamespace: provision.grantedServiceId }
            : {}),
        ...(provision.managedIdentity !== undefined
            ? identities.slotFor(provision.managedIdentity.slot)
            : {}),
        ...(provision.connectionTokenBinder !== undefined
            ? { connectionTokenBinder: _binderOptions(provision.connectionTokenBinder, tokenStore) }
            : {}),
    };
}

/** Build the acceptor's ordered handler factories from a listener's config. */
function _buildHandlers(
    configs: readonly ConnectionHandlerConfig[],
    tokenStore: TokenIdentityStore,
    identities: IdentityProvisioner,
): ConnectionHandlerFactory[] {
    return configs.map((h) => {
        switch (h.token) {
            case 'anonymous':
                return anonymousHandler(_provisionFromConfig(h, tokenStore, identities));
            case 'static':
                return staticTokenHandler(h.value, _provisionFromConfig(h, tokenStore, identities));
            case 'bound':
                return boundTokenHandler(tokenStore, (slot) => identities.slotFor(slot));
        }
    });
}

/**
 * Loads and caches persistent managed identities by slot, backed by a single
 * SQLite keystore. One per hub; shared between config handlers, bound-token
 * redemption, and cmd-env endpoints so a slot resolves to the same identity and
 * per-identity storage everywhere.
 *
 * Runs in the keystore's **unencrypted mode**. Identities created by a previous
 * (file-per-slot plaintext) build are migrated lazily on first resolve, keeping
 * the same principal — see {@link _migrateLegacy}.
 */
class IdentityProvisioner {
    private readonly _dir = _provisionDir();
    private _keystore: SqliteIdentityKeystore | undefined;

    /**
     * A lazily-resolved managed identity plus its per-identity storage for
     * `slot`. Spread directly into a {@link RootProvision}.
     */
    public slotFor(slot: string): {
        resolveIdentity: () => Promise<Identity>;
        storage: ManagedIdentityStorageBackend;
    } {
        const s = this._keystoreFor().slotById(slot);
        return {
            resolveIdentity: () => this._resolve(slot, s),
            storage: s.storage,
        };
    }

    /**
     * Open the keystore on first use — creating the provision dir first, since
     * `DatabaseSync` cannot create its file in a missing directory. Keyless hubs
     * (no managed identity) therefore never touch disk.
     */
    private _keystoreFor(): SqliteIdentityKeystore {
        if (this._keystore === undefined) {
            fs.mkdirSync(this._dir, { recursive: true });
            this._keystore = createSqliteIdentityKeystore({
                dbPath: path.join(this._dir, 'keystore.db'),
            });
        }
        return this._keystore;
    }

    private async _resolve(slot: string, s: SqliteIdentitySlot): Promise<Identity> {
        const existing = await s.peekIdentity();
        if (existing) return existing;
        const migrated = await this._migrateLegacy(slot, s);
        if (migrated) return migrated;
        return s.getOrCreateIdentity();
    }

    /**
     * Import a pre-SQLite plaintext identity file for `slot` (if one exists)
     * into the keystore, preserving its Ed25519 keypair — and therefore its
     * principal — then rename the file to `.migrated` as an idempotent backup.
     * Returns the imported identity, or `undefined` when there is nothing to
     * migrate.
     */
    private async _migrateLegacy(slot: string, s: SqliteIdentitySlot): Promise<Identity | undefined> {
        const file = path.join(this._dir, `${_legacySlotName(slot)}.json`);
        try {
            await fs.promises.access(file);
        } catch {
            return undefined;
        }
        const persisted = await loadOrCreateIdentity({ id: slot, file });
        const identity = await s.importIdentity(persisted.keypair, persisted.wrapKeypair);
        await fs.promises.rename(file, `${file}.migrated`).catch(() => { });
        return identity;
    }
}

/**
 * The legacy on-disk filename for a slot (`sha256(slot)` hex, first 16 bytes),
 * as written by the pre-SQLite `loadOrCreateIdentity` under {@link _provisionDir}.
 * Used only to locate files to migrate.
 */
function _legacySlotName(slot: string): string {
    return createHash('sha256').update(slot).digest('hex').slice(0, 32);
}

function _healthHandler(healthPath: string): http.RequestListener {
    return (req, res) => {
        if (req.url === healthPath) {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('ok');
            return;
        }
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('upgrade required');
    };
}

// -- host-specific cmd-env participants -----------------------------------

async function _wireCmdEnvEndpoint(
    hub: Hub,
    label: string,
    ep: Extract<EndpointConfig, { kind: 'cmd-env'; }>,
    log: (line: string) => void,
    interactive: boolean,
    forwardChecking: ForwardCheckingState | undefined,
    hubServiceId: string,
    tokenStore: TokenIdentityStore,
    identities: IdentityProvisioner,
    disposers: Array<() => void>,
): Promise<void> {
    if (ep.defaultRoute) {
        throw new Error(`endpoint '${label}': defaultRoute is not supported on cmd-env endpoints`);
    }
    if (ep.claimServiceIds.length > 0) {
        throw new Error(`endpoint '${label}': claimServiceIds is not supported on cmd-env endpoints`);
    }
    // The child claims its own prefix dynamically. Static route conflicts were
    // checked before any configured participant was started.
    const namespace = ep.grantedServiceId ?? ep.routeServiceIds[0];

    const socketPath = SocketServer.allocSocketPath();
    const token = randomBytes(16).toString('hex');
    const server = await SocketServer.start({ endpoint: socketPath });
    // Gate the child's forwarded calls exactly like an inbound peer's, so
    // capability enforcement covers spawned services too.
    const gate = _buildGate(forwardChecking, hubServiceId);
    // The dial-in child is admitted unconditionally (no inbound token to gate)
    // and provisioned with this endpoint's fixed root services: granted
    // namespace, managed identity, and — when configured — the token-minting
    // front door (also offered on `${hubServiceId}::connectionTokenBinder` via
    // `_registerCentralConnectionTokenBinder`).
    const provision: RootProvision = {
        ...(namespace !== undefined ? { grantedServiceIdNamespace: namespace } : {}),
        ...(ep.managedIdentity !== undefined
            ? identities.slotFor(ep.managedIdentity.slot)
            : {}),
        ...(ep.connectionTokenBinder !== undefined
            ? { connectionTokenBinder: _binderOptions(ep.connectionTokenBinder, tokenStore) }
            : {}),
    };
    const acceptor = new HubConnectionAcceptor<NodeSocketTransport>({
        server,
        hub,
        ...gate,
        handlers: [anonymousHandler(provision)],
    });

    const child = spawnCommand(endpointCommand(ep), {
        stdio: interactive ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...ep.env, HUBRPC_ENDPOINT: socketPath, HUBRPC_TOKEN: token },
        ...(ep.cwd !== undefined ? { cwd: ep.cwd } : {}),
    });
    pipeChildLogs(child, label, log, { includeStdout: true });
    if (interactive) disposers.push(forwardStdin(child));

    disposers.push(() => {
        killChild(child);
        acceptor.dispose();
        server.dispose();
        _unlinkSocket(socketPath);
    });
}

// -- identity / namespace helpers ----------------------------------------

/**
 * Build the root-form {@link RegisterConnectionTokenBinderOptions} for a
 * `cmd-env` endpoint's `connectionTokenBinder` config: each optional prefix
 * becomes a single-element allow-list (absent → empty → that axis disabled).
 */
function _binderOptions(
    binder: ConnectionTokenBinderConfig,
    tokenStore: TokenIdentityStore,
): RegisterConnectionTokenBinderOptions {
    return {
        store: tokenStore,
        identitySlotPrefixes: binder.identitySlotPrefix !== undefined ? [binder.identitySlotPrefix] : [],
        serviceIdPrefixes: binder.serviceIdPrefix !== undefined ? [binder.serviceIdPrefix] : [],
    };
}

function _unlinkSocket(socketPath: string): void {
    if (process.platform === 'win32') return;
    try {
        fs.unlinkSync(socketPath);
    } catch { /* ignore */ }
}

function _provisionDir(): string {
    const home = os.homedir();
    let base: string;
    if (process.platform === 'win32') {
        base = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    } else if (process.platform === 'darwin') {
        base = path.join(home, 'Library', 'Application Support');
    } else {
        base = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
    }
    return path.join(base, 'hubrpc', PROVISION_SUBDIR);
}
