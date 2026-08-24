import { LinkRpcConnection } from '@hediet/linkrpc';
import { type AttachedLink, type Hub, type IDisposable } from './routing/routingHub';
import type { ServiceId } from '@hediet/linkrpc/hub/common';

/**
 * Register an **in-process** service on `hub` under `serviceId`, returning a
 * {@link RegisteredServiceId} whose `connection` serves its interfaces.
 *
 * This is the hubv2 replacement for the v1 `hub.attachParticipant(pair.a)` +
 * `LinkRpcConnection.fromTransport(pair.b)` + `enableReflection({ serviceId })`
 * dance that every built-in extension service performed. It:
 *
 * 1. attaches an in-memory link to the hub and claims `serviceId` on it, so
 *    the hub routes every fully-qualified `serviceId::…` call to this service;
 * 2. exposes a {@link LinkRpcConnection} whose registered interfaces answer
 *    those calls (register them with `{ serviceId }`); and
 * 3. enables reflection under `serviceId` so the hub's aggregating
 *    `directory::list` surfaces this service.
 *
 * Disposing the returned handle (`svc.dispose()`) closes the connection and
 * detaches the link, releasing the claimed prefix.
 *
 * Unlike an accepted *participant* (which gets a {@link RootOverlay} and only
 * reaches the hub through its uplink), an in-process service is attached
 * directly to the hub as a prefix owner. It is fully trusted — no provenance,
 * identity, or forwarded-call gating applies to traffic it receives.
 */
export function hubRegisterServiceId(hub: Hub, serviceId: ServiceId): RegisteredServiceId {
    const link = hub.attachOut();
    link.claimPrefix(serviceId);

    const connection = LinkRpcConnection.fromTransport(link.transport);
    connection.enableReflection({ serviceId });
    return new RegisteredServiceId(connection, link);
}

/**
 * Handle to an in-process service registered on a {@link Hub} via
 * {@link hubRegisterServiceId}. Owns both the {@link LinkRpcConnection} the
 * service serves its interfaces on and the hub {@link AttachedLink} that routes
 * traffic to it. {@link dispose} closes the connection and detaches the link
 * (releasing the claimed prefix) — wire it into the owning feature's disposal.
 */
export class RegisteredServiceId implements IDisposable {
    public constructor(
        /** Serve the service's interfaces here (register them with `{ serviceId }`). */
        public readonly connection: LinkRpcConnection,
        private readonly _link: AttachedLink,
    ) { }

    public dispose(): void {
        this.connection.close();
        this._link.dispose();
    }
}
