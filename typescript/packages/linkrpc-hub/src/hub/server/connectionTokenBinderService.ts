import { ErrorCode, type LinkRpcConnection, RpcError } from '@hediet/linkrpc';
import { connectionTokenBinderInterface } from './connectionTokenBinder.interfaces';
import type { TokenIdentityBinding, TokenIdentityStore } from './tokenIdentityStore';

export interface RegisterConnectionTokenBinderOptions {
    /** Shared mint/redeem store (the same instance the redeem-side listener reads). */
    readonly store: TokenIdentityStore;
    /**
     * Literal `identitySlot` prefixes this binder may mint identities for (e.g.
     * `["docker/"]`). A `bindConnectionToken({ identitySlot })` call is rejected
     * unless `identitySlot` starts with one of these. Empty → identity binding
     * is disabled (any `identitySlot` request is rejected).
     */
    readonly identitySlotPrefixes: readonly string[];
    /**
     * Literal `serviceIdNamespace` prefixes this binder may grant (e.g.
     * `["docker/"]`). A `bindConnectionToken({ serviceIdNamespace })` call is
     * rejected unless `serviceIdNamespace` starts with one of these. Empty →
     * serviceId granting is disabled (any `serviceIdNamespace` request is
     * rejected).
     */
    readonly serviceIdPrefixes: readonly string[];
    /** Optional per-token TTL (ms); falls back to the store's default. */
    readonly ttlMs?: number;
    /**
     * Mount point when registering as a **forwarded hub service** (reachable via
     * routing as `<serviceId>::connectionTokenBinder`). Omit for the **root
     * form**: an interface-form registration on an overlay root, never forwarded
     * → never gated.
     */
    readonly serviceId?: string;
}

function assertUnderPrefix(
    value: string,
    prefixes: readonly string[],
    field: 'identitySlot' | 'serviceIdNamespace',
    configuredPrefix: 'identitySlotPrefix' | 'serviceIdPrefix',
): void {
    if (!prefixes.some((p) => value.startsWith(p))) {
        throw new RpcError(
            `${field} "${value}" is outside this binder's granted ` +
                `${configuredPrefix} ${JSON.stringify(prefixes)}`,
            ErrorCode.invalidRequest,
        );
    }
}

/**
 * Install `connectionTokenBinder::bindConnectionToken` on `connection`.
 *
 * Two forms, selected by {@link RegisterConnectionTokenBinderOptions.serviceId}:
 *
 * - **root form** (no `serviceId`): installed at a participant's overlay root
 *   (root form, never forwarded → never gated). Safe because only the specific
 *   trusted connection the acceptor installed it on can reach it.
 * - **forwarded form** (`serviceId` set): mounted as a routable hub service so
 *   any participant can discover and call it. Safe only because forwarded calls
 *   go through the hub's forwarded-call gate; the same prefix checks still bound
 *   what any caller may mint.
 *
 * Each call mints a single-use token binding the requested `identitySlot` and/or
 * `serviceIdNamespace`, provided each requested field falls under the matching
 * configured prefix. Omitting a field leaves that axis unbound.
 */
export function registerConnectionTokenBinderService(
    connection: LinkRpcConnection<unknown>,
    options: RegisterConnectionTokenBinderOptions,
): void {
    const { store, identitySlotPrefixes, serviceIdPrefixes, ttlMs, serviceId } = options;
    connection.register(
        connectionTokenBinderInterface,
        {
            bindConnectionToken: ({ identitySlot, serviceIdNamespace }) => {
                const binding: TokenIdentityBinding = {};
                if (identitySlot !== undefined) {
                    assertUnderPrefix(identitySlot, identitySlotPrefixes, 'identitySlot', 'identitySlotPrefix');
                    (binding as { identitySlot?: string }).identitySlot = identitySlot;
                }
                if (serviceIdNamespace !== undefined) {
                    assertUnderPrefix(serviceIdNamespace, serviceIdPrefixes, 'serviceIdNamespace', 'serviceIdPrefix');
                    (binding as { grantedServiceIdNamespace?: string }).grantedServiceIdNamespace = serviceIdNamespace;
                }
                const minted = ttlMs !== undefined ? store.mint(binding, ttlMs) : store.mint(binding);
                return { token: minted.token, expiresAt: minted.expiresAt };
            },
        },
        serviceId !== undefined ? { serviceId } : {},
    );
}
