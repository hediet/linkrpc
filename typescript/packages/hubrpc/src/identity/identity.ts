import {
    base64UrlToBytes,
    bytesToBase64Url,
    type KeyId,
    keyIdForPrincipal,
    type Keypair,
    type PrincipalId,
    type PrivateKey,
    principalForPublicKey,
    publicKeyForKeyId,
    type Signature,
    type X25519Keypair,
} from "../crypto/cryptoProvider";
import * as crypto from "../crypto/crypto";

/** JSON-serializable form of a {@link KeypairSigningIdentity} (base64url keys). */
export interface SerializedKeypairSigningIdentity {
    readonly privateKey: string;
    readonly publicKey: string;
}

/**
 * The public face of a signing identity: its stable {@link PrincipalId} name
 * and the {@link KeyId} its signatures are stamped with. In Phase 1 (perpetual
 * identities) the keyId is the genesis key embedded in the principal, so it is
 * derived by stripping the `id:` prefix.
 */
export class PublicSigningIdentity {
    constructor(public readonly principal: PrincipalId) { }

    /** The {@link KeyId} this identity signs with (its genesis key, in Phase 1). */
    public get keyId(): KeyId {
        return keyIdForPrincipal(this.principal);
    }
}

export interface SigningIdentity {
    readonly publicSigningIdentity: PublicSigningIdentity;
    sign(bytes: Uint8Array): Promise<Uint8Array>;
}

/**
 * {@link SigningIdentity} backed by an in-process keypair. For the common
 * case where the signing material lives in memory. For external HSM-style
 * backends, implement {@link SigningIdentity} directly.
 */
export class KeypairSigningIdentity implements SigningIdentity {
    public readonly publicSigningIdentity: PublicSigningIdentity;

    constructor(
        principal: PrincipalId,
        private readonly _privateKey: PrivateKey,
    ) {
        this.publicSigningIdentity = new PublicSigningIdentity(principal);
    }

    public sign(message: Uint8Array): Promise<Signature> {
        return crypto.sign(this._privateKey, message);
    }

    public static fromKeypair(keypair: Keypair): KeypairSigningIdentity {
        return new KeypairSigningIdentity(
            principalForPublicKey(keypair.publicKey),
            keypair.privateKey,
        );
    }

    /** Generate a fresh signing identity (Ed25519 keypair). */
    public static async generateNew(): Promise<KeypairSigningIdentity> {
        return KeypairSigningIdentity.fromKeypair(await crypto.generateKeypair());
    }

    /** Restore an identity from its {@link toJson} form. */
    public static fromJson(json: SerializedKeypairSigningIdentity): KeypairSigningIdentity {
        return KeypairSigningIdentity.fromKeypair({
            privateKey: base64UrlToBytes(json.privateKey),
            publicKey: base64UrlToBytes(json.publicKey),
        });
    }

    /** Serialize the keypair to a JSON-friendly form (base64url keys). */
    public toJson(): SerializedKeypairSigningIdentity {
        return {
            privateKey: bytesToBase64Url(this._privateKey),
            publicKey: bytesToBase64Url(publicKeyForKeyId(this.publicSigningIdentity.keyId)),
        };
    }
}

export class PublicWrappingIdentity {
    constructor(public readonly wrapPublicKey: Uint8Array) { }
}

export interface WrappingIdentity {
    readonly publicWrappingIdentity: PublicWrappingIdentity;
    wrap(domain: string, bytes: Uint8Array): Promise<Uint8Array>;
    unwrap(domain: string, blob: Uint8Array): Promise<Uint8Array>;
}

export interface Identity extends SigningIdentity, WrappingIdentity {
    /** The identity's stable {@link PrincipalId} name. */
    readonly principal: PrincipalId;
    /** @deprecated */
    readonly wrapPublicKey: Uint8Array;
}

/**
 * Full {@link Identity} backed by in-process Ed25519 (signing) and X25519
 * (wrapping) keypairs. The local counterpart to a keystore/executor-backed
 * identity — used by self-managed principals that hold their own key
 * material (e.g. loaded from disk). For external HSM-style backends,
 * implement {@link Identity} directly.
 */
export class KeypairIdentity implements Identity {
    public readonly principal: PrincipalId;
    public readonly wrapPublicKey: Uint8Array;
    public readonly publicSigningIdentity: PublicSigningIdentity;
    public readonly publicWrappingIdentity: PublicWrappingIdentity;

    constructor(
        principal: PrincipalId,
        private readonly _privateKey: PrivateKey,
        private readonly _wrap: X25519Keypair,
    ) {
        this.principal = principal;
        this.wrapPublicKey = _wrap.publicKey;
        this.publicSigningIdentity = new PublicSigningIdentity(principal);
        this.publicWrappingIdentity = new PublicWrappingIdentity(_wrap.publicKey);
    }

    public sign(message: Uint8Array): Promise<Signature> {
        return crypto.sign(this._privateKey, message);
    }

    public wrap(domain: string, bytes: Uint8Array): Promise<Uint8Array> {
        return crypto.hpkeSeal({
            recipientPublicKey: this._wrap.publicKey,
            domain: new TextEncoder().encode(domain),
            plaintext: bytes,
        });
    }

    public unwrap(domain: string, blob: Uint8Array): Promise<Uint8Array> {
        return crypto.hpkeOpen({
            recipientPrivateKey: this._wrap.privateKey,
            domain: new TextEncoder().encode(domain),
            blob,
        });
    }

    /** Generate a fresh identity (Ed25519 + X25519 keypairs). */
    public static async generate(): Promise<KeypairIdentity> {
        const ed = await crypto.generateKeypair();
        const wrap = await crypto.generateX25519Keypair();
        return new KeypairIdentity(principalForPublicKey(ed.publicKey), ed.privateKey, wrap);
    }
}
