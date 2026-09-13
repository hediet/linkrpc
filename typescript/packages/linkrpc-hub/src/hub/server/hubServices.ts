import {
    directoryInterface,
    directoryWatchNever,
    ErrorCode,
    JsonRpcChannel,
    nodeInterface,
    type RootPrincipalSet,
    type ServiceIdPattern,
    RpcError,
    schemasInterface,
    LinkRpcConnection,
    TransportPair,
} from '@hediet/linkrpc';
import type { StreamApi } from '@hediet/linkrpc';
import {
    topologyInterface,
    trafficInterface,
    type TrafficEvent,
    type TrafficWatchResult,
    normalizeServiceIdScopes,
    serviceIdMatchesScopes,
    type ParticipantDescriptorSource,
} from '@hediet/linkrpc/hub/common';
import { HubInspector, type HubTrafficWatchOptions } from './hubInspector';
import { registerHubServiceIdRegistry, type RegisterCallContext, withRequestIdContext } from './hubRegister';
import type { Hub } from './routing/routingHub';

export interface HubServicesOptions {
    /** ServiceId the global services are mounted under. Defaults to `'hub'`. */
    readonly hubServiceId?: string;
    /** Optional diagnostic descriptor for the hub participant. */
    readonly descriptors?: readonly ParticipantDescriptorSource[];
    /** Runs before serving a global directory list or starting a directory watch. */
    readonly beforeDirectoryQuery?: () => void | Promise<void>;
}

export interface HubServices {
    /** The in-process connection backing the hub's global services. */
    readonly connection: LinkRpcConnection<RegisterCallContext>;
    /** ServiceId the services are mounted under. */
    readonly hubServiceId: string;
    /** Traffic/topology inspector backing the hub's inspection services. */
    readonly inspector: HubInspector;
    /** Close the connection and detach the in-process link from the hub. */
    dispose(): void;
}

interface Listing {
    serviceId: string;
    interfaceId: string;
    interfaceHash: string;
    serviceDescription?: string;
    rootPrincipalSets?: readonly RootPrincipalSet[];
    reachableServiceIds?: readonly ServiceIdPattern[];
}

export function createHubServiceInterfaces(hub: Hub, options: HubServicesOptions = {}): HubServices {
    const hubServiceId = options.hubServiceId ?? 'hub';
    const pair = new TransportPair();
    const link = hub.attach(pair.a);
    hub.setLoopback(pair.a);
    link.claimPrefix(hubServiceId);
    hub.markInspectionService(link, hubServiceId);
    const inspector = new HubInspector(hub);
    const baseChannel = JsonRpcChannel.create(withRequestIdContext(pair.b));
    const connection = new LinkRpcConnection<RegisterCallContext>(baseChannel);
    registerInspectionInterfaces(
        connection,
        hub,
        inspector,
        hubServiceId,
        link.portId,
        options.descriptors,
    );
    registerHubReflection(connection, hub, hubServiceId, options.beforeDirectoryQuery);
    registerHubServiceIdRegistry(connection, { hub, hubServiceId });
    return {
        connection,
        hubServiceId,
        inspector,
        dispose: () => {
            inspector.dispose();
            connection.close();
            link.dispose();
        },
    };
}

