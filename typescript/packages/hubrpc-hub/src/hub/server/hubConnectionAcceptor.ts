import { type IMessageTransport, type PrincipalId, TransportPair } from '@vscode/hubrpc';
import { withForwardedCallGate } from './forwardedCallGate';
import { withVerifiedSignature } from './verifiedSignature';
import type { PrefixPolicy } from './prefixPolicy';
import { RootOverlay } from './routing/rootOverlay';
import { type HubAccessHandlers } from './hubAccessService';
import {
    type ConnectionContext,
    type ConnectionHandlerFactory,
    resolveConnectionHandler,
} from './connectionHandler';
import type { HubRpcConnection } from '@vscode/hubrpc';
import type { DirectoryEntry } from './accessCandidates';
import type { AttachedLink, Hub } from './routing/routingHub';
import type { ITransportServer, Transport } from '@vscode/hubrpc/hub/common';

/**
 * A data shape describing an imperative consent front door — the handlers plus
 * the directory source `registerHubAccessService` needs. Retained as a
 * convenience type; the acceptor installs consent via the more general
 * {@link HubConnectionAcceptorBaseOptions.installHubAccess} callback.
 */
export interface HubAccessConfig {
    readonly handlers: HubAccessHandlers;
    fetchDirectory(): Promise<readonly DirectoryEntry[]>;
}

export interface HubConnectionAcceptorBaseOptions<TTransport extends Transport> {
    /**
     * Source of inbound transports. Often a provenance-annotated server
     * (`withProvenance(socketServer, provider)`), but any
     * {@link ITransportServer} works — provenance is read via `resolveIdentity`
     * and the policy, not required by the acceptor's types.
     */
    readonly server: ITransportServer<TTransport>;
    /** The central hub all accepted participants attach under. */
    readonly hub: Hub;
    /**
     * Ordered connection handlers. For each accepted transport the acceptor
     * resolves the first handler whose {@link ConnectionHandlerFactory.handle}
     * claims the presented `hubrpc::initialize` token; that handler installs the
     * participant's root services (identity, granted namespace, minting, …). If
     * no handler claims, the connection is dropped. An empty array accepts
     * nothing.
     */
    readonly handlers: readonly ConnectionHandlerFactory[];
    /**
     * Authorizes each prefix claim a participant makes. Omit to allow every
     * well-formed claim.
     */
    readonly policy?: PrefixPolicy<TTransport>;
    /** ServiceId of the global reflection services. Defaults to `'hub'`. */
    readonly hubServiceId?: string;
    /**
     * Install the consent front door at each accepted participant's overlay
     * root (root form, never forwarded → never gated). The callback receives the
     * root connection and registers `hubAccess::*` on it however it likes — the
     * imperative `registerHubAccessService(root, …)` or the keyless
     * `HubAccessManifestHost.registerHubAccessAtRoot(root)`. Omit on open hubs;
     * then no consent surface is served.
     */
    installHubAccess?(root: HubRpcConnection<unknown>): void;
    /** Fired after a participant's overlay is attached. */
    onAttached?(info: { overlay: RootOverlay; }): void;
    /** Fired when accepting a connection throws. */
    onError?(error: Error): void;
}

/**
 * Forwarded-call gating policy — a **discriminated union** so the type system
 * enforces the safe combinations and rules out the dangerous "ask for
 * capability enforcement but forget the trust anchors" misconfiguration:
 *
 * - **off** (default): forwarded calls reach the hub unverified.
 * - **authenticity only** (`verifyForwardedCalls: true`): forwarded calls must
 *   carry a valid `$hubrpc` signature; `adminIds` is optional.
 * - **capability** (`verifyForwardedCalls: true` + `requireForwardedCapability:
 *   true`): forwarded calls must additionally present a capability rooted at one
 *   of `adminIds`. Because an empty/absent anchor set fails closed (rejecting
 *   *every* capability, including validly granted ones), `adminIds` is
 *   **required at compile time** in this arm.
 */
export type ForwardCheckingPolicy =
    | {
        readonly verifyForwardedCalls?: false;
        readonly requireForwardedCapability?: false;
        readonly adminIds?: undefined;
    }
    | {
        /**
         * Every accepted participant's hub-facing link is wrapped in a
         * {@link withForwardedCallGate signature front door}: forwarded
         * (fully-qualified) requests must carry a valid `$hubrpc` signature to
         * reach the hub. Requests to the hub's own `hubServiceId` prefix are
         * exempt (those services self-gate).
         */
        readonly verifyForwardedCalls: true;
        readonly requireForwardedCapability?: false;
        /**
         * Optional root trust anchors. With authenticity-only verification a
         * capability is not required, but when present a call's chain is still
         * checked against these anchors.
         */
        readonly adminIds?: Iterable<PrincipalId>;
    }
    | {
        readonly verifyForwardedCalls: true;
        /**
         * The forwarded-call gate also requires a capability, not just a
         * signature: a forwarded call authorises only if its capability chain
         * roots at one of {@link adminIds} (accepted for every service). The
         * gate also dedups each request nonce, so `callBind` grants are
         * single-use for free.
         */
        readonly requireForwardedCapability: true;
        /** Root trust anchors. Typically the hub admin's PrincipalId. Required (fail-closed otherwise). */
        readonly adminIds: Iterable<PrincipalId>;
    };

export type HubConnectionAcceptorOptions<TTransport extends Transport> =
    HubConnectionAcceptorBaseOptions<TTransport> & ForwardCheckingPolicy;

interface AcceptedConnection {
    readonly overlay: RootOverlay;
    readonly upstream: AttachedLink;
    readonly topology: { dispose(): void; };
}

