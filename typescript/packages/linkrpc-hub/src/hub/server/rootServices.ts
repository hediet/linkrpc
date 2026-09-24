import {
    directoryInterface,
    ErrorCode,
    type Identity,
    type ManagedIdentityStorageBackend,
    registerLazyIdentityOnOverlay,
    RpcError,
    schemasInterface,
    type RootPrincipalSet,
    type ServiceIdPattern,
    type LinkRpcConnection
} from '@hediet/linkrpc';
import {
    hubGrantedServiceIdInterface,
    isServiceIdUnder,
    serviceIdMatchesScopes,
    type ServiceId,
} from '@hediet/linkrpc/hub/common';
import type { AttachedLink } from './routing/routingHub';

export interface RegisterHubServicesOptions {
    /**
     * ServiceId under which the parent serves its global reflection services.
     * The overlay's directory listing *refers* world-view queries here.
     * Defaults to `'hub'`.
     */
    readonly hubServiceId?: string;
    /**
     * Absolute serviceId region this connection may claim freely (anything
     * at/under it, no capability needed), surfaced verbatim through
     * `hubGrantedServiceId::get` as `grantedServiceIdNamespace`. Typically the
     * connection's attested identity key. Defaults to `''` — "claim nothing
     * freely" — which still lets `authorizeClaim` admit claims.
     */
    readonly grantedServiceIdNamespace?: string;
    /**
     * Consulted in `hubGrantedServiceId::register` before the prefix is
     * claimed. Return `{ ok: false, reason }` to deny (surfaced to the
     * participant as an error). When omitted, claims default to "must be within
     * `grantedServiceIdNamespace`".
     */
    authorizeClaim?(requestedPrefix: ServiceId): { ok: true; } | { ok: false; reason: string; };
}

/**
 * Install a participant's **connection root services** onto its overlay root
 * connection `root`:
 *
 * - `hubGrantedServiceId::get` — the connection round-trip: reports the
 *   `grantedServiceIdNamespace` this connection may claim freely.
 * - `hubGrantedServiceId::register` — claims a prefix on
 *   `upstream` (the parent hub link) within the connection's granted namespace,
 *   gated by `authorizeClaim` (default: namespace membership). Because an
 *   overlay represents a single participant, *one* upstream claim suffices: all
 *   prefixed traffic the parent routes to this overlay is for this participant,
 *   so the {@link OverlaySplitter} delivers it without any local table.
 * - `hubrpc.directory::list` — by default a **referral** (own root interfaces
 *   plus one row pointing at `<hubServiceId>::hubrpc.directory`); an
 *   implementation is free to aggregate the parent's listing instead.
 * - `hubrpc.schemas::get` — schemas for this overlay's own root interfaces.
 *
 * The hub's consent front door (`hubAccess::*`) is installed separately at the
 * overlay root by {@link registerHubAccessService}; it needs no capability of
 * its own because the root is never forwarded.
 *
 * The overlay itself stays unaware of which services it serves; this is the
 * routing module that gives it its front door.
 */
