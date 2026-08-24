import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
    InMemoryManagedIdentity,
    type ManagedIdentityStorageBackend,
    type Identity,
    base64UrlToBytes,
    bytesToBase64Url,
    type Keypair,
    type X25519Keypair,
    crypto,
} from "@vscode/hubrpc";

/**
 * On-disk encrypted keystore for managed identities. State is keyed by
 * {@link SlotId} (the absolute path to the entry HTML / Node entry point).
 * Each slot owns up to four files under `storageDir`, mode `0o600`,
 * AES-256-GCM-sealed under `keystoreSecret`:
 *
 *   - `<hash>.bin`         — the managed identity keypair
 *   - `<hash>.storage.bin` — the per-slot persistent KV store
 *   - `<hash>.keys.bin`    — the access-key allow-list (gate)
 *   - `<hash>.snooze.bin`  — the consent re-prompt suppression (optional)
 *   - `<hash>.filesdir.bin`— the recorded path of the plaintext app-files
 *                            folder (optional; the folder itself lives
 *                            wherever the owner placed it, NOT here)
 *
 * `<hash>` is `sha256(id).slice(0,16)`. The slot id is bound into each
 * file's AEAD AAD so swapping files between slots fails the auth tag.
 *
 * The `keystoreSecret` itself is opaque bytes — the keystore does not
 * know or care where it came from. In the extension, it's loaded from
 * `vscode.SecretStorage`.
 */
export interface IdentityKeystoreOptions {
    /** Absolute directory path. Created if missing. */
    readonly storageDir: string;
    /** 32+ bytes of secret material used to seal identity files. */
    readonly keystoreSecret: Uint8Array;
}

/**
 * Stable slot identity: the absolute path to the entry HTML / Node entry
 * point. One slot ⇒ one managed identity + one storage backend, shared
 * across every approved {@link SlotAccessKey}.
 */
export type SlotId = string;

/**
 * An access key: a small, exact-match qualifier tuple a caller must
 * present to reach a slot's identity/storage. Conventionally
 * `{ appId, bundleHash }`, but the keystore treats it opaquely. Compared
 * by canonical (sorted-field) JSON equality.
 */
export type SlotAccessKey = Readonly<Record<string, string>>;

/**
 * Result of `slotByIdAndKey`. Either the resolved
 * slot, or a discriminated error:
 *   - `slotDoesNotExist` — no slot has ever been created for this id.
 *   - `unknownKey`       — the slot exists but `key` is not in its
 *                          allow-list (a different/unapproved bundle).
 */
export type SlotByIdAndKeyResult =
    | IdentitySlot
    | { readonly error: "slotDoesNotExist" }
    | { readonly error: "unknownKey" };

/**
 * Result of `slotByIdAndTime`. Either the resolved slot (access is currently
 * time-authorized) or a single discriminated error:
 *   - `consentRequired` — the slot holds inheritable state and no active
 *                         snooze covers the supplied time, so the caller
 *                         must obtain fresh consent before granting identity.
 */
export type SlotByIdAndTimeResult =
    | IdentitySlot
    | { readonly error: "consentRequired" };

/**
 * A time-boxed, scoped suppression of identity-access consent re-prompts for
 * a slot. Set from the consent dialog's "don't ask for file changes for 24h"
 * checkbox; read on each load to decide whether a content change can load
 * silently. Cleared by {@link IdentitySlot.delete}.
 *
 *   - `scope: "entry"` — covers entry-HTML content changes only.
 *   - `scope: "all"`   — covers entry-HTML AND external-file content changes.
 *   - `expiresAt`      — absolute epoch ms; expired snoozes are ignored.
 *
 * A snooze never suppresses a *new external path* — that is always a fresh
 * blast-radius decision the user must see.
 */
export interface IdentitySnooze {
    readonly scope: "entry" | "all";
    readonly expiresAt: number;
}

export interface IdentitySlot {
    readonly id: SlotId;

