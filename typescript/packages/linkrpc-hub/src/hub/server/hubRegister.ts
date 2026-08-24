import {
    type MessageWithCtx,
    type ChannelTransport,
    ErrorCode,
    type LinkRpcConnection,
    getLocalMessageContext,
    type IMessageTransport,
    isRequest,
    type RequestId,
    RpcError,
    type LocalMessageContext,
    setLocalMessageContext,
} from '@hediet/linkrpc';
import { hubServiceIdRegistryInterface } from '@hediet/linkrpc/hub/common';
import { validatePrefix } from './routing/forwardingTable';
import type { Hub } from './routing/routingHub';

/**
 * Out-of-band, per-call context produced by {@link withRequestIdContext}. A
 * typed handler only ever sees the zod-stripped params (the `$linkrpc` envelope
 * and the wire id are gone), so the originating request's wire id is smuggled
 * alongside the message via the channel's `context` slot — never over a wire.
 *
 * The register handler uses it to resolve the link a forwarded claim arrived on
 * via {@link Hub.getSourceTransport}.
 */
export interface RegisterCallContext extends LocalMessageContext {
    /**
     * The hub-rewritten wire id of the inbound request, or `undefined` for
     * responses / notifications. Keyed lookups into
     * {@link Hub.getSourceTransport} use exactly this id.
     */
    readonly requestId: RequestId | undefined;
}

/**
 * Annotate an inbound transport so every request carries its wire id in a
 * {@link RegisterCallContext}. Synchronous and signature-agnostic: it neither
 * verifies signatures nor checks capabilities (that has already happened on the
 * forwarded path — see {@link registerHubServiceIdRegistry}). It exists only so
 * a hub-hosted handler can recover the request id the typed channel would
 * otherwise strip.
 */
export function withRequestIdContext(
    link: IMessageTransport,
): ChannelTransport<RegisterCallContext> {
    return {
        send: (message) => link.send(message),
        setListener: (listener) => {
            if (listener === undefined) {
                link.setListener(undefined);
                return;
            }
            link.setListener((message) => {
                const requestId = isRequest(message) ? message.id : undefined;
                const context: RegisterCallContext = {
                    ...getLocalMessageContext(message),
                    requestId,
                };
                listener(setLocalMessageContext(
                    { ...message },
                    context,
                ) as MessageWithCtx<RegisterCallContext>);
            });
        },
        dispose: () => link.dispose(),
    };
}

export interface HubRegisterOptions {
    /** The central hub whose forwarding-table claims are written. */
    readonly hub: Hub;
    /** ServiceId the register endpoint (and the rest of the hub services) is mounted under. */
    readonly hubServiceId: string;
}

/**
 * Install the hub's privileged **claim front door** — the typed
 * `hubServiceIdRegistry::registerServiceId` handler — onto the hub services
 * `connection` (mounted under `hubServiceId`).
 *
 * Unlike the per-overlay `registerHubServices` front door — which only lets a
 * participant claim *within its provenance-granted namespace* — this endpoint
 * is the path for claiming a prefix **outside** that namespace.
 *
 * The handler is a **pure side effect**. Authentication (signature) and
 * authorization (an admin-rooted capability that permits
 * `hub::hubServiceIdRegistry::registerServiceId` for the requested
 * `requestedPrefix`) are enforced *before* the call ever reaches here, by the
 * {@link import('./forwardedCallGate').withForwardedCallGate forwarded-call
 * gate} every untrusted participant sits behind. By the time the request lands,
 * it is already known to be authentic and authorized, so the handler only:
 *
 * 1. validates the prefix is well-formed;
 * 2. resolves the link the request was forwarded from via
 *    {@link Hub.getSourceTransport} (keyed by {@link RegisterCallContext.requestId});
 *    and
 * 3. binds the prefix to that link via {@link Hub.claimPrefix}.
 *
 * The source transport answers only *where* to route the prefix, never
 * *whether* the claim is allowed.
 */
export function registerHubServiceIdRegistry(
    connection: LinkRpcConnection<RegisterCallContext>,
    options: HubRegisterOptions,
): void {
    const { hub, hubServiceId } = options;

    connection.register(hubServiceIdRegistryInterface, {
        registerServiceId: async ({ requestedPrefix }, ctx) => {
            const prefixError = validatePrefix(requestedPrefix);
            if (prefixError) {
                throw new RpcError(prefixError, ErrorCode.invalidParams);
            }

            // Resolve the link this forwarded request originally arrived on. The
            // pending entry lives until the response flows, so it is still
            // available while this handler runs.
            const origin = ctx.requestId !== undefined
                ? hub.getSourceTransport(ctx.requestId)
                : undefined;
            if (origin === undefined) {
                // No pending entry — the request was not forwarded through the
                // hub (or already answered). Nothing to bind a claim to.
                throw new RpcError('no source link for claim', ErrorCode.invalidRequest);
            }

            try {
                hub.claimPrefix(origin, requestedPrefix);
            } catch (e) {
                throw new RpcError(
                    e instanceof Error ? e.message : String(e),
                    ErrorCode.invalidRequest,
                    { prefix: requestedPrefix },
                );
            }

            return {};
        },
    }, { serviceId: hubServiceId });
}