/**
 * Bridges accepted transports onto the hubv2 graph via a pluggable chain of
 * {@link ConnectionHandlerFactory connection handlers}. For each transport it:
 *
 * 1. attaches an uplink to the central hub and builds a {@link RootOverlay};
 * 2. resolves the first handler whose token check claims the connection and
 *    lets it install the participant's root services (claim/directory front
 *    door + consent, and optionally identity, granted namespace, minting) —
 *    dropping the connection if none claim; and
 * 3. connects the participant, disposing the overlay and detaching the uplink
 *    (which releases its claimed prefixes) when the transport closes.
 *
 * It never names a backend transport type — hand it any {@link ITransportServer}.
 */
export class HubConnectionAcceptor<TTransport extends Transport> {
    private readonly _accepted = new Set<AcceptedConnection>();
    private _disposed = false;

    constructor(private readonly _options: HubConnectionAcceptorOptions<TTransport>) {
        this._options.server.setConnectionHandler((t) => {
            this._accept(t);
        });
    }

    private _accept(transport: TTransport): void {
        if (this._disposed) {
            transport.dispose();
            return;
        }

        let accepted: AcceptedConnection;
        try {
            accepted = this._wire(transport);
        } catch (e) {
            this._options.onError?.(e instanceof Error ? e : new Error(String(e)));
            transport.dispose();
            return;
        }

        this._accepted.add(accepted);
        transport.onDidClose(() => {
            accepted.overlay.dispose();
            accepted.topology.dispose();
            accepted.upstream.dispose();
            this._accepted.delete(accepted);
        });

        this._options.onAttached?.({ overlay: accepted.overlay });
    }

    /**
     * Wrap the hub-facing link per the {@link ForwardCheckingPolicy}. The
     * option union guarantees that capability mode always carries its
     * `adminIds` trust anchors, so this can never silently fail closed by
     * forgetting them.
     */
    private _gateHubFacing(inner: IMessageTransport): IMessageTransport {
        if (this._options.verifyForwardedCalls !== true) {
            return inner;
        }
        // No exempt prefixes: even the hub's own services (reflection) go
        // through the gate. The consent front door (`hubAccess::*`) is served at
        // the connection root (never forwarded), so it needs no capability and
        // is reached directly.
        if (this._options.requireForwardedCapability === true) {
            // `adminIds` is required by the union arm — no fail-closed surprise.
            const adminIds = [...this._options.adminIds];
            return withForwardedCallGate(inner, {
                requireCapability: true,
                acceptedRootIssuers: () => adminIds.map((nodeId) => ({ principal: nodeId, isPublic: true })),
            });
        }
        const adminIds = this._options.adminIds !== undefined
            ? [...this._options.adminIds]
            : undefined;
        return withForwardedCallGate(inner, {
            ...(adminIds !== undefined
                ? { acceptedRootIssuers: () => adminIds.map((nodeId) => ({ principal: nodeId, isPublic: true })) }
                : {}),
        });
    }

    private _wire(transport: TTransport): AcceptedConnection {
        // Resolve the claiming handler from the presented token before we commit
        // any hub resources, so an unclaimed connection is a clean rejection.
        const token = (transport as { initializeToken?: string | undefined; }).initializeToken;
        const handler = resolveConnectionHandler(this._options.handlers, token);
        if (handler === undefined) {
            throw new Error('no connection handler accepted the presented token');
        }

        const pair = new TransportPair();
        // Optionally gate the hub-facing link so unsigned/unauthorized forwarded
        // calls are rejected before they reach the routing core.
        const hubFacing = this._gateHubFacing(pair.b);
        const upstream = this._options.hub.attach(hubFacing);
        const overlay = new RootOverlay({
            uplink: pair.a,
            uplinkPortId: upstream.portId,
        });
        const topology = this._options.hub.registerManagedRoutingTopology(
            upstream,
            overlay.managedTopology(upstream.edgeId, transport.topologyInfo),
        );

        const policy = this._options.policy;
        const ctx: ConnectionContext = {
            root: overlay.root,
            upstream,
            hub: this._options.hub,
            transport,
            token,
            hubServiceId: this._options.hubServiceId ?? 'hub',
            ...(policy !== undefined
                ? {
                    authorizeClaim: (requestedPrefix) =>
                        policy.authorizeClaim({ principal: undefined, transport, requestedPrefix }),
                }
                : {}),
            ...(this._options.installHubAccess !== undefined
                ? { installHubAccess: this._options.installHubAccess }
                : {}),
        };
        // The handler installs the participant's root services (claim/directory
        // front door + consent, and optionally identity, granted namespace,
        // minting) via the shared `provisionRoot`.
        try {
            handler(ctx);

            // The overlay root verifies inbound signatures (when the hub checks them
            // at all) so root-form front doors establish caller authenticity.
            // Unsigned calls still pass for keyless connections; the consent front
            // door (`hubAccess::*`) takes its audience from `consumer.principal` and
            // so does not depend on this.
            const verifySignatures = this._options.verifyForwardedCalls === true;
            overlay.connectParticipant(withVerifiedSignature(transport, { verifySignatures }));
            void upstream.identifyPeer().catch((error: unknown) => {
                this._options.onError?.(new Error(
                    `peer identification failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    { cause: error },
                ));
            });
            return { overlay, upstream, topology };
        } catch (error) {
            overlay.dispose();
            topology.dispose();
            upstream.dispose();
            throw error;
        }
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        for (const accepted of this._accepted) {
            accepted.overlay.dispose();
            accepted.topology.dispose();
            accepted.upstream.dispose();
        }
        this._accepted.clear();
        this._options.server.dispose();
    }
}
