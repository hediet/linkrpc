import type { IRequestSender } from '../connection/channel';
import { HubRpcConnection } from '../connection/hubRpcConnection';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';
import { type SigningCallCtx } from './signingSender';
import {
    base64UrlToBytes,
    bytesToBase64Url,
    keyIdForPrincipal,
    type Keypair,
    type PrincipalId,
    principalForPublicKey,
    publicKeyForKeyId,
    type Signature,
    type X25519Keypair,
} from '../crypto/cryptoProvider';
import * as crypto from '../crypto/crypto';
import {
    Identity,
    PublicSigningIdentity,
    PublicWrappingIdentity,
} from './identity';
import { identityInterface, identityStorageInterface } from './identity.interfaces';

/**
 * Valid `identity.storage` key shape. The interface schema declares
 * `z.string()` so we don't break clients with regex errors at the wire;
 * the executor-side handler applies this stricter check.
 */
const _STORAGE_KEY_RE = /^[A-Za-z0-9._/-]{1,256}$/;

/**
 * Executor-side backing for `identity.storage::*`. Lifecycle tied to a
 * single managed-identity slot; the executor decides where bytes are
 * stored.
 */
export interface ManagedIdentityStorageBackend {
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown): Promise<void>;
    /** Returns `true` iff the key existed before this call. */
    delete(key: string): Promise<boolean>;
    list(prefix?: string): Promise<string[]>;
}

/**
 * In-process storage backend. Used by tests and by any executor that
 * doesn't need at-rest persistence.
 */
export class InMemoryManagedIdentityStorage implements ManagedIdentityStorageBackend {
    private readonly _data = new Map<string, unknown>();

    public async get(key: string): Promise<unknown | undefined> {
        return this._data.has(key) ? this._data.get(key) : undefined;
    }

    public async set(key: string, value: unknown): Promise<void> {
        this._data.set(key, value);
    }

    public async delete(key: string): Promise<boolean> {
        return this._data.delete(key);
    }

    public async list(prefix?: string): Promise<string[]> {
        const all = [...this._data.keys()];
        return prefix === undefined ? all : all.filter((k) => k.startsWith(prefix));
    }
}

/**
 * In-process `ManagedIdentity` that holds the private key in memory and
 * uses the package crypto API. Useful for tests and for hub-side features
 * that want a short-lived identity without touching disk.
 */
export class InMemoryManagedIdentity implements Identity {
    public readonly principal: PrincipalId;
    public readonly wrapPublicKey: Uint8Array;

    constructor(
        private readonly _ed: Keypair,
        private readonly _wrap: X25519Keypair,
    ) {
        this.principal = principalForPublicKey(_ed.publicKey);
        this.wrapPublicKey = _wrap.publicKey;
    }

    public get publicSigningIdentity(): PublicSigningIdentity {
        return new PublicSigningIdentity(this.principal);
    }

    public get publicWrappingIdentity(): PublicWrappingIdentity {
        return new PublicWrappingIdentity(this.wrapPublicKey);
    }

    public sign(bytes: Uint8Array): Promise<Signature> {
        return crypto.sign(this._ed.privateKey, bytes);
    }

    public wrap(domain: string, bytes: Uint8Array): Promise<Uint8Array> {
        return crypto.hpkeSeal({
            recipientPublicKey: this._wrap.publicKey,
            domain: _encodeDomain(domain),
            plaintext: bytes,
        });
    }

    public unwrap(domain: string, blob: Uint8Array): Promise<Uint8Array> {
        return crypto.hpkeOpen({
            recipientPrivateKey: this._wrap.privateKey,
            domain: _encodeDomain(domain),
            blob,
        });
    }

    /** Generate a fresh in-memory identity (Ed25519 + X25519 keypairs). */
    public static async generate(): Promise<InMemoryManagedIdentity> {
        const ed = await crypto.generateKeypair();
        const wrap = await crypto.generateX25519Keypair();
        return new InMemoryManagedIdentity(ed, wrap);
    }
}

// ---- Overlay registration (executor → participant) -----------------------