    // ---- identity + storage (shared per id) -----------------------------

    /** The slot's managed identity; generated + persisted on first call. */
    getOrCreateIdentity(): Promise<Identity>;

    /** Existing identity or `undefined` — never creates. */
    peekIdentity(): Promise<Identity | undefined>;

    /** Per-slot persistent KV (caps + app data). File created on first write. */
    readonly storage: ManagedIdentityStorageBackend;

    // ---- associated plaintext file folder -------------------------------

    /**
     * Absolute path of the slot's *plaintext* app-files folder, or
     * `undefined` if none has been recorded yet. The keystore only stores
     * and wipes this opaque string — the owner (the extension) chooses the
     * path (typically `<globalStorage>/app-files/<appId>` with a collision
     * counter) and performs the actual file IO.
     *
     * Recording the path in the slot is deliberate: the folder name is not
     * derivable from the app id alone (the counter breaks that), so an app
     * can only reach its own folder by looking it up through its slot. This
     * both isolates apps from each other and prevents accidental access to a
     * sibling's folder.
     */
    getFilesDir(): Promise<string | undefined>;

    /** Record the chosen absolute path of this slot's app-files folder. */
    setFilesDir(absPath: string): Promise<void>;

    /**
     * `true` iff a files folder is recorded AND it currently holds ≥1 entry.
     * Counts toward {@link hasState} so a content change to a privileged app
     * still trips the consent gate even when the app stored only files (and
     * never created an identity or KV state).
     */
    hasFiles(): Promise<boolean>;

    /**
     * Delete every entry inside the recorded files folder but keep the
     * folder itself and its slot record (so the path stays stable for the
     * user). No-op when no folder is recorded. Used by the consent dialog's
     * "wipe app files" option on a *keep-identity* load.
     */
    wipeFiles(): Promise<void>;

    /**
     * `true` iff there is anything a consumer could inherit: an identity
     * has been created, storage holds ≥1 entry, OR the app-files folder
     * holds ≥1 entry. When `false`, granting access exposes nothing — the
     * consent prompt can be skipped safely.
     */
    hasState(): Promise<boolean>;

    // ---- access keys (the gate) -----------------------------------------

    /** All keys currently allowed to access this slot. */
    listKeys(): Promise<SlotAccessKey[]>;

    /** `true` iff `key` (exact canonical match) is in the allow-list. */
    hasKey(key: SlotAccessKey): Promise<boolean>;

    /** Add keys to the allow-list (creating the slot if needed). Idempotent. */
    addKeys(...keys: SlotAccessKey[]): Promise<void>;

    /** Remove one key. Returns `true` iff it was present. */
    deleteKey(key: SlotAccessKey): Promise<boolean>;

    // ---- consent snooze -------------------------------------------------

    /**
     * The active, unexpired snooze for this slot, or `undefined`. Lazily
     * treats an expired snooze as absent (does not rewrite the file).
     */
    getSnooze(): Promise<IdentitySnooze | undefined>;

    /** Persist a snooze for this slot (overwrites any previous one). */
    setSnooze(snooze: IdentitySnooze): Promise<void>;

    /** Remove any snooze for this slot. Idempotent. */
    clearSnooze(): Promise<void>;

    // ---- lifecycle ------------------------------------------------------

    /** Wipe identity, storage, AND all access keys for this slot. */
    delete(): Promise<void>;
}

export interface IdentityKeystore {
    /**
     * Resolve the slot for `id`, enforcing the access gate. Returns the
     * slot on success, or a discriminated error if the slot does not exist
     * or `key` is not in its allow-list. Use this on the privileged path
     * (registering `identity::*` on an iframe overlay) so an unapproved
     * bundle can never reach prior state.
     */
    slotByIdAndKey(id: SlotId, key: SlotAccessKey): Promise<SlotByIdAndKeyResult>;

