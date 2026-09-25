import { LinkRpcConnection } from '@hediet/linkrpc';
import { hubFromConnection } from '@hediet/linkrpc/hub/client';
import { createManagedSigningChannel } from '@hediet/linkrpc/hub/common';
import {
    connectToHub,
    openHubChannel,
    openStdioChannel,
} from '@hediet/linkrpc/node';

export type ParticipantTransport =
    | { readonly type: 'stdio'; }
    | {
        readonly type: 'hub';
        /** Hub socket or WebSocket endpoint. */
        readonly endpoint: string;
        /** Hub transport token; omitted means an empty token. */
        readonly token?: string;
        /**
         * Claim this descendant of the provenance-granted namespace instead
         * of the entire namespace. Claims outside that grant are not attempted.
         */
        readonly serviceId?: string;
        /**
         * Use the hub's managed-identity overlay to sign outbound calls.
         * Requires a hub connection provisioned with managed identity; leave
         * unset for ordinary socket/token connections without that overlay.
         */
        readonly managedIdentity?: boolean;
    };

export interface ParticipantHostContext {
    readonly connection: LinkRpcConnection;
    /** Undefined on stdio: services are registered at the connection root. */
    readonly serviceId: string | undefined;
    /** Aborted on caller cancellation, peer disconnect, or disposal. */
    readonly signal: AbortSignal;
}

export interface ParticipantHostOptions {
    readonly transport: ParticipantTransport;
    readonly signal?: AbortSignal;
    /**
     * Register services on this connection. Called after the hub namespace is
     * claimed, if using the hub transport. Return a cleanup handle for any
     * external resources (watchers, subscriptions, timers, etc.).
     */
    readonly setup: (
        context: ParticipantHostContext,
    ) => void | { dispose(): void } | AsyncDisposable
        | Promise<void | { dispose(): void } | AsyncDisposable>;
}

export interface ParticipantHostHandle extends ParticipantHostContext {
    /** Resolves after shutdown and setup cleanup on EOF, socket close, or abort. */
    readonly done: Promise<void>;
    /** Idempotently stop hosting and await setup cleanup. */
    dispose(): Promise<void>;
}

/**
 * Host a participant once, either over the process's stdio or on an existing
 * hub. Each call owns exactly one connection; reconnecting callers can invoke
 * it again with a fresh connection and fresh setup resources.
 */
export async function hostParticipant(options: ParticipantHostOptions): Promise<ParticipantHostHandle> {
    options.signal?.throwIfAborted();
    const { transport } = options;
    const stdinEvents = ['data', 'end', 'close', 'error'] as const;
    const stdinListenersBefore = transport.type === 'stdio'
        ? stdinEvents.map((event) => new Set(process.stdin.listeners(event)))
        : undefined;
    const channel = transport.type === 'stdio'
        ? await openStdioChannel()
        : undefined;
    // openStdioChannel currently has no close hook for its stdin listeners.
    // Keep only those it installed, leaving any other stdin consumers alone.
    const stdinListenersAdded = stdinListenersBefore?.map((before, index) => ({
        event: stdinEvents[index],
        listeners: process.stdin.listeners(stdinEvents[index]).filter((listener) => !before.has(listener)),
    }));
    const releaseStdin = () => {
        if (!stdinListenersAdded) return;
        for (const { event, listeners } of stdinListenersAdded) {
            for (const listener of listeners) {
                process.stdin.removeListener(event, listener as (...args: unknown[]) => void);
            }
        }
        if (process.stdin.listenerCount('data') === 0) process.stdin.pause();
    };
    const hubChannel = transport.type === 'hub' && transport.managedIdentity
        ? await openHubChannel({ endpoint: transport.endpoint, token: transport.token ?? '' })
        : undefined;
    let connection: LinkRpcConnection;
    let onClose: (listener: () => void) => { dispose(): void };
    let closeTransport: () => void;
    try {
        if (channel) {
            connection = new LinkRpcConnection(channel);
            onClose = channel.onClose;
            closeTransport = () => {
                connection.close();
                releaseStdin();
            };
        } else if (hubChannel) {
            const abortBootstrap = () => hubChannel.close();
            options.signal?.addEventListener('abort', abortBootstrap, { once: true });
            let signed: Awaited<ReturnType<typeof createManagedSigningChannel>>;
            try {
                options.signal?.throwIfAborted();
                signed = await createManagedSigningChannel(hubChannel);
            } finally {
                options.signal?.removeEventListener('abort', abortBootstrap);
            }
            connection = new LinkRpcConnection(signed.channel);
            onClose = hubChannel.onClose;
            closeTransport = () => {
                connection.close();
                hubChannel.close();
            };
        } else if (transport.type === 'hub') {
            const handle = await connectToHub({
                endpoint: transport.endpoint,
                token: transport.token ?? '',
            });
            connection = handle.connection;
            onClose = handle.onClose;
            closeTransport = () => handle.close();
        } else {
            throw new Error('Unsupported participant transport');
        }
    } catch (error) {
        hubChannel?.close();
        channel?.sender.close();
        releaseStdin();
        throw error;
    }

    const controller = new AbortController();
    let setupResult: Awaited<ReturnType<ParticipantHostOptions['setup']>>;
    let setupPending: Promise<void> | undefined;
    let disposed: Promise<void> | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const dispose = (): Promise<void> => {
        if (disposed) return disposed;
        controller.abort();
        resolveClosed();
        disposed = (async () => {
            await setupPending?.catch(() => { /* the startup path propagates setup errors */ });
            if (setupResult && Symbol.asyncDispose in setupResult) {
                await setupResult[Symbol.asyncDispose]();
            } else if (setupResult && 'dispose' in setupResult) {
                setupResult.dispose();
            }
        })().finally(() => {
            closeSubscription.dispose();
            options.signal?.removeEventListener('abort', onAbort);
        });
        closeTransport();
        return disposed;
    };
    const onAbort = () => { void dispose(); };
    const closeSubscription = onClose(onAbort);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
        controller.signal.throwIfAborted();
        options.signal?.throwIfAborted();
        let serviceId: string | undefined;
        if (transport.type === 'hub') {
            const hub = hubFromConnection(connection);
            if (transport.serviceId === undefined) {
                serviceId = (await hub.claimGrantedServiceIdNamespace()).serviceId;
            } else {
                const grant = (await hub.getConnectionInfo()).grantedServiceIdNamespace;
                controller.signal.throwIfAborted();
                if (!grant || (
                    transport.serviceId !== grant
                    && !transport.serviceId.startsWith(`${grant}/`)
                )) {
                    throw new Error(
                        `Requested serviceId "${transport.serviceId}" is outside the hub-granted namespace "${grant}"`,
                    );
                }
                await hub.registerServiceIdNamespace(transport.serviceId);
                serviceId = transport.serviceId;
            }
            controller.signal.throwIfAborted();
        }

        const context: ParticipantHostContext = {
            connection,
            serviceId,
            signal: controller.signal,
        };
        setupPending = Promise.resolve().then(async () => {
            setupResult = await options.setup(context);
        });
        await setupPending;
        controller.signal.throwIfAborted();
        return {
            ...context,
            done: closed.then(() => dispose()),
            dispose,
        };
    } catch (error) {
        await dispose();
        throw error;
    }
}