/**
 * Register the `identity` interface on `overlay` so the bound participant
 * can call `identity::sign` etc. on its root overlay. The overlay is
 * private to one participant — no other peer can reach these methods.
 *
 * When `storage` is supplied, the `identity.storage` interface is
 * registered alongside `identity::*`. Lifetime/scope of the backend is
 * the executor's responsibility — for keystore-backed identities the
 * backend lives as long as the identity slot does.
 *
 * Typical caller: the executor (e.g. the VS Code extension), right after
 * `Hub.attachParticipant`, on the `rootOverlay` returned from the attach
 * handle.
 */
export function registerIdentityOnOverlay(
    overlay: HubRpcConnection,
    identity: Identity,
    storage?: ManagedIdentityStorageBackend,
): void {
    overlay.register(identityInterface, {
        getPrincipal: async () => ({ principal: identity.principal }),
        getWrapPublicKey: async () => ({
            wrapPublicKey: bytesToBase64Url(identity.wrapPublicKey),
        }),
        sign: async ({ bytes }) => ({
            signature: bytesToBase64Url(await identity.sign(base64UrlToBytes(bytes))),
        }),
        wrap: async ({ domain, bytes }) => ({
            blob: bytesToBase64Url(await identity.wrap(domain, base64UrlToBytes(bytes))),
        }),
        unwrap: async ({ domain, blob }) => ({
            bytes: bytesToBase64Url(await identity.unwrap(domain, base64UrlToBytes(blob))),
        }),
    });

    if (storage) {
        _registerStorageInterface(overlay, storage);
    }
}

/**
 * Like {@link registerIdentityOnOverlay}, but resolves the identity lazily on
 * first use via `resolveIdentity`. The identity is materialized only when the
 * bound participant actually calls `identity::*` — registering the overlay
 * does NOT create or load any identity.
 *
 * This is essential for the consent model: a host can serve `identity::*` on a
 * keystore slot without making the slot privileged (`hasState`) until the app
 * genuinely opts into an identity. `resolveIdentity` is expected to be cheap on
 * repeat calls (the keystore caches in memory), and to reflect lifecycle
 * changes — e.g. after a slot is wiped and re-created ("Reset Identity"), the
 * next call resolves the fresh identity.
 *
 * `storage` is registered eagerly because reading/writing storage is itself
 * the privileged act the app must perform to gain state — exposing the
 * interface costs nothing until used.
 */
export function registerLazyIdentityOnOverlay(
    overlay: HubRpcConnection<unknown>,
    resolveIdentity: () => Promise<Identity>,
    storage?: ManagedIdentityStorageBackend,
): void {
    overlay.register(identityInterface, {
        getPrincipal: async () => ({ principal: (await resolveIdentity()).principal }),
        getWrapPublicKey: async () => ({
            wrapPublicKey: bytesToBase64Url((await resolveIdentity()).wrapPublicKey),
        }),
        sign: async ({ bytes }) => ({
            signature: bytesToBase64Url(await (await resolveIdentity()).sign(base64UrlToBytes(bytes))),
        }),
        wrap: async ({ domain, bytes }) => ({
            blob: bytesToBase64Url(await (await resolveIdentity()).wrap(domain, base64UrlToBytes(bytes))),
        }),
        unwrap: async ({ domain, blob }) => ({
            bytes: bytesToBase64Url(await (await resolveIdentity()).unwrap(domain, base64UrlToBytes(blob))),
        }),
    });

    if (storage) {
        _registerStorageInterface(overlay, storage);
    }
}

function _registerStorageInterface(
    overlay: HubRpcConnection,
    storage: ManagedIdentityStorageBackend,
): void {
    overlay.register(identityStorageInterface, {
        get: async ({ key }) => {
            _assertStorageKey(key);
            const value = await storage.get(key);
            return value === undefined ? {} : { value };
        },
        set: async ({ key, value }) => {
            _assertStorageKey(key);
            await storage.set(key, value);
            return {};
        },
        delete: async ({ key }) => {
            _assertStorageKey(key);
            const existed = await storage.delete(key);
            return { existed };
        },
        list: async ({ prefix }) => {
            const keys = await storage.list(prefix);
            return { keys };
        },
    });
}