    /**
     * Resolve the slot for `id`, gated on *time* rather than a content key.
     * Returns the slot when access is currently authorized — either the slot
     * holds nothing inheritable ({@link IdentitySlot.hasState} is `false`, so
     * granting exposes nothing) or an active, unexpired snooze covers `nowMs`.
     * Otherwise returns `consentRequired`, meaning the slot holds state the
     * caller must obtain fresh consent for. Used on the privileged path for
     * URL apps, which have no content key to present to {@link slotByIdAndKey}
     * but may inherit the slot's identity under a time-boxed grant.
     */
    slotByIdAndTime(id: SlotId, nowMs: number): Promise<SlotByIdAndTimeResult>;

    /**
     * Create the slot for `id` (if missing) and add `key` to its
     * allow-list. Idempotent: re-creating an existing slot just ensures the
     * key is present. Returns the resolved slot. This is the only way to
     * bootstrap a brand-new slot before {@link slotByIdAndKey} can succeed.
     */
    createSlotWithKey(id: SlotId, key: SlotAccessKey): Promise<IdentitySlot>;

    /**
     * Unsafe: return the slot handle for `id` with NO key check. Used to
     * inspect `hasState`/`listKeys` and to run the consent decision before
     * a key has been added. Never register the identity returned from here
     * without having checked/added a key.
     */
    slotById(id: SlotId): IdentitySlot;
}

/** Identity file payload, AES-256-GCM-decrypted. */
interface PlainPayload {
    readonly schemaVersion: 1;
    readonly slot: string;
    readonly ed25519: { readonly privateKey: string; readonly publicKey: string };
    readonly x25519: { readonly privateKey: string; readonly publicKey: string };
    readonly createdAt: number;
}

/** Storage file payload, AES-256-GCM-decrypted. */
interface StoragePayload {
    readonly schemaVersion: 1;
    readonly slot: string;
    readonly entries: Record<string, unknown>;
    readonly updatedAt: number;
}

/** Keys file payload, AES-256-GCM-decrypted. */
interface KeysPayload {
    readonly schemaVersion: 1;
    readonly slot: string;
    readonly keys: ReadonlyArray<Record<string, string>>;
    readonly updatedAt: number;
}

/** Snooze file payload, AES-256-GCM-decrypted. */
interface SnoozePayload {
    readonly schemaVersion: 1;
    readonly slot: string;
    readonly scope: "entry" | "all";
    readonly expiresAt: number;
}

/** Files-dir file payload, AES-256-GCM-decrypted. */
interface FilesDirPayload {
    readonly schemaVersion: 1;
    readonly slot: string;
    /** Absolute path of the plaintext app-files folder. */
    readonly dir: string;
    readonly updatedAt: number;
}

const _FILE_SCHEMA_VERSION = 1;
const _DOMAIN = "hubrpc.identity.keystore.v1";
const _STORAGE_DOMAIN = "hubrpc.identity.storage.v1";
const _KEYS_DOMAIN = "hubrpc.identity.keys.v1";
const _SNOOZE_DOMAIN = "hubrpc.identity.snooze.v1";
const _FILESDIR_DOMAIN = "hubrpc.identity.filesdir.v1";

export function createIdentityKeystore(opts: IdentityKeystoreOptions): IdentityKeystore {
    if (opts.keystoreSecret.length < 32) {
        throw new Error("createIdentityKeystore: keystoreSecret must be at least 32 bytes");
    }
    return new _IdentityKeystoreImpl(opts);
}

class _IdentityKeystoreImpl implements IdentityKeystore {
    private readonly _slots = new Map<SlotId, _IdentitySlotImpl>();
    private readonly _opts: IdentityKeystoreOptions;
    private _dirReady = false;

    constructor(opts: IdentityKeystoreOptions) {
        this._opts = opts;
    }

    public slotById(id: SlotId): IdentitySlot {
        return this._slot(id);
    }