function registerInspectionInterfaces(
    connection: LinkRpcConnection<RegisterCallContext>,
    hub: Hub,
    inspector: HubInspector,
    hubServiceId: string,
    portId: string,
    descriptors: readonly ParticipantDescriptorSource[] | undefined,
): void {
    connection.register(nodeInterface, {
        getNodeId: () => ({
            nodeId: hub.nodeId,
            portId,
            ...(descriptors !== undefined ? { descriptors: [...descriptors] } : {}),
        }),
    }, { serviceId: hubServiceId });

    connection.register(topologyInterface, {
        getGraph: () => hub.getTopologyGraph(hubServiceId),
        watchGraph: (_params, _ctx, stream) => new Promise<Record<string, never>>((resolve) => {
            if (stream.signal.aborted) {
                resolve({});
                return;
            }
            let pending = false;
            const flush = () => {
                pending = false;
                if (!stream.signal.aborted) void stream.send({}).catch(() => undefined);
            };
            const unsubscribe = hub.onDidChangeRouting(() => {
                if (pending) return;
                pending = true;
                queueMicrotask(flush);
            });
            stream.signal.addEventListener('abort', () => {
                unsubscribe();
                resolve({});
            }, { once: true });
        }),
    }, { serviceId: hubServiceId });

    connection.register(trafficInterface, {
        watch: ({ methodPrefix, trafficIgnoreKey, focusRequest }, _ctx, stream) =>
            runTrafficWatch(inspector, { methodPrefix, trafficIgnoreKey, focusRequest }, stream),
        watchWithPayloads: ({ methodPrefix, maxPayloadBytes, trafficIgnoreKey, focusRequest }, _ctx, stream) =>
            runTrafficWatch(inspector, {
                methodPrefix,
                maxPayloadBytes,
                trafficIgnoreKey,
                focusRequest,
            }, stream),
    }, { serviceId: hubServiceId });
}

