import { number, object, optional, string } from 'zod/mini';
import { defineInterface, requestType } from '@hediet/linkrpc';

/**
 * Privileged **connection-token binder**, served by a trusted, hub-spawned
 * endpoint that carries a `connectionTokenBinder` grant. It mints a single-use
 * `linkrpc::initialize` token that binds up to two independent things for a
 * **future** peer connection:
 *
 * - an `identitySlot` — the managed identity the peer inherits (`identity::*`),
 *   authorized against the binder's `identitySlotPrefix`; and
 * - a `serviceIdNamespace` — the serviceId namespace the peer may claim freely
 *   (`hubGrantedServiceId::get`), authorized against the binder's
 *   `serviceIdPrefix`.
 *
 * Both request fields are optional and authorized independently: omit a field
 * to leave that axis unbound. The peer later presents the returned token in its
 * `linkrpc::initialize` handshake on a `managedIdentity: { mode: "fromToken" }`
 * and/or `grantedServiceId: { mode: "fromToken" }` listener, which redeems it.
 *
 * This is the broker side of the token model: the caller asks the hub to issue a
 * credential for **another** (future) connection — distinct from `identity::*`
 * (which is about the caller's *own* identity). Minting is authorized purely by
 * the binder's configured prefixes: each requested field must fall under its
 * corresponding prefix.
 */
export const connectionTokenBinderInterface = defineInterface(
    {
        id: 'connectionTokenBinder',
        description:
            'Privileged connection-token binder: mints single-use ' +
            'linkrpc::initialize tokens binding an identity slot and/or a ' +
            'serviceId namespace, for redemption by a peer on a `managedIdentity` ' +
            '/ `grantedServiceId` { mode: "fromToken" } listener. Each field is ' +
            "authorized against the binder's identitySlotPrefix / serviceIdPrefix.",
    },
    {
        bindConnectionToken: requestType(
            object({
                identitySlot: optional(string()),
                serviceIdNamespace: optional(string()),
            }),
            object({ token: string(), expiresAt: number() }),
        ),
    },
);