    public async slotByIdAndKey(id: SlotId, key: SlotAccessKey): Promise<SlotByIdAndKeyResult> {
        const slot = this._slot(id);
        if (!(await slot._exists())) return { error: "slotDoesNotExist" };
        if (!(await slot.hasKey(key))) return { error: "unknownKey" };
        return slot;
    }

    public async slotByIdAndTime(id: SlotId, nowMs: number): Promise<SlotByIdAndTimeResult> {
        const slot = this._slot(id);
        // Nothing to inherit → granting access exposes nothing; authorize.
        if (!(await slot.hasState())) return slot;
        // An active snooze is a time-boxed grant covering `nowMs`.
        const snooze = await slot.getSnooze();
        if (snooze !== undefined && snooze.expiresAt > nowMs) return slot;
        return { error: "consentRequired" };
    }

    public async createSlotWithKey(id: SlotId, key: SlotAccessKey): Promise<IdentitySlot> {
        const slot = this._slot(id);
        await slot.addKeys(key);
        return slot;
    }

    private _slot(id: SlotId): _IdentitySlotImpl {
        let existing = this._slots.get(id);
        if (existing) return existing;
        const hash = createHash("sha256").update(id).digest("hex").slice(0, 16);
        existing = new _IdentitySlotImpl({
            id,
            identityFile: path.join(this._opts.storageDir, `${hash}.bin`),
            storageFile: path.join(this._opts.storageDir, `${hash}.storage.bin`),
            keysFile: path.join(this._opts.storageDir, `${hash}.keys.bin`),
            snoozeFile: path.join(this._opts.storageDir, `${hash}.snooze.bin`),
            filesDirFile: path.join(this._opts.storageDir, `${hash}.filesdir.bin`),
            keystoreSecret: this._opts.keystoreSecret,
            ensureDir: () => this._ensureDir(),
        });
        this._slots.set(id, existing);
        return existing;
    }

    private async _ensureDir(): Promise<void> {
        if (this._dirReady) return;
        await fs.mkdir(this._opts.storageDir, { recursive: true, mode: 0o700 });
        this._dirReady = true;
    }
}

interface _SlotDeps {
    readonly id: SlotId;
    readonly identityFile: string;
    readonly storageFile: string;
    readonly keysFile: string;
    readonly snoozeFile: string;
    readonly filesDirFile: string;
    readonly keystoreSecret: Uint8Array;
    readonly ensureDir: () => Promise<void>;
}

class _IdentitySlotImpl implements IdentitySlot {
    private _identity: Identity | undefined;
    private _identityLoaded = false;
    private readonly _storage: _FileBackedStorage;

    private _keys: SlotAccessKey[] | undefined;
    private _keysFileExists = false;
    private _keysLoaded = false;
    private _keysWriteChain: Promise<void> = Promise.resolve();

    constructor(private readonly _deps: _SlotDeps) {
        this._storage = new _FileBackedStorage({
            slot: _deps.id,
            file: _deps.storageFile,
            keystoreSecret: _deps.keystoreSecret,
            ensureDir: _deps.ensureDir,
        });
    }

    public get id(): SlotId {
        return this._deps.id;
    }

    public get storage(): ManagedIdentityStorageBackend {
        return this._storage;
    }

    // ---- identity -------------------------------------------------------

    public async getOrCreateIdentity(): Promise<Identity> {
        const existing = await this.peekIdentity();
        if (existing) return existing;

        const ed = await crypto.generateKeypair();
        const wrap = await crypto.generateX25519Keypair();
        await this._writeIdentity(ed, wrap);
        const identity = new InMemoryManagedIdentity(ed, wrap);
        this._identity = identity;
        this._identityLoaded = true;
        return identity;
    }

