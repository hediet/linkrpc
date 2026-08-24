import type { IRequestSender } from '../connection/channel';
import { Principal } from './principal';
import type { Identity } from './identity';
import { CapBag } from './capBag';
import { createManagedIdentity, type ManagedIdentityStorage } from './managedIdentity';

/**
 * A {@link Principal} that also exposes the executor-backed per-identity
 * {@link ManagedIdentityStorage}. Returned by {@link createManagedPrincipal}
 * so callers can persist their own app state (e.g. a resolved serviceId)
 * alongside the granted capabilities, using the very same durable store the
 * {@link CapBag} hydrates from — no second storage wiring required.
 */
export class PrincipalWithStore extends Principal {
    public declare readonly identity: Identity;

    constructor(
        identity: Identity,
        capBag: CapBag,
        public readonly store: ManagedIdentityStorage,
    ) {
        super(identity, capBag);
    }
}

/**
 * Executor-managed principal: the peer signs for us through its
 * `identity::sign` overlay (we never hold a private key). Bootstrapped purely
 * from the outbound `sender` — no side effects on any connection — and caps
 * persist in the executor-backed per-identity storage. Works over any
 * transport whose peer serves the identity overlay (hub *or* stdio).
 *
 * Call this exactly once per channel: it performs the `identity::*` handshake
 * and hydrates the {@link CapBag} from storage. The returned
 * {@link PrincipalWithStore} additionally surfaces that same durable
 * {@link ManagedIdentityStorage} as `store`.
 */
export async function createManagedPrincipal(
    sender: IRequestSender<unknown>,
): Promise<PrincipalWithStore> {
    const identity = await createManagedIdentity(sender);
    const capBag = await CapBag.load({ storage: identity.storage });
    return new PrincipalWithStore(identity, capBag, identity.storage);
}
