import type { IRequestSender, SigningCallCtx } from '../../index';
import { hubGrantedServiceIdInterface } from './hub.interfaces';

/**
 * Claim a serviceId prefix within this connection's provenance-granted
 * namespace via `hubGrantedServiceId::register` (no capability needed).
 * Resolves once the claim is registered. Rejects when the prefix is outside
 * the granted namespace or already owned.
 */
export async function registerGrantedServiceId(
    sender: IRequestSender<SigningCallCtx>,
    serviceId: string,
): Promise<void> {
    await sender.sendRequest(
        `${hubGrantedServiceIdInterface.info.id}::register`,
        { serviceId } as never,
    );
}
