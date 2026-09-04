/**
 * Identity-layer signing over the {@link signingInput linkrpc signed-object
 * standard}. These need a {@link SigningIdentity} / public key, so they live
 * in the identity layer; the pure byte definitions stay in
 * `../protocol/signedObject`.
 */

import { base64UrlToBytes, bytesToBase64Url, type PrincipalId, resolveSigningKey } from "../crypto/cryptoProvider";
import * as crypto from "../crypto/crypto";
import {
    type SignDomain,
    readSignature,
    signingInput,
    withSignature,
} from "../protocol/signedObject";
import type { SigningIdentity } from "./identity";

export {
    HUBRPC_META_KEY,
    HUBRPC_SIGNATURE_KEY,
    HUBRPC_UNSIGNED_KEY,
    LINKRPC_META_KEY,
    LINKRPC_SIGNATURE_KEY,
    LINKRPC_UNSIGNED_KEY,
    type Base64Sha256,
    type SignDomain,
    type SignatureEnvelope,
    type Signatures,
    getKeyId,
    readSignature,
    signedHash,
    signingDomainValue,
    signingInput,
} from "../protocol/signedObject";

/**
 * Sign `obj` in `domain` with `identity`, returning a copy with
 * `$hubrpcSignature[domain]` populated (sibling signatures preserved). The
 * signature commits to {@link signingInput}`(domain, obj)`; the signer's
 * {@link SigningIdentity.publicSigningIdentity}.keyId is stamped alongside it
 * as the (unsigned) routing hint.
 */
export async function signObject<T extends object>(
    domain: SignDomain,
    obj: T,
    identity: SigningIdentity,
): Promise<T & { $hubrpcSignature: Record<string, { keyId: string; sig: string }> }> {
    const sig = await identity.sign(signingInput(domain, obj));
    return withSignature(obj, domain, {
        keyId: identity.publicSigningIdentity.keyId,
        sig: bytesToBase64Url(sig),
    }) as T & { $hubrpcSignature: Record<string, { keyId: string; sig: string }> };
}

/**
 * Verify `obj`'s `domain` signature against `signerKey` (a raw public key).
 * Returns `false` (never throws) on a missing/malformed signature.
 */
export async function verifyObject(
    domain: SignDomain,
    obj: object,
    signerKey: Uint8Array,
): Promise<boolean> {
    const env = readSignature(obj, domain);
    if (env === undefined) return false;
    let sigBytes: Uint8Array;
    try {
        sigBytes = base64UrlToBytes(env.sig);
    } catch {
        return false;
    }
    return crypto.verify(signerKey, signingInput(domain, obj), sigBytes);
}

/**
 * Convenience: verify against a signer {@link PrincipalId}. Reads the keyId off
 * `$hubrpcSignature[domain]`, resolves the verifying key via
 * {@link resolveSigningKey} (fail-closed on an unresolvable/mismatched key),
 * then checks the signature.
 */
export async function verifyObjectByPrincipal(
    domain: SignDomain,
    obj: object,
    principal: PrincipalId,
    signedAtMs?: number,
): Promise<boolean> {
    const env = readSignature(obj, domain);
    if (env === undefined) return false;
    const resolved = resolveSigningKey({
        principal,
        keyId: env.keyId,
        ...(signedAtMs !== undefined ? { timeMs: signedAtMs } : {}),
    });
    if (resolved === undefined) return false;
    return verifyObject(domain, obj, resolved.publicKey);
}
