/**
 * The linkrpc **signed-object** standard: one rule for committing a
 * signature (and a content hash) over any JSON object.
 *
 * > The signature `obj.$linkrpcSignature[domain]` covers
 * > `jcs({ [domainValue(domain)]: obj without $linkrpcSignature and $linkrpcUnsigned })`.
 *
 * Both reserved keys are stripped before canonicalization — on **every**
 * object, call or capability alike:
 *
 *  - {@link LINKRPC_SIGNATURE_KEY} (`$linkrpcSignature`) holds the signature
 *    itself (a domain-keyed map of `{ keyId, sig }` entries). It can't sign
 *    itself, so it's excluded.
 *  - {@link LINKRPC_UNSIGNED_KEY} (`$linkrpcUnsigned`) holds extrinsic
 *    *attachments* (e.g. the presented capability bag) authored by someone
 *    other than this signer, so it's excluded too.
 *
 * Domain separation is intrinsic: the per-domain {@link signingDomainValue}
 * is the sole key of the canonicalized wrapper object. A `"call"` signature
 * can therefore never verify as a `"capability"` (or vice-versa). The domain
 * is *supplied by context* by signer and verifier;
 * the on-wire `$linkrpcSignature` key is a convenience index, never a trust
 * claim.
 *
 * This module is pure (no private keys, no `crypto.verify`): it only defines
 * the canonical bytes. Signing/verifying live in `../identity/signedObject`.
 */

import { jcsCanonicalizeBytes } from "./jcs";
import { sha256 } from "../crypto/sha256";
import { bytesToBase64Url, type KeyId } from "../crypto/cryptoProvider";

/** An open signature domain. Each gets a distinct {@link signingDomainValue}. */
export type SignDomain = string;

/** Reserved wire-key: the signature map `{ [domain]: SignatureEnvelope }`. */
export const LINKRPC_SIGNATURE_KEY = "$linkrpcSignature";

/** Reserved wire-key: extrinsic unsigned attachments (e.g. the capability bag). */
export const LINKRPC_UNSIGNED_KEY = "$linkrpcUnsigned";

/** Reserved wire-key: signed call meta, present only on calls (dodges the JSON-RPC param namespace). */
export const LINKRPC_META_KEY = "$hubrpc";

/**
 * One domain's signature on the wire: which key signed ({@link KeyId}, an
 * **unsigned** routing hint) plus the raw `base64url(sig)`. Lying about
 * `keyId` only makes verification fail (the resolver rejects or the key
 * mismatches), so it carries no integrity claim and is excluded from the
 * signed bytes along with the rest of `$linkrpcSignature`.
 */
export interface SignatureEnvelope {
    /** The key the signer used (`"key:..."`). Resolved against the principal. */
    readonly keyId: KeyId;
    /** `base64url` of the raw signature over {@link signingInput}. */
    readonly sig: string;
}

/** Per-domain signature map carried under {@link LINKRPC_SIGNATURE_KEY}. */
export type Signatures = { readonly [D in SignDomain]?: SignatureEnvelope };

/** Documentary brand for `base64url(sha256(signingInput(domain, T)))`. */
export type Base64Sha256<T = unknown> = string & { readonly __sha256Of?: T };

/**
 * The domain-separation key. It includes the frozen signature-suite version
 * and becomes the sole key of the object passed to JCS.
 */
export function signingDomainValue(domain: SignDomain): string {
    return `linkrpc-sig/v1/${domain}`;
}

/**
 * THE bytes a signature commits to (and a content hash hashes) for `obj` in
 * `domain`: `jcs({ [domainValue(domain)]: obj minus the two reserved keys })`.
 */
export function signingInput(domain: SignDomain, obj: object): Uint8Array {
    const signed = { ...(obj as Record<string, unknown>) };
    delete signed[LINKRPC_SIGNATURE_KEY];
    delete signed[LINKRPC_UNSIGNED_KEY];
    return jcsCanonicalizeBytes({ [signingDomainValue(domain)]: signed });
}

/**
 * Content identity of a signed object: `base64url(sha256(signingInput(...)))`.
 * The single operation behind both a capability's `callBind.payloadHash`
 * (domain `"call"`) and a child capability's `parentHash` (domain
 * `"capability"`).
 */
export function signedHash<T extends object>(domain: SignDomain, obj: T): Base64Sha256<T> {
    return bytesToBase64Url(sha256(signingInput(domain, obj))) as Base64Sha256<T>;
}

/** Read the signature envelope for `domain` off an object's `$linkrpcSignature` map. */
export function readSignature(obj: object, domain: SignDomain): SignatureEnvelope | undefined {
    const sigs = (obj as Record<string, unknown>)[LINKRPC_SIGNATURE_KEY] as Signatures | undefined;
    if (sigs === null || typeof sigs !== "object") return undefined;
    const entry = sigs[domain];
    if (entry === null || typeof entry !== "object") return undefined;
    const { keyId, sig } = entry as { keyId?: unknown; sig?: unknown };
    if (typeof keyId !== "string" || typeof sig !== "string") return undefined;
    return { keyId, sig };
}

/** The {@link KeyId} the signer used for `domain` (the unsigned routing hint), if any. */
export function getKeyId(obj: object, domain: SignDomain): KeyId | undefined {
    return readSignature(obj, domain)?.keyId;
}

/**
 * Return a copy of `obj` with `$linkrpcSignature[domain]` set to `envelope`,
 * preserving any sibling-domain signatures already present.
 */
export function withSignature<T extends object>(obj: T, domain: SignDomain, envelope: SignatureEnvelope): T & { $linkrpcSignature: Record<string, SignatureEnvelope> } {
    const prev = (obj as Record<string, unknown>)[LINKRPC_SIGNATURE_KEY] as Signatures | undefined;
    return { ...obj, [LINKRPC_SIGNATURE_KEY]: { ...prev, [domain]: envelope } } as T & { $linkrpcSignature: Record<string, SignatureEnvelope> };
}