async function runTrafficWatch(
    inspector: HubInspector,
    options: HubTrafficWatchOptions,
    stream: StreamApi<unknown, TrafficEvent>,
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

/**
 * Register the hub's **reflection** surface — `hubrpc.directory::list` /
 * `hubrpc.schemas::get` — on `connection`, mounted under `hubServiceId`.
 *
 * This is the always-on half of {@link createHubServiceInterfaces}: the
 * destination every {@link RootOverlay} directory *refers* world-view queries
 * to, independent of whether the signed, capability-gated claim front door
 * ({@link registerHubServiceIdRegistry}) is enabled.
 *
 * `directory.list` returns the hub's own services plus the referrals explicitly
 * returned by participant connection-root directories. Routing claims do not
 * create directory entries: a routable service that is not explicitly listed
 * remains callable when already known but is not discoverable.
 */
function registerHubReflection(
    connection: LinkRpcConnection,
    hub: Hub,
    hubServiceId: string,
    beforeDirectoryQuery: (() => void | Promise<void>) | undefined,
): void {
    // Every hub is also a participant on each adjacent connection. Its
    // connection-root directory explicitly refers to the addressed global
    // directory; parents discover this entry through their 1:1 root call.
    connection.register(directoryInterface, {
        list: ({ interfaceId, interfaceIdPrefix, serviceId, serviceIdScopes }) => {
            const referral = {
                serviceId: hubServiceId,
                interfaceId: directoryInterface.info.id,
                interfaceHash: directoryInterface.schemaHash,
                reachableServiceIds: [{ prefix: hubServiceId }],
            };
            const items = [referral]
                .filter((it) => interfaceId === undefined || it.interfaceId === interfaceId)
                .filter((it) => interfaceIdPrefix === undefined
                    || it.interfaceId.startsWith(interfaceIdPrefix))
                .filter((it) => serviceId === undefined || it.serviceId === serviceId)
                .filter((it) => serviceIdMatchesScopes(it.serviceId, serviceIdScopes));
            return { items };
        },
        watch: directoryWatchNever,
    });
    connection.register(schemasInterface, {
        get: ({ interfaceId, hash }) => {
            const iface = connection.findRegisteredInterface(interfaceId, hash);
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

    connection.register(directoryInterface, {
        list: async ({ interfaceId, interfaceIdPrefix, serviceId, serviceIdScopes }) => {
            await beforeDirectoryQuery?.();
            const items: Listing[] = [];

            // The hub's own services (mounted under hubServiceId).
            for (const r of connection.listRegisteredInterfaces()) {
                items.push(r);
            }

            // Gather each connected participant's self-listing from its ROOT
            // directory (`H·root → P`): one root-form `hubrpc.directory::list`
            // per participant link, filtered to `hubrpc.directory` rows so we
            // surface only its `<serviceId>::hubrpc.directory` referrals, never
            // its leaves. Root services are never forwarded and never gated, so
            // this needs no signing or capabilities. Consumers recurse into the
            // referrals via `walkHubDetailed`; transitive root-node-id
            // requirements are folded in during that walk, not here.
            const rootListings = await hub.queryParticipantRoots(
                `${directoryInterface.info.id}::list`,
                { interfaceId: directoryInterface.info.id },
                hubServiceId,
            );
            for (const raw of rootListings) {
                const page = raw as { items?: Listing[]; } | null;
                if (!page || !Array.isArray(page.items)) continue;
                for (const it of page.items) {
                    // Skip the participant's own root self-row (serviceId === '');
                    // we want its per-service directory referrals.
                    if (it.serviceId === '') continue;
                    items.push(it);
                }
            }

            const deduplicated = new Map<string, Listing>();
            for (const item of items) {
                const key = `${item.serviceId}\0${item.interfaceId}\0${item.interfaceHash}`;
                const previous = deduplicated.get(key);
                if (previous === undefined) {
                    deduplicated.set(key, item);
                    continue;
                }
                const preferred = item.serviceDescription !== undefined
                    || item.rootPrincipalSets !== undefined
                    ? item
                    : previous;
                if (item.interfaceId !== directoryInterface.info.id) {
                    deduplicated.set(key, preferred);
                    continue;
                }
                const previousScopes = previous.reachableServiceIds
                    ?? [{ prefix: previous.serviceId }];
                const itemScopes = item.reachableServiceIds
                    ?? [{ prefix: item.serviceId }];
                deduplicated.set(key, {
                    ...preferred,
                    reachableServiceIds: normalizeServiceIdScopes([
                        ...previousScopes,
                        ...itemScopes,
                    ]),
                });
            }

            const filtered = [...deduplicated.values()]
                .filter((it) => interfaceId === undefined || it.interfaceId === interfaceId)
                .filter((it) => interfaceIdPrefix === undefined || it.interfaceId.startsWith(interfaceIdPrefix))
                .filter((it) => serviceId === undefined || it.serviceId === serviceId)
                .filter((it) => serviceIdMatchesScopes(it.serviceId, serviceIdScopes))
                .map((it) => ({
                    serviceId: it.serviceId,
                    interfaceId: it.interfaceId,
                    interfaceHash: it.interfaceHash,
                    ...(it.serviceDescription !== undefined
                        ? { serviceDescription: it.serviceDescription }
                        : {}),
                    ...(it.rootPrincipalSets !== undefined
                        ? { rootPrincipalSets: it.rootPrincipalSets.map((s) => [...s]) }
                        : {}),
                    ...(it.reachableServiceIds !== undefined
                        ? { reachableServiceIds: [...it.reachableServiceIds] }
                        : {}),
                }));
            return { items: filtered };
        },
        watch: async (params, _ctx, stream) => {
            await beforeDirectoryQuery?.();
            // Coalesce local registrations, participant-root directory ticks,
            // and participant-set changes into one "re-list now" nudge.
            return new Promise<Record<string, never>>((resolve) => {
                if (stream.signal.aborted) {
                    resolve({});
                    return;
                }
                let pending = false;
                const flush = () => {
                    pending = false;
                    if (stream.signal.aborted) return;
                    void stream.send({}).catch(() => undefined);
                };
                const notify = () => {
                    if (pending) return;
                    pending = true;
                    queueMicrotask(flush);
                };
                const unsubscribeRouting = hub.onDidChangeRouting(notify);
                const unsubscribeLocal = connection.onDidChangeDirectory(notify);
                const participantWatches = hub.watchParticipantRoots(
                    `${directoryInterface.info.id}::watch`,
                    params,
                    notify,
                    hubServiceId,
                );
                stream.signal.addEventListener(
                    "abort",
                    () => {
                        unsubscribeRouting();
                        unsubscribeLocal();
                        participantWatches.dispose();
                        resolve({});
                    },
                    { once: true },
                );
            });
        },
    }, { serviceId: hubServiceId });

    connection.register(schemasInterface, {
        get: ({ interfaceId, hash }) => {
            const iface = connection.findRegisteredInterface(interfaceId, hash);
            if (!iface) {
                throw new RpcError(
                    'Interface not found',
                    ErrorCode.methodNotFound,
                    { reason: 'unknown-interface', interfaceId, hash },
                );
            }
            return { schema: iface.toSchema() as unknown };
        },
    }, { serviceId: hubServiceId });
}
