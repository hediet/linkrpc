import { CapBag } from './capBag';
import type { SigningIdentity } from './identity';
import type { PrincipalId } from '../crypto/cryptoProvider';
import type { SignedCapability } from './capability';

/**
 * A signing identity bundled with its durable capability set. The
 * {@link SigningIdentity} is fixed for the life of the principal; the
 * {@link CapBag} is mutable and extensible — caps accumulate as the peer grants
 * them.
 *
 * Transient, per-call (one-shot) grants are deliberately NOT part of a
 * principal: that is a separate policy, see `OneShotCapStaging`.
 *
 * Lives in its own module (rather than alongside `SigningSender`) so the
 * `SigningSender` ⇄ `createManagedPrincipal` factory cycle does not run through
 * a top-level `class … extends Principal`: such a cycle would hit a TDZ
 * ("Class extends value undefined") depending on module evaluation order.
 */
export class Principal {
    public static async create(
        identity: SigningIdentity,
        capabilities: readonly SignedCapability[] = [],
    ): Promise<Principal> {
        const capBag = await CapBag.load();
        await capBag.add(...capabilities);
        return new Principal(identity, capBag);
    }

    constructor(
        public readonly identity: SigningIdentity,
        public readonly capBag: CapBag,
    ) { }

    public get id(): PrincipalId {
        return this.identity.publicSigningIdentity.principal;
    }
}