    public async peekIdentity(): Promise<Identity | undefined> {
        if (this._identityLoaded) return this._identity;

        let raw: Buffer;
        try {
            raw = await fs.readFile(this._deps.identityFile);
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === "ENOENT") {
                this._identityLoaded = true;
                this._identity = undefined;
                return undefined;
            }
            throw e;
        }
        const plain = await this._decryptIdentityPayload(raw);
        const ed: Keypair = {
            privateKey: base64UrlToBytes(plain.ed25519.privateKey),
            publicKey: base64UrlToBytes(plain.ed25519.publicKey),
        };
        const wrap: X25519Keypair = {
            privateKey: base64UrlToBytes(plain.x25519.privateKey),
            publicKey: base64UrlToBytes(plain.x25519.publicKey),
        };
        const identity = new InMemoryManagedIdentity(ed, wrap);
        this._identity = identity;
        this._identityLoaded = true;
        return identity;
    }

    public async hasState(): Promise<boolean> {
        if (await this.peekIdentity()) return true;
        const keys = await this._storage.list();
        if (keys.length > 0) return true;
        return this.hasFiles();
    }

    // ---- access keys ----------------------------------------------------

    public async listKeys(): Promise<SlotAccessKey[]> {
        const keys = await this._loadKeys();
        return keys.map((k) => ({ ...k }));
    }

    public async hasKey(key: SlotAccessKey): Promise<boolean> {
        const keys = await this._loadKeys();
        const canon = _canonicalKey(key);
        return keys.some((k) => _canonicalKey(k) === canon);
    }

    public async addKeys(...keys: SlotAccessKey[]): Promise<void> {
        if (keys.length === 0) return;
        await this._mutateKeys((current) => {
            const seen = new Set(current.map((k) => _canonicalKey(k)));
            for (const key of keys) {
                const canon = _canonicalKey(key);
                if (!seen.has(canon)) {
                    seen.add(canon);
                    current.push({ ...key });
                }
            }
        });
    }

    public async deleteKey(key: SlotAccessKey): Promise<boolean> {
        const canon = _canonicalKey(key);
        let existed = false;
        await this._mutateKeys((current) => {
            const idx = current.findIndex((k) => _canonicalKey(k) === canon);
            if (idx >= 0) {
                existed = true;
                current.splice(idx, 1);
            }
        });
        return existed;
    }

    /** Internal: does this slot exist (i.e. has it ever been created)? */
    public async _exists(): Promise<boolean> {
        await this._loadKeys();
        return this._keysFileExists;
    }

    // ---- consent snooze -------------------------------------------------

    public async getSnooze(): Promise<IdentitySnooze | undefined> {
        let raw: Buffer;
        try {
            raw = await fs.readFile(this._deps.snoozeFile);
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === "ENOENT") return undefined;
            throw e;
        }
        const obj = await _aesDecrypt<SnoozePayload>(
            this._deps.keystoreSecret, _SNOOZE_DOMAIN, this._deps.id, raw,
        );
        if (obj.schemaVersion !== _FILE_SCHEMA_VERSION) {
            throw new Error(`identity snooze: unsupported schemaVersion ${obj.schemaVersion}`);
        }
        if (obj.slot !== this._deps.id) {
            throw new Error("identity snooze: slot mismatch");
        }
        if (Date.now() >= obj.expiresAt) return undefined;
        return { scope: obj.scope, expiresAt: obj.expiresAt };
    }

    public async setSnooze(snooze: IdentitySnooze): Promise<void> {
        await this._deps.ensureDir();
        const payload: SnoozePayload = {
            schemaVersion: _FILE_SCHEMA_VERSION,
            slot: this._deps.id,
            scope: snooze.scope,
            expiresAt: snooze.expiresAt,
        };
        const ct = await _aesEncrypt(
            this._deps.keystoreSecret, _SNOOZE_DOMAIN, this._deps.id, payload,
        );
        await fs.writeFile(this._deps.snoozeFile, ct, { mode: 0o600 });
    }

    public async clearSnooze(): Promise<void> {
        await _safeUnlink(this._deps.snoozeFile);
    }

    // ---- associated plaintext file folder -------------------------------

    public async getFilesDir(): Promise<string | undefined> {
        let raw: Buffer;
        try {
            raw = await fs.readFile(this._deps.filesDirFile);
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === "ENOENT") return undefined;
            throw e;
        }
        const obj = await _aesDecrypt<FilesDirPayload>(
            this._deps.keystoreSecret, _FILESDIR_DOMAIN, this._deps.id, raw,
        );
        if (obj.schemaVersion !== _FILE_SCHEMA_VERSION) {
            throw new Error(`identity filesdir: unsupported schemaVersion ${obj.schemaVersion}`);
        }
        if (obj.slot !== this._deps.id) {
            throw new Error("identity filesdir: slot mismatch");
        }
        return obj.dir;
    }

    public async setFilesDir(absPath: string): Promise<void> {
        await this._deps.ensureDir();
        const payload: FilesDirPayload = {
            schemaVersion: _FILE_SCHEMA_VERSION,
            slot: this._deps.id,
            dir: absPath,
            updatedAt: Date.now(),
        };
        const ct = await _aesEncrypt(
            this._deps.keystoreSecret, _FILESDIR_DOMAIN, this._deps.id, payload,
        );
        await fs.writeFile(this._deps.filesDirFile, ct, { mode: 0o600 });
    }

    public async hasFiles(): Promise<boolean> {
        const dir = await this.getFilesDir();
        if (dir === undefined) return false;
        try {
            const entries = await fs.readdir(dir);
            return entries.length > 0;
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === "ENOENT") return false;
            throw e;
        }
    }

    public async wipeFiles(): Promise<void> {
        const dir = await this.getFilesDir();
        if (dir === undefined) return;
        let entries: string[];
        try {
            entries = await fs.readdir(dir);
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === "ENOENT") return;
            throw e;
        }
        await Promise.all(
            entries.map((name) =>
                fs.rm(path.join(dir, name), { recursive: true, force: true }),
            ),
        );
    }

    // ---- lifecycle ------------------------------------------------------

    public async delete(): Promise<void> {
        this._identity = undefined;
        this._identityLoaded = false;
        this._keys = undefined;
        this._keysLoaded = false;
        this._keysFileExists = false;
        // Invalidate any in-flight storage buffer so a racing `set` after
        // `delete` writes against a clean baseline.
        this._storage._invalidate();
        // Wipe the plaintext files folder (if any) entirely before dropping
        // its record, so "Reset Identity" leaves nothing on disk.
        const filesDir = await this.getFilesDir().catch(() => undefined);
        if (filesDir !== undefined) {
            await fs.rm(filesDir, { recursive: true, force: true });
        }
        await _safeUnlink(this._deps.identityFile);
        await _safeUnlink(this._deps.storageFile);
        await _safeUnlink(this._deps.keysFile);
        await _safeUnlink(this._deps.snoozeFile);
        await _safeUnlink(this._deps.filesDirFile);
    }

    // ---- identity IO ----------------------------------------------------

    private async _writeIdentity(ed: Keypair, wrap: X25519Keypair): Promise<void> {
        await this._deps.ensureDir();
        const payload: PlainPayload = {
            schemaVersion: _FILE_SCHEMA_VERSION,
            slot: this._deps.id,
            ed25519: {
                privateKey: bytesToBase64Url(ed.privateKey),
                publicKey: bytesToBase64Url(ed.publicKey),
            },
            x25519: {
                privateKey: bytesToBase64Url(wrap.privateKey),
                publicKey: bytesToBase64Url(wrap.publicKey),
            },
            createdAt: Date.now(),
        };
        const ct = await _aesEncrypt(this._deps.keystoreSecret, _DOMAIN, this._deps.id, payload);
        await fs.writeFile(this._deps.identityFile, ct, { mode: 0o600 });
    }

    private async _decryptIdentityPayload(raw: Buffer): Promise<PlainPayload> {
        const obj = await _aesDecrypt<PlainPayload>(
            this._deps.keystoreSecret, _DOMAIN, this._deps.id, raw,
        );
        if (obj.schemaVersion !== _FILE_SCHEMA_VERSION) {
            throw new Error(`identity keystore: unsupported schemaVersion ${obj.schemaVersion}`);
        }
        if (obj.slot !== this._deps.id) {
            // AAD binding makes this unreachable unless the AAD constant
            // drifts — keep the check as a defence-in-depth.
            throw new Error("identity keystore: slot mismatch");
        }
        return obj;
    }

    // ---- keys IO --------------------------------------------------------

    private async _loadKeys(): Promise<SlotAccessKey[]> {
        if (this._keysLoaded) return this._keys!;
        let raw: Buffer;
        try {
            raw = await fs.readFile(this._deps.keysFile);
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === "ENOENT") {
                this._keys = [];
                this._keysFileExists = false;
                this._keysLoaded = true;
                return this._keys;
            }
            throw e;
        }
        const obj = await _aesDecrypt<KeysPayload>(
            this._deps.keystoreSecret, _KEYS_DOMAIN, this._deps.id, raw,
        );
        if (obj.schemaVersion !== _FILE_SCHEMA_VERSION) {
            throw new Error(`identity keys: unsupported schemaVersion ${obj.schemaVersion}`);
        }
        if (obj.slot !== this._deps.id) {
            throw new Error("identity keys: slot mismatch");
        }
        this._keys = obj.keys.map((k) => ({ ...k }));
        this._keysFileExists = true;
        this._keysLoaded = true;
        return this._keys;
    }

    private async _mutateKeys(fn: (keys: SlotAccessKey[]) => void): Promise<void> {
        const next = this._keysWriteChain.then(async () => {
            const keys = await this._loadKeys();
            fn(keys);
            await this._persistKeys(keys);
        });
        // Suppress unhandled rejection on the chain — callers see the
        // original promise.
        this._keysWriteChain = next.catch(() => { });
        return next;
    }

    private async _persistKeys(keys: SlotAccessKey[]): Promise<void> {
        await this._deps.ensureDir();
        const payload: KeysPayload = {
            schemaVersion: _FILE_SCHEMA_VERSION,
            slot: this._deps.id,
            keys: keys.map((k) => ({ ...k })),
            updatedAt: Date.now(),
        };
        const ct = await _aesEncrypt(this._deps.keystoreSecret, _KEYS_DOMAIN, this._deps.id, payload);
        await fs.writeFile(this._deps.keysFile, ct, { mode: 0o600 });
        this._keysFileExists = true;
    }
}

