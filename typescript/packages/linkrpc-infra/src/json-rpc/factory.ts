import {
    type LinkRpcConnection,
    InterfaceDefinition,
    type InterfaceHandlers,
    type InterfaceRegistration,
    type JsonValue,
    type MemberMap,
    RpcError,
} from '@hediet/linkrpc';
import { createJsonRpcBridgeInterface, jsonRpcConnectionIdParameter } from './bridgeInterface';
import {
    type JsonRpcConnectionDescriptor,
    jsonRpcManagedConnectionInterface,
    type JsonRpcConnectionOptions,
    type JsonRpcConnectionCloseReason,
} from './interface';
import { JsonRpcPeer, JsonRpcResponseError, type ReverseRequestPolicy } from './jsonRpcPeer';
import type { JsonRpcTransport } from './transport';
import { registerJsonRpcConnectionService } from './server';

export interface JsonRpcBridgeProfile {
    readonly interfaces?: readonly JsonRpcBridgeApplicationInterface[];
    readonly reverseRequestPolicy?: ReverseRequestPolicy;
    readonly reverseRequestTimeoutMs?: number;
    readonly eventLimit?: number;
    openTransport(params: JsonValue | undefined, signal: AbortSignal): Promise<JsonRpcTransport>;
    initialize?(peer: JsonRpcPeer, params: JsonValue | undefined, signal: AbortSignal): Promise<JsonValue | undefined>;
}

export type JsonRpcBridgeApplicationInterface =
    | InterfaceDefinition<MemberMap>
    | {
        readonly source: InterfaceDefinition<MemberMap>;
        readonly bridge: InterfaceDefinition<MemberMap>;
    };

export interface RegisterJsonRpcConnectionFactoryOptions {
    readonly connection: LinkRpcConnection;
    readonly serviceId: string;
    readonly profile: JsonRpcBridgeProfile;
    readonly defaultIdleTimeoutMs?: number;
    readonly defaultTtlMs?: number;
    readonly maxIdleTimeoutMs?: number;
    readonly maxTtlMs?: number;
    readonly now?: () => number;
    /** Disposes the factory and every managed/raw transport when aborted. */
    readonly signal?: AbortSignal;
}

export interface JsonRpcConnectionFactoryRegistration {
    readonly activeConnectionCount: number;
    dispose(): Promise<void>;
}

interface ManagedConnection {
    readonly descriptor: JsonRpcConnectionDescriptor;
    readonly peer: JsonRpcPeer;
    readonly closed: Promise<JsonRpcConnectionCloseReason>;
    readonly closeReason: JsonRpcConnectionCloseReason | undefined;
    readonly openedAt: number;
    readonly lastActivityAt: number;
    touch(): void;
    close(reason?: JsonRpcConnectionCloseReason): Promise<void>;
}