export function registerHubServices(
    root: LinkRpcConnection<unknown>,
    upstream: AttachedLink,
    options: RegisterHubServicesOptions = {},
): void {
    const hubServiceId = options.hubServiceId ?? 'hub';
    const grantedServiceIdNamespace = options.grantedServiceIdNamespace ?? '';
    const authorizeClaim = options.authorizeClaim;

    root.register(hubGrantedServiceIdInterface, {
        get: () => {
            return { grantedServiceIdNamespace };
        },

        getHubServiceId: () => {
            return { hubServiceId };
        },

        // Capability-free claim within the connection's provenance-granted
        // namespace. A single upstream claim suffices — the parent then routes
        // this prefix to the overlay, and the splitter forwards all such
        // traffic to the participant. Claims outside the namespace must go
        // through the admin-gated `hubServiceIdRegistry::registerServiceId`
        // door.
        register: ({ serviceId }) => {
            const verdict = authorizeClaim
                ? authorizeClaim(serviceId)
                : grantedServiceIdNamespace !== '' &&
                    isServiceIdUnder(serviceId, grantedServiceIdNamespace)
                  ? { ok: true as const }
                  : {
                        ok: false as const,
                        reason:
                            `"${serviceId}" is outside this connection's granted ` +
                            `namespace "${grantedServiceIdNamespace}"`,
                    };
            if (!verdict.ok) {
                throw new RpcError(`claim denied: ${verdict.reason}`, ErrorCode.invalidRequest);
            }
            upstream.addPrefixRoute(serviceId);
            return {};
        },
    });

    root.register(directoryInterface, {
        list: ({ interfaceId, interfaceIdPrefix, serviceId, serviceIdScopes }) => {
            const referral = {
                serviceId: hubServiceId,
                interfaceId: directoryInterface.info.id,
                interfaceHash: directoryInterface.schemaHash,
                ...(directoryInterface.info.tags === undefined ? {} : { tags: [...directoryInterface.info.tags] }),
                // This is the connection's explicit entry point to the global
                // directory, which may list services outside the `hub` subtree.
                reachableServiceIds: [{ prefix: '' }] as const,
            };
            const items = [...root.listRegisteredInterfaces(), referral]
                .filter((it) => interfaceId === undefined || it.interfaceId === interfaceId)
                .filter((it) => interfaceIdPrefix === undefined || it.interfaceId.startsWith(interfaceIdPrefix))
                .filter((it) => serviceId === undefined || it.serviceId === serviceId)
                .filter((it) => serviceIdMatchesScopes(it.serviceId, serviceIdScopes))
                .map((it) => {
                    const entry: {
                        serviceId: string;
                        interfaceId: string;
                        interfaceHash: string;
                        tags?: string[];
                        serviceDescription?: string;
                        rootPrincipalSets?: RootPrincipalSet[];
                        reachableServiceIds?: ServiceIdPattern[];
                    } = {
                        serviceId: it.serviceId,
                        interfaceId: it.interfaceId,
                        interfaceHash: it.interfaceHash,
                    };
                    if (it.tags !== undefined) entry.tags = [...it.tags];
                    const desc = (it as { serviceDescription?: string; }).serviceDescription;
                    if (desc !== undefined) entry.serviceDescription = desc;
                    const sets = (it as { rootPrincipalSets?: readonly RootPrincipalSet[]; }).rootPrincipalSets;
                    if (sets !== undefined) entry.rootPrincipalSets = sets.map((s) => [...s]);
                    const reachable = (it as { reachableServiceIds?: readonly ServiceIdPattern[]; })
                        .reachableServiceIds;
                    if (reachable !== undefined) entry.reachableServiceIds = [...reachable];
                    return entry;
                });
            return { items };
        },
        watch: (_params, _ctx, stream) => new Promise<Record<string, never>>((resolve) => {
            if (stream.signal.aborted) {
                resolve({});
                return;
            }
            let pending = false;
            const flush = () => {
                pending = false;
                if (!stream.signal.aborted) void stream.send({}).catch(() => undefined);
            };
            const unsubscribe = root.onDidChangeDirectory(() => {
                if (pending) return;
                pending = true;
                queueMicrotask(flush);
            });
            stream.signal.addEventListener('abort', () => {
                unsubscribe();
                resolve({});
            }, { once: true });
        }),
    });

    root.register(schemasInterface, {
        get: ({ interfaceId, hash }) => {
            const iface = root.findRegisteredInterface(interfaceId, hash);
            if (!iface) {
                throw new RpcError(
                    'Interface not found',
                    ErrorCode.methodNotFound,
                    { reason: 'unknown-interface', interfaceId, hash },
                );
            }
            return { schema: iface.toSchema() as unknown };
        },
    });
}

export interface RegisterIdentityServicesOptions {
    /**
     * Resolve the managed identity for this participant. Called **lazily** —
     * only when the participant first invokes `identity::*` — so registering
     * the service does not mint or load any key material (matches the consent
     * model: serving `identity::*` costs nothing until the participant opts in).
     */
    resolveIdentity(): Promise<Identity>;
    /**
     * Optional per-identity persistent key/value store, registered as
     * `identity.storage::*` alongside `identity::*`.
     */
    storage?: ManagedIdentityStorageBackend;
}

/**
 * Install `identity::*` (and optionally `identity.storage::*`) onto a
 * participant's overlay root connection. The identity is resolved lazily on
 * first use — see {@link registerLazyIdentityOnOverlay}.
 *
 * This is the identity counterpart to {@link registerHubServices}: a small,
 * composable module the overlay does not need to know about.
 */
export function registerIdentityServices(
    root: LinkRpcConnection<unknown>,
    options: RegisterIdentityServicesOptions,
): void {
    registerLazyIdentityOnOverlay(root, options.resolveIdentity, options.storage);
}