/** Canonical (sorted-field) JSON for exact access-key equality. */
function _canonicalKey(key: SlotAccessKey): string {
    const entries = Object.keys(key)
        .sort()
        .map((k) => [k, key[k]] as const);
    return JSON.stringify(entries);
}

/**
 * File-backed per-slot storage. Lazily reads the encrypted file on first
 * access and caches the decrypted map in memory. Writes serialize
 * through `_writeChain` so concurrent `set`/`delete` calls don't
 * overwrite each other.
 */
class _FileBackedStorage implements ManagedIdentityStorageBackend {
    private _data: Record<string, unknown> | undefined;
    private _loaded = false;
    private _writeChain: Promise<void> = Promise.resolve();

    constructor(
        private readonly _opts: {
            readonly slot: string;
            readonly file: string;
            readonly keystoreSecret: Uint8Array;
            readonly ensureDir: () => Promise<void>;
        },
    ) { }

    /**
     * Drop the cached map (called by the slot's `delete()` so the next
     * `get` re-reads from disk, where the file is now gone).
     */
    public _invalidate(): void {
        this._data = undefined;
        this._loaded = false;
    }

    public async get(key: string): Promise<unknown | undefined> {
        const data = await this._load();
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
    }

    public async set(key: string, value: unknown): Promise<void> {
        await this._mutate((data) => {
            data[key] = value;
        });
    }

