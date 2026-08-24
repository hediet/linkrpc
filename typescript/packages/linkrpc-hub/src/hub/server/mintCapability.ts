/**
 * Admin-issued capability minting for the v2 consent engine.
 *
 * v1 issued capabilities through the hub (`proposeCapability` +
 * `signProposedCapability`). In v2 the hub no longer signs anything — the
 * consent engine owns an admin {@link SigningIdentity} and mints capabilities
 * directly. A {@link SigningIdentity} signs over arbitrary bytes with its
 * Ed25519 key, which is exactly what {@link signCapability} needs, so this is
 * a thin wrapper that assembles a {@link Capability} and signs it.
 */

import { bytesToBase64Url, type PrincipalId } from '@hediet/linkrpc';
import type {
    Capability,
    Permission,
    SignedCapability,
} from '@hediet/linkrpc';
import type { Base64Sha256 } from '@hediet/linkrpc';
import { signCapability } from '@hediet/linkrpc';
import type { SigningIdentity } from '@hediet/linkrpc';

export interface MintCapabilityOptions {
    /** The admin identity that issues (signs) the capability. */
    readonly issuer: SigningIdentity;
    /** The holder allowed to wield the capability. */
    readonly audience: PrincipalId;
    /** What the holder may do. A call matches iff it matches any permission. */
    readonly permissions: readonly Permission[];
    /** Unix milliseconds. Omit for a capability that never expires. */
    readonly expiresAtMs?: number;
    /**
     * Per-cap distinguisher (base64url). Defaults to a fresh random 128-bit
     * value.
     */
    readonly nonce?: string;
    /** Delegation parent: the content hash (`signedHash("capability", parent)`) of the parent capability. */
    readonly parentHash?: Base64Sha256<Capability>;
}

/**
 * Assemble and sign a {@link Capability} with the admin identity.
 *
 * This replaces the v1 `hub.proposeCapability` / `signProposedCapability`
 * pair: the consent engine decides the permissions (e.g. from
 * {@link resolveAccessCandidates} + the user's consent selection) and mints
 * the capability bound to the consumer's PrincipalId as `audience`.
 */
export async function mintCapability(options: MintCapabilityOptions): Promise<SignedCapability> {
    const capability: Capability = {
        issuer: options.issuer.publicSigningIdentity.principal,
        audience: options.audience,
        permissions: [...options.permissions],
        nonce: options.nonce ?? randomNonce(),
        ...(options.expiresAtMs !== undefined ? { expiresAtMs: options.expiresAtMs } : {}),
        ...(options.parentHash !== undefined ? { parentHash: options.parentHash } : {}),
    };
    return signCapability(capability, options.issuer);
}

function randomNonce(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
}
