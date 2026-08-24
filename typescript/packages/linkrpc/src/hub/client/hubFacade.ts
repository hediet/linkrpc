import type { LinkRpcConnection } from '../../connection/linkRpcConnection';
import { hubGrantedServiceIdInterface } from '../common/hub.interfaces';

/**
 * Description of the services a consumer will need, presented to the user
 * up-front so access can be approved before the first call. Each named
 * *dependency* ("slot") lists the interfaces the chosen service must
 * implement and the members the consumer intends to call.
 */
export interface SlotPrerequest {
    readonly consumer: { readonly name: string; readonly purpose: string; };
    readonly dependencies: Readonly<
        Record<string, {
            readonly interfaces: readonly { readonly id: string; }[];
            readonly members: readonly {
                readonly interfaceId: string;
                readonly member: { readonly exact: string; };
            }[];
        }>
    >;
}

/** Handle for a set of slots reserved via {@link Hub.prerequestSlots}. */
export interface SlotReservation {
    /** Resolve the reserved slots into connected service clients. */
    resolve(): Promise<never>;
}

/**
 * Thin façade over the hub's own serviceId-routed services
 * (`hubGrantedServiceId`, `hubAccess`, …). The hub is not a single object on
 * the wire — it is a set of services the connection can `get`. This groups the
 * common connection calls so callers don't hand-route interface clients.
 */
export class Hub {
    constructor(private readonly _connection: LinkRpcConnection) { }

    /** `hubGrantedServiceId::get` — where am I and which serviceId namespace may I claim. */
    public getConnectionInfo() {
        return this._connection.get(hubGrantedServiceIdInterface).get({});
    }

    /**
     * Reserve the slots a consumer will need so the user can approve them
     * ahead of the first call. NOT YET IMPLEMENTED by the hub — the
     * returned reservation throws on {@link SlotReservation.resolve}.
     */
    public prerequestSlots(_request: SlotPrerequest): SlotReservation {
        return {
            resolve: async (): Promise<never> => {
                throw new Error('not implemented: hub.prerequestSlots / slot resolution');
            },
        };
    }

    /**
     * Claim a serviceId namespace for this connection so it may register
     * services under it, via `hubGrantedServiceId::register`.
     *
     * The claim is auto-granted from the connection's provenance when
     * `serviceIdNamespace` is at/under the connection's
     * `grantedServiceIdNamespace` (see {@link getConnectionInfo}) — no
     * signature or capability needed. Claims **outside** the granted namespace
     * are rejected here; route those through the admin-gated
     * `<hubServiceId>::hubServiceIdRegistry::registerServiceId` door instead.
     *
     * Resolves once the namespace is owned by this connection (idempotent for
     * a namespace this connection already owns). Rejects when the hub denies
     * the claim — e.g. the namespace is owned by another identity, or the
     * caller lacks admin authority outside its granted namespace.
     *
     * `requestPermissionIfDenied` is a hint for the future interactive
     * admin-approval flow; the hub does not yet expose one, so denial always
     * surfaces as a rejection regardless of the flag.
     */
    public async registerServiceIdNamespace(
        serviceIdNamespace: string,
        _opts?: { readonly requestPermissionIfDenied?: boolean; },
    ): Promise<void> {
        await this._connection
            .get(hubGrantedServiceIdInterface)
            .register({ serviceId: serviceIdNamespace });
    }

    /**
     * Claim this connection's provenance-granted serviceId namespace in one
     * step: read `grantedServiceIdNamespace` via {@link getConnectionInfo},
     * then {@link registerServiceIdNamespace} it, returning the claimed
     * `serviceId` so the caller can mount services under it.
     *
     * This is the batteries-included version of the
     * `hubGrantedServiceId::get` → `hubGrantedServiceId::register` dance a
     * service-exposing participant performs right after connecting.
     *
     * Throws when the hub granted this connection no namespace (an empty
     * `grantedServiceIdNamespace`, meaning "claim nothing freely") — there is
     * nothing to register, and any service prefix would have to be claimed
     * through the admin-gated
     * `<hubServiceId>::hubServiceIdRegistry::registerServiceId` door instead.
     */
    public async claimGrantedServiceIdNamespace(): Promise<{ readonly serviceId: string; }> {
        const { grantedServiceIdNamespace } = await this.getConnectionInfo();
        if (!grantedServiceIdNamespace) {
            throw new Error(
                'hubGrantedServiceId::get returned an empty granted namespace; ' +
                'nothing to claim (register a prefix through the admin-gated ' +
                'hubServiceIdRegistry::registerServiceId door instead)',
            );
        }
        await this.registerServiceIdNamespace(grantedServiceIdNamespace);
        return { serviceId: grantedServiceIdNamespace };
    }
}

/** Wrap a connection in a {@link Hub} façade. */
export function hubFromConnection(connection: LinkRpcConnection): Hub {
    return new Hub(connection);
}
