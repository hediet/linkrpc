/**
 * Identity primitives. linkrpc itself is identity-agnostic; this module
 * defines the shared types. No crypto code lives here — the crypto API is
 * `./crypto` (backed by the Web Crypto implementation in
 * `./ed25519CryptoProvider`).
 */

/** Raw Ed25519 public key (32 bytes). */
export type PublicKey = Uint8Array;

/** Raw Ed25519 private key (32 bytes — seed form). */
export type PrivateKey = Uint8Array;

/** Raw Ed25519 signature (64 bytes). */
export type Signature = Uint8Array;

/**
 * A **principal**: an identity's stable, opaque name. In Phase 1 every
 * principal is *perpetual* and self-describing — its genesis signing key is
 * embedded verbatim:
 *
 *     principal = "id:" + keyId            (e.g. "id:key:<b64url(pubKey)>")
 *
 * So the genesis check is pure string equality (`"id:" + keyId === principal`)
 * and no key-binding records are ever needed. Treat as opaque; construct via
 * {@link principalForPublicKey} and resolve a verifying key via
 * {@link resolveSigningKey}.
 */
export type PrincipalId = string;

/**
 * A **keyId**: names the signing key that produced a signature. In Phase 1 the
 * only form is an *inline* key — the public key encoded verbatim:
 *
 *     keyId = "key:" + b64url(pubKey)
 *
 * (Future forms, e.g. `"keydoc:" + b64url(sha256(jcs(doc)))`, are resolved
 * through bindings — see the design doc — but Phase 1 needs none.)
 */
export type KeyId = string;

export interface Keypair {
    readonly publicKey: PublicKey;
    readonly privateKey: PrivateKey;
}

/** Raw X25519 keypair. Both halves are 32 bytes. */
export interface X25519Keypair {
    readonly publicKey: Uint8Array;
    readonly privateKey: Uint8Array;
}

// ---- base64url codec (no padding) ----------------------------------------

const _b64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const _b64UrlReverse: Record<string, number> = (() => {
    const m: Record<string, number> = {};
    for (let i = 0; i < _b64UrlAlphabet.length; i++) m[_b64UrlAlphabet[i]] = i;
    return m;
})();

export function bytesToBase64Url(bytes: Uint8Array): string {
    let out = "";
    let i = 0;
    for (; i + 3 <= bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += _b64UrlAlphabet[(n >> 18) & 63]
            + _b64UrlAlphabet[(n >> 12) & 63]
            + _b64UrlAlphabet[(n >> 6) & 63]
            + _b64UrlAlphabet[n & 63];
    }
    const rem = bytes.length - i;
    if (rem === 1) {
        const n = bytes[i] << 16;
        out += _b64UrlAlphabet[(n >> 18) & 63] + _b64UrlAlphabet[(n >> 12) & 63];
    } else if (rem === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += _b64UrlAlphabet[(n >> 18) & 63]
            + _b64UrlAlphabet[(n >> 12) & 63]
            + _b64UrlAlphabet[(n >> 6) & 63];
    }
    return out;
}

export function base64UrlToBytes(s: string): Uint8Array {
    const len = s.length;
    const fullGroups = Math.floor(len / 4);
    const rem = len % 4;
    if (rem === 1) throw new Error("base64UrlToBytes: invalid length");
    const outLen = fullGroups * 3 + (rem === 0 ? 0 : rem - 1);
    const out = new Uint8Array(outLen);
    let oi = 0;
    let i = 0;
    for (let g = 0; g < fullGroups; g++, i += 4) {
        const n = (_lookup(s, i) << 18) | (_lookup(s, i + 1) << 12) | (_lookup(s, i + 2) << 6) | _lookup(s, i + 3);
        out[oi++] = (n >> 16) & 0xff;
        out[oi++] = (n >> 8) & 0xff;
        out[oi++] = n & 0xff;
    }
    if (rem === 2) {
        const n = (_lookup(s, i) << 18) | (_lookup(s, i + 1) << 12);
        out[oi++] = (n >> 16) & 0xff;
    } else if (rem === 3) {
        const n = (_lookup(s, i) << 18) | (_lookup(s, i + 1) << 12) | (_lookup(s, i + 2) << 6);
        out[oi++] = (n >> 16) & 0xff;
        out[oi++] = (n >> 8) & 0xff;
    }
    return out;
}