export function registerJsonRpcConnectionFactory(
    options: RegisterJsonRpcConnectionFactoryOptions,
): JsonRpcConnectionFactoryRegistration {
    const active = new Map<string, ManagedConnection>();
    const ephemeral = new Set<JsonRpcPeer>();
    const starting = new Set<AbortController>();
    const registrations: InterfaceRegistration[] = [];
    let disposed = false;

    const createPeer = async (
        params: JsonValue | undefined,
        signal: AbortSignal,
        reverseRequestPolicy: ReverseRequestPolicy,
        onActivity?: () => void,
    ): Promise<{ peer: JsonRpcPeer; initializationResult: JsonValue | undefined; }> => {
        if (disposed) throw new Error('JSON-RPC connection factory is disposed');
        const startup = new AbortController();
        starting.add(startup);
        const reason = (): JsonRpcConnectionCloseReason =>
            startup.signal.reason === 'disposed' ? 'disposed' : 'cancelled';
        const cancelled = (): Error => new Error(
            reason() === 'disposed' ?
                'JSON-RPC connection factory is disposed' :
                'JSON-RPC connection request was cancelled',
        );
        let peer: JsonRpcPeer | undefined;
        const onStartupAbort = (): void => {
            if (peer) void peer.close(reason());
        };
        const onCallAbort = (): void => startup.abort('cancelled');
        startup.signal.addEventListener('abort', onStartupAbort, { once: true });
        signal.addEventListener('abort', onCallAbort, { once: true });
        if (signal.aborted) onCallAbort();
        try {
            const opening = Promise.resolve()
                .then(() => {
                    if (startup.signal.aborted) throw cancelled();
                    return options.profile.openTransport(params, startup.signal);
                })
                .then((transport) => {
                    if (startup.signal.aborted) {
                        transport.close(reason());
                        throw cancelled();
                    }
                    return transport;
                });
            const transport = await raceStartup(opening, startup.signal, cancelled);
            if (startup.signal.aborted) {
                transport.close(reason());
                throw cancelled();
            }
            peer = new JsonRpcPeer(transport, {
                reverseRequestPolicy,
                reverseRequestTimeoutMs: options.profile.reverseRequestTimeoutMs,
                eventLimit: options.profile.eventLimit,
                now: options.now,
                onActivity,
            });
            if (startup.signal.aborted) throw cancelled();
            const initializationResult = options.profile.initialize ?
                await raceStartup(options.profile.initialize(peer, params, startup.signal), startup.signal, cancelled) :
                undefined;
            if (startup.signal.aborted) throw cancelled();
            return { peer, initializationResult };
        } catch (error) {
            if (peer) await peer.close(startup.signal.aborted ? reason() : 'disposed');
            throw error;
        } finally {
            signal.removeEventListener('abort', onCallAbort);
            startup.signal.removeEventListener('abort', onStartupAbort);
            starting.delete(startup);
        }
    };

    const createManaged = async (
        params: JsonRpcConnectionOptions,
        signal: AbortSignal,
    ): Promise<ManagedConnection> => {
        const connectionId = globalThis.crypto.randomUUID();
        const openedAt = (options.now ?? Date.now)();
        let lastActivityAt = openedAt;
        let peerActivity = (): void => {};
        const { peer, initializationResult } = await createPeer(
            params.params as JsonValue | undefined,
            signal,
            options.profile.reverseRequestPolicy ?? 'reject',
            () => peerActivity(),
        );
        const descriptor: JsonRpcConnectionDescriptor = {
            connectionId,
            ...(initializationResult === undefined ? {} : { initializationResult }),
        };
        let state: 'open' | 'closed' = 'open';
        let closeReason: JsonRpcConnectionCloseReason | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let ttlTimer: ReturnType<typeof setTimeout> | undefined;
        const idleTimeoutMs = boundDuration(
            params.idleTimeoutMs,
            options.defaultIdleTimeoutMs,
            options.maxIdleTimeoutMs,
        );
        const ttlMs = boundDuration(params.ttlMs, options.defaultTtlMs, options.maxTtlMs);
        const resetIdleTimer = () => {
            if (idleTimeoutMs === undefined || state === 'closed') return;
            if (idleTimer !== undefined) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                void managed.close('idleTimeout');
            }, idleTimeoutMs);
            idleTimer.unref?.();
        };
        const touch = () => {
            lastActivityAt = (options.now ?? Date.now)();
            resetIdleTimer();
        };
        const managed: ManagedConnection = {
            descriptor,
            peer,
            closed: peer.closed,
            get closeReason() {
                return closeReason;
            },
            openedAt,
            get lastActivityAt() {
                return lastActivityAt;
            },
            touch,
            close: async (reason = 'closed') => {
                if (state === 'closed') return;
                state = 'closed';
                closeReason = reason;
                if (idleTimer !== undefined) clearTimeout(idleTimer);
                if (ttlTimer !== undefined) clearTimeout(ttlTimer);
                active.delete(connectionId);
                await peer.close(reason);
            },
        };
        peerActivity = touch;
        active.set(connectionId, managed);
        resetIdleTimer();
        if (ttlMs !== undefined) {
            ttlTimer = setTimeout(() => {
                void managed.close('ttl');
            }, ttlMs);
            ttlTimer.unref?.();
        }
        void peer.closed.then((reason) => {
            if (state !== 'closed') void managed.close(reason);
        });
        return managed;
    };

    const getManaged = (connectionId: string): ManagedConnection => {
        const managed = active.get(connectionId);
        if (!managed) {
            throw new RpcError(`JSON-RPC connection '${connectionId}' was not found`, -32001);
        }
        managed.touch();
        return managed;
    };

    const withApplicationPeer = async <T>(
        rawParams: unknown,
        signal: AbortSignal,
        operation: (peer: JsonRpcPeer, params: JsonValue) => Promise<T>,
    ): Promise<T> => {
        const { connectionId, params } = splitApplicationParams(rawParams);
        if (connectionId !== undefined) {
            return operation(getManaged(connectionId).peer, params);
        }
        const { peer } = await createPeer(undefined, signal, 'reject');
        ephemeral.add(peer);
        try {
            return await operation(peer, params);
        } finally {
            ephemeral.delete(peer);
            await peer.close('closed');
        }
    };

    const controlHandlers: Pick<
        InterfaceHandlers<typeof jsonRpcManagedConnectionInterface>,
        'status' | 'request' | 'notify' | 'readEvents' | 'respond' | 'close'
    > = {
        status: ({ connectionId }) => {
            const managed = getManaged(connectionId);
            return {
                connectionId,
                openedAt: managed.openedAt,
                lastActivityAt: managed.lastActivityAt,
                state: 'open',
                reverseRequestPolicy: managed.peer.reverseRequestPolicy,
            };
        },
        request: async ({ connectionId, method, params }, _ctx, stream) => {
            try {
                return {
                    result: await getManaged(connectionId).peer.request(
                        method,
                        params as JsonValue | undefined,
                        stream.signal,
                    ),
                };
            } catch (error) {
                throw asLinkRpcError(error);
            }
        },
        notify: async ({ connectionId, method, params }) => {
            await getManaged(connectionId).peer.notify(method, params as JsonValue | undefined);
            return { sent: true };
        },
        readEvents: ({ connectionId, after = 0, waitMs = 0 }, _ctx, stream) =>
            getManaged(connectionId).peer.readEvents(after, waitMs, stream.signal),
        respond: async (response) => {
            const peer = getManaged(response.connectionId).peer;
            if (response.kind === 'result') {
                await peer.respond(response.requestToken, { result: response.result as JsonValue });
            } else {
                await peer.respond(response.requestToken, {
                    error: {
                        code: response.error.code,
                        message: response.error.message,
                        ...(response.error.data === undefined ? {} : { data: response.error.data as JsonValue }),
                    },
                });
            }
            return { responded: true };
        },
        close: async ({ connectionId }) => {
            await getManaged(connectionId).close('closed');
            return { closed: true };
        },
    };

    try {
        registrations.push(registerJsonRpcConnectionService({
            connection: options.connection,
            serviceId: options.serviceId,
            openTransport: (params, signal) => options.profile.openTransport(params, signal),
        }));
        registrations.push(
            options.connection.register(
                jsonRpcManagedConnectionInterface,
                {
                    open: async (params, _ctx, stream) => (await createManaged(params, stream.signal)).descriptor,
                    connect: async (params, _ctx, stream) => {
                        const managed = await createManaged(params, stream.signal);
                        stream.send({ type: 'opened', connection: managed.descriptor });
                        if (stream.signal.aborted) {
                            await managed.close('cancelled');
                            return { reason: 'cancelled' };
                        }
                        const onAbort = () => {
                            void managed.close('cancelled');
                        };
                        stream.signal.addEventListener('abort', onAbort, { once: true });
                        try {
                            return { reason: await managed.closed };
                        } finally {
                            stream.signal.removeEventListener('abort', onAbort);
                            await managed.close(managed.closeReason ?? 'closed');
                        }
                    },
                    ...controlHandlers,
                },
                { serviceId: options.serviceId },
            ),
        );
        for (const configured of options.profile.interfaces ?? []) {
            const source = configured instanceof InterfaceDefinition ? configured : configured.source;
            const iface = configured instanceof InterfaceDefinition ?
                createJsonRpcBridgeInterface(source) :
                configured.bridge;
            if (iface.info.id !== source.info.id) {
                throw new Error(
                    `JSON-RPC bridge interface '${iface.info.id}' does not match source interface '${source.info.id}'`,
                );
            }
            registrations.push(
                options.connection.register(
                    iface,
                    createApplicationHandlers(source.members, iface.members, withApplicationPeer),
                    {
                        serviceId: options.serviceId,
                    },
                ),
            );
        }
        registrations.push(options.connection.enableReflection({ serviceId: options.serviceId }));
    } catch (error) {
        for (const registration of registrations.splice(0)) registration.dispose();
        throw error;
    }

    let disposePromise: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
        disposePromise ??= (async () => {
            if (disposed) return;
            disposed = true;
            options.signal?.removeEventListener('abort', onAbort);
            for (const startup of starting) startup.abort('disposed');
            for (const registration of registrations.splice(0)) registration.dispose();
            await Promise.all([
                ...[...active.values()].map((connection) => connection.close('disposed')),
                ...[...ephemeral].map((peer) => peer.close('disposed')),
            ]);
            ephemeral.clear();
        })();
        return disposePromise;
    };
    const onAbort = (): void => {
        void dispose();
    };
    if (options.signal?.aborted) {
        void dispose();
    } else {
        options.signal?.addEventListener('abort', onAbort, { once: true });
    }

    return {
        get activeConnectionCount() {
            return active.size;
        },
        dispose,
    };
}

