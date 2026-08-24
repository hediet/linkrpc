import type {
    HubRpcConnection,
    Identity,
    IMessageTransport,
    ManagedIdentityStorageBackend,
} from '@vscode/hubrpc';
import type { ServiceId } from '@vscode/hubrpc/hub/common';
import { registerHubServices, registerIdentityServices } from './rootServices';
import {
    registerConnectionTokenBinderService,
    type RegisterConnectionTokenBinderOptions,
} from './connectionTokenBinderService';
import type { TokenIdentityStore } from './tokenIdentityStore';
import type { AttachedLink, Hub } from './routing/routingHub';

/**
 * Everything a {@link ConnectionHandler} needs to install a participant's root
 * services. Built by {@link import('./hubConnectionAcceptor').HubConnectionAcceptor}
 * once per accepted connection: the connection-specific bits (`root`,
 * `upstream`, `transport`, `token`) plus the connection-independent policy the
 * acceptor was configured with (`hubServiceId`, `authorizeClaim`,
 * `installHubAccess`).
 */
export interface ConnectionContext {
    /** The overlay root to install this participant's front doors on. */
    readonly root: HubRpcConnection<unknown>;
    /** The participant's link to the central hub (for `hubGrantedServiceId::register`). */
    readonly upstream: AttachedLink;
    /** The central hub. */
    readonly hub: Hub;
    /** The accepted transport (custom handlers may read attestation off it). */
    readonly transport: IMessageTransport;
    /** The `hubrpc::initialize` token the connection presented (if any). */
    readonly token: string | undefined;
    /** ServiceId the global reflection services are mounted under. */
    readonly hubServiceId: string;
    /** Per-connection claim authorizer (from the acceptor's policy), if any. */
    readonly authorizeClaim?: (requestedPrefix: ServiceId) => { ok: true; } | { ok: false; reason: string; };
    /** Installs the consent front door at the overlay root, if configured. */
    readonly installHubAccess?: (root: HubRpcConnection<unknown>) => void;
}

/**
 * The resolved root services a claiming handler provisions. Every field is
 * optional; {@link provisionRoot} installs the always-on parts (claim/directory
 * front door + consent) unconditionally and the rest only when present.
 */
export interface RootProvision {
    /** Freely-claimable serviceId namespace (`hubGrantedServiceId::get`). */
    readonly grantedServiceIdNamespace?: string;
    /** Lazily-resolved managed identity (`identity::*`). Omit for no identity. */
    readonly resolveIdentity?: () => Promise<Identity>;
    /** Optional per-identity persistent storage (`identity.storage::*`). */
    readonly storage?: ManagedIdentityStorageBackend;
    /** Token-minting front door (`connectionTokenBinder::*`). Omit for none. */
    readonly connectionTokenBinder?: RegisterConnectionTokenBinderOptions;
}

/**
 * A claiming connection handler: installs the participant's root services and
 * returns. Built-ins delegate the actual registration to {@link provisionRoot}.
 */
export type ConnectionHandler = (ctx: ConnectionContext) => void;

/**
 * Selects and (on claim) provisions a connection by its `hubrpc::initialize`
 * token. `handle` is **non-consuming** — it may be called at the pre-handshake
 * gate to answer "would you accept this token?" — and returns a
 * {@link ConnectionHandler} that does the (possibly consuming) installation, or
 * `undefined` to pass to the next factory.
 */
export interface ConnectionHandlerFactory {
    handle(token: string | undefined): ConnectionHandler | undefined;
}

/**
 * Walk `factories` in order; return the first handler that claims `token`, or
 * `undefined` if none do (the caller drops the connection).
 */
export function resolveConnectionHandler(
    factories: readonly ConnectionHandlerFactory[],
    token: string | undefined,
): ConnectionHandler | undefined {
    for (const factory of factories) {
        const handler = factory.handle(token);
        if (handler !== undefined) return handler;
    }
    return undefined;
}

/**
 * Install a participant's root services from a resolved {@link RootProvision}:
 * the always-on claim/directory front door and consent surface, plus (when
 * present) the minting front door and lazy managed identity. This is the single
 * shared installer every built-in handler funnels through.
 */
export function provisionRoot(ctx: ConnectionContext, provision: RootProvision): void {
    registerHubServices(ctx.root, ctx.upstream, {
        hubServiceId: ctx.hubServiceId,
        ...(provision.grantedServiceIdNamespace !== undefined
            ? { grantedServiceIdNamespace: provision.grantedServiceIdNamespace }
            : {}),
        ...(ctx.authorizeClaim !== undefined ? { authorizeClaim: ctx.authorizeClaim } : {}),
    });

    // Consent front door (root form, never forwarded → never gated).
    ctx.installHubAccess?.(ctx.root);

    if (provision.connectionTokenBinder !== undefined) {
        registerConnectionTokenBinderService(ctx.root, provision.connectionTokenBinder);
    }

    if (provision.resolveIdentity !== undefined) {
        registerIdentityServices(ctx.root, {
            resolveIdentity: provision.resolveIdentity,
            ...(provision.storage !== undefined ? { storage: provision.storage } : {}),
        });
    }
}

/**
 * A factory that claims **any** connection (optionally gated by `claims`) and
 * provisions a fixed root. Used for the `anonymous` handler (claims all), the
 * `static` handler (claims a matching token), and dial-in endpoints (claims all,
 * no token).
 */
export function fixedProvisionHandler(
    provision: RootProvision,
    claims: (token: string | undefined) => boolean = () => true,
): ConnectionHandlerFactory {
    return {
        handle: (token) => (claims(token) ? (ctx) => provisionRoot(ctx, provision) : undefined),
    };
}

/** The `anonymous` handler: claims every connection, provisioning `provision`. */
export function anonymousHandler(provision: RootProvision): ConnectionHandlerFactory {
    return fixedProvisionHandler(provision);
}

/** The `static` handler: claims connections whose token equals `value`. */
export function staticTokenHandler(value: string, provision: RootProvision): ConnectionHandlerFactory {
    return fixedProvisionHandler(provision, (token) => token === value);
}

/**
 * The `bound` handler: claims connections whose token is live in `store`, and on
 * claim **redeems** it (single-use) to derive the provisioned identity slot
 * and/or granted serviceId namespace. `resolveSlot` turns a redeemed slot into
 * a lazy identity resolver plus its per-identity storage (injected so this stays
 * node-agnostic).
 */
export function boundTokenHandler(
    store: TokenIdentityStore,
    resolveSlot: (slot: string) => {
        resolveIdentity: () => Promise<Identity>;
        storage: ManagedIdentityStorageBackend;
    },
): ConnectionHandlerFactory {
    return {
        handle: (token) => {
            if (!store.peek(token)) return undefined;
            return (ctx) => {
                const binding = store.redeem(token);
                if (binding === undefined) {
                    throw new Error('bound token was consumed between accept and redeem');
                }
                const provision: RootProvision = {
                    ...(binding.grantedServiceIdNamespace !== undefined
                        ? { grantedServiceIdNamespace: binding.grantedServiceIdNamespace }
                        : {}),
                    ...(binding.identitySlot !== undefined
                        ? resolveSlot(binding.identitySlot)
                        : {}),
                };
                provisionRoot(ctx, provision);
            };
        },
    };
}