    public async delete(key: string): Promise<boolean> {
        let existed = false;
        await this._mutate((data) => {
            existed = Object.prototype.hasOwnProperty.call(data, key);
            if (existed) delete data[key];
        });
        return existed;
    }

    public async list(prefix?: string): Promise<string[]> {
        const data = await this._load();
        const keys = Object.keys(data);
        return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    }

    private async _load(): Promise<Record<string, unknown>> {
        if (this._loaded) return this._data!;
        let raw: Buffer;
        try {
            raw = await fs.readFile(this._opts.file);
        } catch (e: unknown) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === "ENOENT") {
                this._data = {};
                this._loaded = true;
                return this._data;
            }
            throw e;
        }
        const obj = await _aesDecrypt<StoragePayload>(
            this._opts.keystoreSecret, _STORAGE_DOMAIN, this._opts.slot, raw,
        );
        if (obj.schemaVersion !== _FILE_SCHEMA_VERSION) {
            throw new Error(`identity storage: unsupported schemaVersion ${obj.schemaVersion}`);
        }
        if (obj.slot !== this._opts.slot) {
            throw new Error("identity storage: slot mismatch");
        }
        this._data = { ...obj.entries };
        this._loaded = true;
        return this._data;
    }

    private async _mutate(fn: (data: Record<string, unknown>) => void): Promise<void> {
        const next = this._writeChain.then(async () => {
            const data = await this._load();
            fn(data);
            await this._persist(data);
        });
        // Suppress unhandled rejection on the chain — callers see the
        // original promise.
        this._writeChain = next.catch(() => { });
        return next;
    }

    private async _persist(data: Record<string, unknown>): Promise<void> {
        await this._opts.ensureDir();
        const payload: StoragePayload = {
            schemaVersion: _FILE_SCHEMA_VERSION,
            slot: this._opts.slot,
            entries: data,
            updatedAt: Date.now(),
        };
        const ct = await _aesEncrypt(
            this._opts.keystoreSecret, _STORAGE_DOMAIN, this._opts.slot, payload,
        );
        await fs.writeFile(this._opts.file, ct, { mode: 0o600 });
    }
}

