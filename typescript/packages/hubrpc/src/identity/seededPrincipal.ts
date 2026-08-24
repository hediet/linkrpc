import * as crypto from '../crypto/crypto';
import { principalForPublicKey } from '../crypto/cryptoProvider';
import { CapBag } from './capBag';
import { KeypairIdentity, KeypairSigningIdentity } from './identity';
import { Principal } from './signingSender';

export interface SeededPrincipalOptions {
    /** Numeric seed; the same value always yields the same identity / principal. */
    readonly seed: number;
}

/** Derive a domain-separated 32-byte seed from the numeric seed. */
function _seedBytes(domain: string, seed: number): Uint8Array {
    return crypto.sha256(new TextEncoder().encode(`${domain}:${seed}`));
}

/**
 * Build a **random**, in-memory {@link Principal}: a fresh Ed25519 signing
 * identity + X25519 wrapping key, paired with an empty memory-only
 * {@link CapBag}. Full-entropy (unlike {@link createSeededMemoryPrincipal}), so
 * it is safe to sign trusted calls — e.g. an in-process "agent" identity a hub
 * admin delegates read authority to (via a minted capability) for directory
 * discovery. The identity is ephemeral: it vanishes with the process.
 */
export async function createMemoryPrincipal(): Promise<Principal> {
    const ed = await crypto.generateKeypair();
    const wrap = await crypto.generateX25519Keypair();
    const identity = new KeypairIdentity(principalForPublicKey(ed.publicKey), ed.privateKey, wrap);
    const capBag = await CapBag.load();
    return new Principal(identity, capBag);
}

/**
 * Build a deterministic {@link Principal} from a numeric seed: a reproducible
 * Ed25519 signing identity (so the nodeId is stable across runs) plus a matching
 * X25519 wrapping key, paired with an empty, memory-only {@link CapBag}.
 *
 * For tests and reproducible local setups ONLY — the key material is derived
 * from a low-entropy seed and must never be used to sign anything trusted.
 */
export async function createSeededMemoryPrincipal(opts: SeededPrincipalOptions): Promise<Principal> {
    const ed = await crypto.keypairFromSeed(_seedBytes('hubrpc.seed.ed25519', opts.seed));
    const wrap = await crypto.x25519KeypairFromSeed(_seedBytes('hubrpc.seed.x25519', opts.seed));
    const identity = new KeypairIdentity(principalForPublicKey(ed.publicKey), ed.privateKey, wrap);
    const capBag = await CapBag.load();
    return new Principal(identity, capBag);
}

/**
 * Derive a deterministic {@link KeypairSigningIdentity} from a numeric seed: a
 * reproducible Ed25519 signing identity (so the nodeId is stable across runs),
 * with no wrapping key. Use it where only signing/issuing is needed — e.g. a
 * hub admin `issuer` that mints capabilities in tests.
 *
 * For tests and reproducible local setups ONLY — the key material is derived
 * from a low-entropy seed and must never be used to sign anything trusted.
 */
export async function createSeededSigningIdentity(opts: SeededPrincipalOptions): Promise<KeypairSigningIdentity> {
    const ed = await crypto.keypairFromSeed(_seedBytes('hubrpc.seed.ed25519', opts.seed));
    return KeypairSigningIdentity.fromKeypair(ed);
}
