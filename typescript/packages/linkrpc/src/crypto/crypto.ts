/**
 * The single, explicit public crypto API for linkrpc.
 *
 * All signing, verifying, key generation, HPKE sealing/opening and hashing go
 * through the functions exported here. They delegate to the one Web Crypto
 * implementation in `./ed25519CryptoProvider` (the only module that touches
 * `globalThis.crypto.subtle`). Consumers should `import * as crypto from
 * ".../identity/crypto"` and call `crypto.sign(...)` etc. — there is no
 * pluggable provider; crypto is just this API.
 */
import type { Keypair, PrivateKey, PublicKey, Signature, X25519Keypair } from "./cryptoProvider";
import {
    ed25519Sign,
    ed25519Verify,
    ed25519KeypairFromSeed,
    generateEd25519Keypair,
    generateX25519Keypair as _generateX25519Keypair,
    hpkeOpen as _hpkeOpen,
    hpkeSeal as _hpkeSeal,
    x25519KeypairFromSeed as _x25519KeypairFromSeed,
} from "./ed25519CryptoProvider";
import { sha256 as _sha256 } from "./sha256";

/** Generate a fresh Ed25519 keypair (raw 32-byte seed + 32-byte public key). */
export function generateKeypair(): Promise<Keypair> {
    return generateEd25519Keypair();
}

/**
 * Deterministically derive an Ed25519 keypair from a raw 32-byte seed. For
 * tests / reproducible identities only — production keys must be random
 * (use {@link generateKeypair}).
 */
export function keypairFromSeed(seed: Uint8Array): Promise<Keypair> {
    return ed25519KeypairFromSeed(seed);
}

/**
 * Deterministically derive an X25519 keypair from a raw 32-byte scalar. For
 * tests / reproducible identities only.
 */
export function x25519KeypairFromSeed(seed: Uint8Array): Promise<X25519Keypair> {
    return _x25519KeypairFromSeed(seed);
}

/** Ed25519 sign `message` with a raw 32-byte seed private key. */
export function sign(privateKey: PrivateKey, message: Uint8Array): Promise<Signature> {
    return ed25519Sign(privateKey, message);
}

/** Ed25519 verify. Returns `false` (never throws) on malformed input. */
export function verify(publicKey: PublicKey, message: Uint8Array, sig: Signature): Promise<boolean> {
    return ed25519Verify(publicKey, message, sig);
}

/** Generate a fresh X25519 keypair (raw 32-byte scalar + 32-byte public key). */
export function generateX25519Keypair(): Promise<X25519Keypair> {
    return _generateX25519Keypair();
}

/**
 * HPKE-base-mode single-shot seal. Output blob layout is
 * `enc (32 B) || ciphertext || tag (16 B)`; `domain` is bound into both the
 * HPKE `info` parameter and the AEAD AAD.
 */
export function hpkeSeal(args: {
    readonly recipientPublicKey: Uint8Array;
    readonly domain: Uint8Array;
    readonly plaintext: Uint8Array;
}): Promise<Uint8Array> {
    return _hpkeSeal(args);
}

/**
 * HPKE-base-mode single-shot open. Throws on any tag failure (wrong domain,
 * wrong recipient key, or tampered blob); the error deliberately does NOT
 * distinguish these cases.
 */
export function hpkeOpen(args: {
    readonly recipientPrivateKey: Uint8Array;
    readonly domain: Uint8Array;
    readonly blob: Uint8Array;
}): Promise<Uint8Array> {
    return _hpkeOpen(args);
}

/** SHA-256 digest (synchronous, dependency-free). */
export function sha256(bytes: Uint8Array): Uint8Array {
    return _sha256(bytes);
}