// ---- shared AES helpers --------------------------------------------------

async function _aesEncrypt(
    secret: Uint8Array,
    domain: string,
    slot: string,
    payload: unknown,
): Promise<Uint8Array> {
    const pt = new TextEncoder().encode(JSON.stringify(payload));
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const key = await _deriveKey(secret, domain);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(new TextEncoder().encode(`${domain}:${slot}`));
    const enc = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Layout: iv (12) || tag (16) || ciphertext
    const out = new Uint8Array(12 + 16 + enc.length);
    out.set(iv, 0);
    out.set(tag, 12);
    out.set(enc, 28);
    return out;
}

async function _aesDecrypt<T>(
    secret: Uint8Array,
    domain: string,
    slot: string,
    raw: Buffer,
): Promise<T> {
    if (raw.length < 12 + 16) throw new Error(`${domain}: file too short`);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const { createDecipheriv } = await import("node:crypto");
    const key = await _deriveKey(secret, domain);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(new TextEncoder().encode(`${domain}:${slot}`));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString("utf8")) as T;
}

async function _deriveKey(secret: Uint8Array, domain: string): Promise<Buffer> {
    const { createHmac } = await import("node:crypto");
    // HKDF-Extract with empty salt (the secret is already random 32+
    // bytes) then HKDF-Expand with our domain label, 32-byte output.
    const prk = createHmac("sha256", Buffer.alloc(32)).update(secret).digest();
    const info = Buffer.concat([
        Buffer.from(domain),
        Buffer.from([1]), // T(1)
    ]);
    return createHmac("sha256", prk).update(info).digest();
}

async function _safeUnlink(file: string): Promise<void> {
    try {
        await fs.unlink(file);
    } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw e;
    }
}
