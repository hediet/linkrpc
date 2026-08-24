/**
 * The single place in linkrpc that touches the Web Crypto API
 * (`globalThis.crypto.subtle`). These low-level functions are surfaced to the
 * rest of the codebase through the `./crypto` facade — import from there, not
 * from this file.
 *
 * Web Crypto is available unchanged in modern browsers and in Node 20+, so
 * there is no longer a node-specific vs. web-specific implementation — this
 * one file works in both runtimes.
 */
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import {
    base64UrlToBytes,
    type Keypair,
    type PrivateKey,
    type PublicKey,
    type Signature,
    type X25519Keypair,
} from "./cryptoProvider";

// RFC 8410 ASN.1 DER prefix wrapping a raw 32-byte Ed25519 seed into PKCS8 —
// Web Crypto's `importKey` accepts raw bytes only for public keys, not for
// Ed25519 private keys, so we have to wrap the seed every time we sign.
const _PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

// Same PKCS8 wrapper for a raw 32-byte X25519 scalar — identical to the Ed25519
// prefix except the algorithm OID byte (0x6e = X25519 instead of 0x70 = Ed25519).
const _PKCS8_X25519_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

function _wrapPkcs8(seed: Uint8Array, prefix: Uint8Array = _PKCS8_PREFIX): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(prefix.length + seed.length);
    out.set(prefix, 0);
    out.set(seed, prefix.length);
    return out;
}

const _ALG = "Ed25519";

// ---- X25519 + HPKE-base / DHKEM(X25519,HKDF-SHA256) / HKDF-SHA256 /
//      AES-256-GCM (RFC 9180 ciphersuite 0x0020/0x0001/0x0002) ----
//
// The HPKE composition (HKDF, DHKEM encap/decap, key schedule) is provided by
// `@hpke/core` — a Web Crypto-based, RFC 9180 test-vector-verified
// implementation with no native dependencies that runs unchanged in modern
// browsers and Node 20+. We only bridge between its CryptoKey-oriented API and
// the raw-bytes contract used elsewhere in linkrpc, and assemble the wire blob
// as `enc (32 B) || ciphertext || tag (16 B)`.

const _ENC_LEN = 32; // DHKEM(X25519) encapsulated-key length
const _TAG_LEN = 16; // AES-256-GCM authentication-tag length

// Built lazily on first use rather than at module load. Constructing the
// `@hpke/core` `CipherSuite` eagerly is a top-level side effect that bundlers
// cannot prove pure, which pins `@hpke/*` into every bundle that merely reaches
// this module (e.g. a stdio-only client that never signs/encrypts). Deferring
// the construction keeps module evaluation side-effect-free so the HPKE code
// can be tree-shaken away when none of the functions below are called.
let _hpkeSuiteInstance: CipherSuite | undefined;
function _hpkeSuite(): CipherSuite {
    return (_hpkeSuiteInstance ??= new CipherSuite({
        kem: new DhkemX25519HkdfSha256(),
        kdf: new HkdfSha256(),
        aead: new Aes256Gcm(),
    }));
}

function _concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

// Copy a (possibly offset) view into a fresh, exact-length ArrayBuffer — the
// shape `@hpke/core` expects for key material and message inputs.
function _toBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ---- Public function API ---------------------------------------------------
// These are the low-level crypto primitives; the `./crypto` facade re-exports
// them as the package's controlled crypto API.

/** Generate a fresh Ed25519 keypair (raw 32-byte seed + 32-byte public key). */
export async function generateEd25519Keypair(): Promise<Keypair> {
    const kp = (await crypto.subtle.generateKey(_ALG, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    return {
        publicKey: pub,
        privateKey: new Uint8Array(pkcs8.subarray(pkcs8.length - 32)),
    };
}

/** Ed25519 sign `message` with a raw 32-byte seed private key. */
export async function ed25519Sign(privateKey: PrivateKey, message: Uint8Array): Promise<Signature> {
    const key = await crypto.subtle.importKey("pkcs8", _wrapPkcs8(privateKey), _ALG, false, ["sign"]);
    const sig = await crypto.subtle.sign(_ALG, key, new Uint8Array(message));
    return new Uint8Array(sig);
}

/** Ed25519 verify. Returns `false` (never throws) on malformed input. */
export async function ed25519Verify(publicKey: PublicKey, message: Uint8Array, sig: Signature): Promise<boolean> {
    try {
        const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), _ALG, false, ["verify"]);
        return await crypto.subtle.verify(_ALG, key, new Uint8Array(sig), new Uint8Array(message));
    } catch {
        return false;
    }
}