function _assertStorageKey(key: string): void {
    if (!_STORAGE_KEY_RE.test(key)) {
        throw new Error(
            `identity.storage: invalid key '${key}'. Must match ${_STORAGE_KEY_RE}.`,
        );
    }
}

// ---- Client-side: resolve an identity that round-trips through identity:: ---

/**
 * Client-side proxy for `identity.storage::*`. Methods round-trip through
 * the participant's root overlay; the executor enforces key-shape rules
 * server-side.
 *
 * Calls are unsigned (same recursion-guard rationale as
 * {@link createManagedIdentity} — the overlay is private to one
 * participant, so transport-level routing already authenticates).
 */
export interface ManagedIdentityStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(prefix?: string): Promise<string[]>;
}

/**
 * A managed identity resolved from an executor's `identity::*` overlay: a
 * full {@link Identity} (signing + HPKE wrap/unwrap, all round-tripping
 * through the executor — private keys never leave it) plus the
 * per-identity {@link ManagedIdentityStorage}.
 */
export interface ManagedIdentity extends Identity {
    /**
     * Per-identity persistent key/value store. Backed by the executor's
     * `identity.storage::*` overlay; calls throw when the executor did not
     * register storage for this slot (e.g. an in-process identity for tests).
     */
    readonly storage: ManagedIdentityStorage;
}

/**
 * Bootstrap a {@link ManagedIdentity} from a sender (typically the raw
 * unsigned sender obtained via `channel.sender` before wrapping with
 * {@link SigningSender}). Makes `identity::*` calls unsigned — the
 * executor's overlay is private to one participant so routing already
 * identifies the caller, preventing signing recursion.
 *
 * The returned identity signs / wraps / unwraps by round-tripping through
 * the executor's `identity::*` overlay; the caller wires it into their
 * {@link SigningSender} configuration (e.g. as a {@link Principal}). No
 * side effects on any existing connection or holder.
 */
export async function createManagedIdentity(
    sender: IRequestSender<unknown>,
): Promise<ManagedIdentity> {
    const conn = new HubRpcConnection<unknown, SigningCallCtx>(sender);
    const id = conn.get(identityInterface, { signerOverride: null });
    const storage = conn.get(identityStorageInterface, { signerOverride: null });

    const { principal } = await id.getPrincipal({});
    // Sanity: refuse to install if the executor returns a malformed principal.
    publicKeyForKeyId(keyIdForPrincipal(principal));

    const { wrapPublicKey: wrapPublicKeyB64 } = await id.getWrapPublicKey({});
    const wrapPublicKey = base64UrlToBytes(wrapPublicKeyB64);

    const identity: ManagedIdentity = {
        principal,
        wrapPublicKey,
        publicSigningIdentity: new PublicSigningIdentity(principal),
        publicWrappingIdentity: new PublicWrappingIdentity(wrapPublicKey),
        sign: async (message: Uint8Array): Promise<Signature> => {
            const { signature } = await id.sign({ bytes: bytesToBase64Url(message) });
            return base64UrlToBytes(signature);
        },
        wrap: async (domain, bytes) => {
            const { blob } = await id.wrap({ domain, bytes: bytesToBase64Url(bytes) });
            return base64UrlToBytes(blob);
        },
        unwrap: async (domain, blob) => {
            const { bytes } = await id.unwrap({ domain, blob: bytesToBase64Url(blob) });
            return base64UrlToBytes(bytes);
        },
        storage: {
            get: async <T = unknown>(key: string) => {
                const { value } = await storage.get({ key });
                return value === undefined ? undefined : (value as T);
            },
            set: async (key, value) => {
                await storage.set({ key, value });
            },
            delete: async (key) => {
                const { existed } = await storage.delete({ key });
                return existed;
            },
            list: async (prefix) => {
                const { keys } = await storage.list(prefix === undefined ? {} : { prefix });
                return keys;
            },
        },
    };

    return identity;
}

function _encodeDomain(domain: string): Uint8Array {
    return new TextEncoder().encode(domain);
}

// Re-export for callers that want to know what `channel.setSigner` expects.
export type { JsonRpcChannel };