function _lookup(s: string, i: number): number {
    const v = _b64UrlReverse[s[i]];
    if (v === undefined) throw new Error(`base64UrlToBytes: invalid char at ${i}`);
    return v;
}

// ---- principals & keyIds (the identity ⇄ key seam) -----------------------

/** Role-tag prefix on a {@link KeyId}'s inline-key form. */
export const KEY_ID_PREFIX = "key:";

/** Role-tag prefix that wraps a genesis {@link KeyId} into a {@link PrincipalId}. */
export const PRINCIPAL_PREFIX = "id:";

/** The inline {@link KeyId} for a raw public key: `"key:" + b64url(pk)`. */
export function keyIdForPublicKey(pk: PublicKey): KeyId {
    return KEY_ID_PREFIX + bytesToBase64Url(pk);
}

/** The perpetual {@link PrincipalId} for a raw public key: `"id:key:" + b64url(pk)`. */
export function principalForPublicKey(pk: PublicKey): PrincipalId {
    return PRINCIPAL_PREFIX + keyIdForPublicKey(pk);
}

/**
 * The genesis {@link KeyId} embedded in a perpetual {@link PrincipalId}
 * (`"id:" + keyId`). Throws if `principal` is not a well-formed `id:` name.
 */
export function keyIdForPrincipal(principal: PrincipalId): KeyId {
    if (!principal.startsWith(PRINCIPAL_PREFIX)) {
        throw new Error(`malformed principal (missing "${PRINCIPAL_PREFIX}" prefix): ${principal}`);
    }
    return principal.slice(PRINCIPAL_PREFIX.length);
}

/**
 * The raw public key carried inline by a `"key:"` {@link KeyId}. Throws on a
 * missing prefix or malformed base64url.
 */
export function publicKeyForKeyId(keyId: KeyId): PublicKey {
    if (!keyId.startsWith(KEY_ID_PREFIX)) {
        throw new Error(`unsupported keyId (expected "${KEY_ID_PREFIX}" prefix): ${keyId}`);
    }
    return base64UrlToBytes(keyId.slice(KEY_ID_PREFIX.length));
}

/** Arguments to {@link resolveSigningKey}. */
export interface ResolveSigningKeyArgs {
    /** The identity the signature claims to be from. */
    readonly principal: PrincipalId;
    /** Which key (per `$linkrpcSignature[domain].keyId`) is claimed to have signed. */
    readonly keyId: KeyId;
    /** Presented key-binding records. Unused in Phase 1 (perpetual ids need none). */
    readonly bindings?: Record<KeyId, unknown>;
    /** Time the signature was made (e.g. `signedAtMs`). Unused in Phase 1. */
    readonly timeMs?: number;
}

/**
 * Resolve the verifying public key for `(principal, keyId)`, or `undefined`
 * to **reject** (fail closed). This is the single seam every verifier goes
 * through, replacing the old "the id *is* the key" decode.
 *
 * Phase 1 supports only inline genesis keys: the `keyId` must be a `"key:"`
 * form and the principal must be exactly `"id:" + keyId` (genesis
 * self-certification by string equality). `keydoc:`/rotation forms resolve
 * through `bindings`/`timeMs` later and are intentionally not handled here.
 */
export function resolveSigningKey(args: ResolveSigningKeyArgs): { publicKey: PublicKey } | undefined {
    const { principal, keyId } = args;
    if (!keyId.startsWith(KEY_ID_PREFIX)) {
        return undefined; // keydoc:/rotation — deferred
    }
    if (PRINCIPAL_PREFIX + keyId !== principal) {
        return undefined; // not this principal's genesis key
    }
    try {
        return { publicKey: base64UrlToBytes(keyId.slice(KEY_ID_PREFIX.length)) };
    } catch {
        return undefined; // malformed base64url
    }
}