type ApplicationPeerRunner = <T>(
    params: unknown,
    signal: AbortSignal,
    operation: (peer: JsonRpcPeer, params: JsonValue) => Promise<T>,
) => Promise<T>;

async function raceStartup<T>(
    operation: Promise<T>,
    signal: AbortSignal,
    cancellationError: () => Error,
): Promise<T> {
    if (signal.aborted) throw cancellationError();
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = (): void => rejectAbort(cancellationError());
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

function createApplicationHandlers(
    sourceMembers: MemberMap,
    bridgeMembers: MemberMap,
    withPeer: ApplicationPeerRunner,
): InterfaceHandlers<InterfaceDefinition<MemberMap>> {
    const handlers: Record<
        string,
        (params: unknown, ctx?: unknown, stream?: { signal: AbortSignal; }) => unknown
    > = {};
    for (const [name, sourceMember] of Object.entries(sourceMembers)) {
        const bridgeMember = bridgeMembers[name];
        if (!bridgeMember) throw new Error(`JSON-RPC bridge member '${name}' is missing`);
        if (sourceMember.kind === 'notification') {
            if (bridgeMember.kind === 'request') {
                handlers[name] = async (params, _ctx, stream) => {
                    if (!stream) throw new Error(`JSON-RPC bridge request '${name}' is missing its stream context`);
                    await withPeer(params, stream.signal, (peer, forwarded) => peer.notify(name, forwarded));
                    return { sent: true as const };
                };
            } else {
                handlers[name] = (params) => {
                    void withPeer(
                        params,
                        new AbortController().signal,
                        (peer, forwarded) => peer.notify(name, forwarded),
                    ).catch((error) => {
                        console.error(`JSON-RPC bridge notification '${name}' failed:`, error);
                    });
                };
            }
        } else {
            if (bridgeMember.kind !== 'request') {
                throw new Error(`JSON-RPC bridge request '${name}' cannot be exposed as a notification`);
            }
            handlers[name] = async (params, _ctx, stream) => {
                if (!stream) throw new Error(`JSON-RPC bridge request '${name}' is missing its stream context`);
                return withPeer(params, stream.signal, async (peer, forwarded) => {
                    try {
                        return await peer.request(name, forwarded, stream.signal);
                    } catch (error) {
                        throw asLinkRpcError(error);
                    }
                });
            };
        }
    }
    return handlers as InterfaceHandlers<InterfaceDefinition<MemberMap>>;
}

function splitApplicationParams(rawParams: unknown): { connectionId: string | undefined; params: JsonValue; } {
    if (!isRecord(rawParams)) {
        throw new RpcError('JSON-RPC bridge application params must be an object', -32602);
    }
    const connectionId = rawParams[jsonRpcConnectionIdParameter];
    if (connectionId !== undefined && (typeof connectionId !== 'string' || connectionId.length === 0)) {
        throw new RpcError(`${jsonRpcConnectionIdParameter} must be a non-empty string`, -32602);
    }
    const params = { ...rawParams };
    delete params[jsonRpcConnectionIdParameter];
    return { connectionId, params };
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asLinkRpcError(error: unknown): Error {
    if (error instanceof JsonRpcResponseError) {
        return new RpcError(error.message, error.code, error.data);
    }
    return error instanceof Error ? error : new Error(String(error));
}

function boundDuration(
    requested: number | undefined,
    defaultValue: number | undefined,
    maximum: number | undefined,
): number | undefined {
    const value = requested ?? defaultValue;
    if (value === undefined) return undefined;
    return maximum === undefined ? value : Math.min(value, maximum);
}