/**
 * Deterministically derive an Ed25519 keypair from a raw 32-byte seed (the
 * seed *is* the private key). The public key is recovered via a JWK round-trip
 * (`importKey` pkcs8 → `exportKey` jwk → `x`). For tests / reproducible
 * identities — NOT for production key generation, which must be random.
 */
export async function ed25519KeypairFromSeed(seed: Uint8Array): Promise<Keypair> {
    if (seed.length !== 32) throw new Error("ed25519KeypairFromSeed: seed must be 32 bytes");
    const key = await crypto.subtle.importKey("pkcs8", _wrapPkcs8(seed), _ALG, true, ["sign"]);
    const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
    if (!jwk.x) throw new Error("ed25519KeypairFromSeed: failed to derive public key");
    return { publicKey: base64UrlToBytes(jwk.x), privateKey: new Uint8Array(seed) };
}

/**
 * Deterministically derive an X25519 keypair from a raw 32-byte scalar (the
 * scalar *is* the private key). Public key recovered via the same JWK
 * round-trip. For tests / reproducible identities only.
 */
export async function x25519KeypairFromSeed(seed: Uint8Array): Promise<X25519Keypair> {
    if (seed.length !== 32) throw new Error("x25519KeypairFromSeed: seed must be 32 bytes");
    const key = await crypto.subtle.importKey(
        "pkcs8",
        _wrapPkcs8(seed, _PKCS8_X25519_PREFIX),
        "X25519",
        true,
        ["deriveBits"],
    );
    const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
    if (!jwk.x) throw new Error("x25519KeypairFromSeed: failed to derive public key");
    return { publicKey: base64UrlToBytes(jwk.x), privateKey: new Uint8Array(seed) };
}

/** Generate a fresh X25519 keypair (raw 32-byte scalar + 32-byte public key). */
export async function generateX25519Keypair(): Promise<X25519Keypair> {
    const suite = _hpkeSuite();
    const kp = await suite.kem.generateKeyPair();
    return {
        publicKey: new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey)),
        privateKey: new Uint8Array(await suite.kem.serializePrivateKey(kp.privateKey)),
    };
}

/**
 * HPKE-base-mode single-shot seal. Output blob layout is
 * `enc (32 B) || ciphertext || tag (16 B)`. `domain` is bound into both the
 * HPKE `info` parameter and the AEAD AAD.
 */
export async function hpkeSeal(args: {
    readonly recipientPublicKey: Uint8Array;
    readonly domain: Uint8Array;
    readonly plaintext: Uint8Array;
}): Promise<Uint8Array> {
    const recipientPublicKey = await _hpkeSuite().kem.deserializePublicKey(_toBuffer(args.recipientPublicKey));
    // Bind domain into the HPKE info parameter, and into the AEAD AAD as well —
    // defence in depth.
    const sender = await _hpkeSuite().createSenderContext({
        recipientPublicKey,
        info: _toBuffer(args.domain),
    });
    // AES-GCM appends the 16-byte tag to the ciphertext, giving the `ct || tag`
    // layout; `sender.enc` is the 32-byte encapsulated key.
    const ctAndTag = new Uint8Array(await sender.seal(_toBuffer(args.plaintext), _toBuffer(args.domain)));
    return _concat(new Uint8Array(sender.enc), ctAndTag);
}

/**
 * HPKE-base-mode single-shot open. Throws on any tag failure (wrong domain,
 * wrong recipient key, or tampered blob); the error deliberately does NOT
 * distinguish these cases.
 */
export async function hpkeOpen(args: {
    readonly recipientPrivateKey: Uint8Array;
    readonly domain: Uint8Array;
    readonly blob: Uint8Array;
}): Promise<Uint8Array> {
    if (args.blob.length < _ENC_LEN + _TAG_LEN) {
        throw new Error("hpkeOpen: blob too short");
    }
    const enc = args.blob.subarray(0, _ENC_LEN);
    const ctAndTag = args.blob.subarray(_ENC_LEN); // ct || tag, exactly what AES-GCM open expects.
    const recipientKey = await _hpkeSuite().kem.deserializePrivateKey(_toBuffer(args.recipientPrivateKey));
    const recipient = await _hpkeSuite().createRecipientContext({
        recipientKey,
        enc: _toBuffer(enc),
        info: _toBuffer(args.domain),
    });
    return new Uint8Array(await recipient.open(_toBuffer(ctAndTag), _toBuffer(args.domain)));
}
