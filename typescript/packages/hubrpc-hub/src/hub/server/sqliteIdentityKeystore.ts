import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    InMemoryManagedIdentity,
    base64UrlToBytes,
    bytesToBase64Url,
    crypto,
    type Identity,
    type Keypair,
    type ManagedIdentityStorageBackend,
    type X25519Keypair,
} from "@vscode/hubrpc";
import type {
    IdentityKeystore,
    IdentitySlot,
    IdentitySnooze,
    SlotAccessKey,
    SlotByIdAndKeyResult,
    SlotByIdAndTimeResult,
    SlotId,
} from "./identityKeystore";

/**
 * SQLite-backed {@link IdentityKeystore} — a drop-in alternative to the
 * file-per-slot {@link import('./identityKeystore').createIdentityKeystore}.
 * All slot state (identity keypair, per-slot KV storage, the access-key gate,
 * the consent snooze, and the recorded app-files folder) lives in **one**
 * database file across three tables, so the whole keystore is a single
 * `DatabaseSync` connection instead of four files per slot.
 *
 * The model is identical to the file keystore — `id` (the slot), `keys` (the
 * gate), and `time` (the snooze) — even though config/CLI hubs only exercise
 * the `id` + storage axes today. Keeping the full surface means the extension
 * and node-runner can adopt this backend unchanged later.
 *
 * ## Encryption seam
 *
 * This backend currently runs in **unencrypted mode**: secret-bearing columns
 * (identity private keys, storage values) are stored plaintext via the
 * identity {@link _codec}. When at-rest encryption is added, swap {@link _codec}
 * for an AEAD codec keyed by a `keystoreSecret` with `slotId` bound into the
 * AAD (mirroring the file keystore's per-file AAD). The columns stay `TEXT`
 * (ciphertext is base64url), so enabling encryption is a codec swap plus a
 * one-time re-encode — not a schema migration.
 *
 * Uses the built-in `node:sqlite` `DatabaseSync`, matching the monorepo's
 * other SQLite stores (`app-packager`, `hubrpc-node-runner`).
 */
export interface SqliteIdentitySlot extends IdentitySlot {
    /**
     * Write a **specific** keypair into this slot iff it has no identity yet,
     * and return the resulting identity. Used to import a legacy plaintext
     * identity while preserving its principal. If an identity already exists
     * it is returned unchanged (the import is a no-op).
     */
    importIdentity(ed: Keypair, wrap: X25519Keypair): Promise<Identity>;
}

export interface SqliteIdentityKeystore extends IdentityKeystore {
    slotById(id: SlotId): SqliteIdentitySlot;
}

export interface SqliteIdentityKeystoreOptions {
    /**
     * Path to the SQLite database file (created if missing) or `":memory:"`.
     * Ignored when {@link db} is provided.
     */
    readonly dbPath?: string;
    /** An existing connection to reuse (share one file across stores). */
    readonly db?: DatabaseSync;
}

/**
 * Value codec for secret-bearing columns. Identity in unencrypted mode; the
 * single choke point an AEAD codec would replace. `slotId` is threaded through
 * so an encrypting codec can bind it into the AAD.
 */
interface _ValueCodec {
    encode(slotId: string, plaintext: string): string;
    decode(slotId: string, stored: string): string;
}

const _codec: _ValueCodec = {
    encode: (_slotId, plaintext) => plaintext,
    decode: (_slotId, stored) => stored,
};

const _SCHEMA = `
CREATE TABLE IF NOT EXISTS identity_slots (
    slot_id             TEXT PRIMARY KEY,
    ed25519_priv        TEXT,
    ed25519_pub         TEXT,
    x25519_priv         TEXT,
    x25519_pub          TEXT,
    identity_created_at INTEGER,
    files_dir           TEXT,
    snooze_scope        TEXT,
    snooze_expires_at   INTEGER,
    created_at          INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_storage (
    slot_id TEXT NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (slot_id, key)
);
CREATE TABLE IF NOT EXISTS identity_keys (
    slot_id  TEXT NOT NULL,
    key_json TEXT NOT NULL,
    PRIMARY KEY (slot_id, key_json)
);
`;

/** Open (creating if needed) a SQLite-backed {@link IdentityKeystore}. */
export function createSqliteIdentityKeystore(
    opts: SqliteIdentityKeystoreOptions,
): SqliteIdentityKeystore {
    const db = opts.db ?? new DatabaseSync(_requireDbPath(opts));
    db.exec(_SCHEMA);
    return new _SqliteKeystore(db);
}

function _requireDbPath(opts: SqliteIdentityKeystoreOptions): string {
    if (opts.dbPath === undefined) {
        throw new Error("createSqliteIdentityKeystore: pass either `dbPath` or `db`");
    }
    return opts.dbPath;
}

/** Prepared statements shared by every slot handle on one connection. */
class _Stmts {
    readonly selIdentity;
    readonly upsertIdentity;
    readonly ensureSlot;
    readonly slotExists;
    readonly setFilesDir;
    readonly getFilesDir;
    readonly setSnooze;
    readonly getSnooze;
    readonly clearSnooze;
    readonly listKeys;
    readonly hasKey;
    readonly addKey;
    readonly delKey;
    readonly storGet;
    readonly storSet;
    readonly storDel;
    readonly storKeys;
    readonly storCount;
    readonly delSlot;
    readonly delStorage;
    readonly delKeys;

    constructor(db: DatabaseSync) {
        this.selIdentity = db.prepare(
            `SELECT ed25519_priv, ed25519_pub, x25519_priv, x25519_pub
             FROM identity_slots WHERE slot_id = ?`,
        );
        this.upsertIdentity = db.prepare(
            `INSERT INTO identity_slots
                (slot_id, ed25519_priv, ed25519_pub, x25519_priv, x25519_pub,
                 identity_created_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(slot_id) DO UPDATE SET
                ed25519_priv = excluded.ed25519_priv,
                ed25519_pub  = excluded.ed25519_pub,
                x25519_priv  = excluded.x25519_priv,
                x25519_pub   = excluded.x25519_pub,
                identity_created_at = excluded.identity_created_at`,
        );
        this.ensureSlot = db.prepare(
            `INSERT OR IGNORE INTO identity_slots (slot_id, created_at) VALUES (?, ?)`,
        );
        this.slotExists = db.prepare(`SELECT 1 FROM identity_slots WHERE slot_id = ?`);
        this.setFilesDir = db.prepare(
            `UPDATE identity_slots SET files_dir = ? WHERE slot_id = ?`,
        );
        this.getFilesDir = db.prepare(`SELECT files_dir FROM identity_slots WHERE slot_id = ?`);
        this.setSnooze = db.prepare(
            `UPDATE identity_slots SET snooze_scope = ?, snooze_expires_at = ? WHERE slot_id = ?`,
        );
        this.getSnooze = db.prepare(
            `SELECT snooze_scope, snooze_expires_at FROM identity_slots WHERE slot_id = ?`,
        );
        this.clearSnooze = db.prepare(
            `UPDATE identity_slots SET snooze_scope = NULL, snooze_expires_at = NULL WHERE slot_id = ?`,
        );
        this.listKeys = db.prepare(`SELECT key_json FROM identity_keys WHERE slot_id = ?`);
        this.hasKey = db.prepare(
            `SELECT 1 FROM identity_keys WHERE slot_id = ? AND key_json = ?`,
        );
        this.addKey = db.prepare(
            `INSERT OR IGNORE INTO identity_keys (slot_id, key_json) VALUES (?, ?)`,
        );
        this.delKey = db.prepare(
            `DELETE FROM identity_keys WHERE slot_id = ? AND key_json = ?`,
        );
        this.storGet = db.prepare(
            `SELECT value FROM identity_storage WHERE slot_id = ? AND key = ?`,
        );
        this.storSet = db.prepare(
            `INSERT OR REPLACE INTO identity_storage (slot_id, key, value) VALUES (?, ?, ?)`,
        );
        this.storDel = db.prepare(
            `DELETE FROM identity_storage WHERE slot_id = ? AND key = ?`,
        );
        this.storKeys = db.prepare(`SELECT key FROM identity_storage WHERE slot_id = ?`);
        this.storCount = db.prepare(
            `SELECT COUNT(*) AS n FROM identity_storage WHERE slot_id = ?`,
        );
        this.delSlot = db.prepare(`DELETE FROM identity_slots WHERE slot_id = ?`);
        this.delStorage = db.prepare(`DELETE FROM identity_storage WHERE slot_id = ?`);
        this.delKeys = db.prepare(`DELETE FROM identity_keys WHERE slot_id = ?`);
    }
}

class _SqliteKeystore implements SqliteIdentityKeystore {
    private readonly _stmts: _Stmts;
    private readonly _slots = new Map<SlotId, _SqliteSlot>();

    constructor(db: DatabaseSync) {
        this._stmts = new _Stmts(db);
    }

    public slotById(id: SlotId): SqliteIdentitySlot {
        return this._slot(id);
    }

    private _slot(id: SlotId): _SqliteSlot {
        let existing = this._slots.get(id);
        if (existing === undefined) {
            existing = new _SqliteSlot(id, this._stmts);
            this._slots.set(id, existing);
        }
        return existing;
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
        const slot = this.slotById(id);
        await slot.addKeys(key);
        return slot;
    }
}

class _SqliteSlot implements SqliteIdentitySlot {
    private readonly _storage: _SqliteSlotStorage;

    constructor(
        public readonly id: SlotId,
        private readonly _s: _Stmts,
    ) {
        this._storage = new _SqliteSlotStorage(id, _s);
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
        this._writeIdentity(ed, wrap);
        return new InMemoryManagedIdentity(ed, wrap);
    }

    public async importIdentity(ed: Keypair, wrap: X25519Keypair): Promise<Identity> {
        const existing = await this.peekIdentity();
        if (existing) return existing;
        this._writeIdentity(ed, wrap);
        return new InMemoryManagedIdentity(ed, wrap);
    }

    public async peekIdentity(): Promise<Identity | undefined> {
        const row = this._s.selIdentity.get(this.id) as
            | {
                  ed25519_priv: string | null;
                  ed25519_pub: string | null;
                  x25519_priv: string | null;
                  x25519_pub: string | null;
              }
            | undefined;
        if (
            row === undefined ||
            row.ed25519_priv === null ||
            row.ed25519_pub === null ||
            row.x25519_priv === null ||
            row.x25519_pub === null
        ) {
            return undefined;
        }
        const ed: Keypair = {
            privateKey: base64UrlToBytes(_codec.decode(this.id, row.ed25519_priv)),
            publicKey: base64UrlToBytes(row.ed25519_pub),
        };
        const wrap: X25519Keypair = {
            privateKey: base64UrlToBytes(_codec.decode(this.id, row.x25519_priv)),
            publicKey: base64UrlToBytes(row.x25519_pub),
        };
        return new InMemoryManagedIdentity(ed, wrap);
    }

    private _writeIdentity(ed: Keypair, wrap: X25519Keypair): void {
        this._s.upsertIdentity.run(
            this.id,
            _codec.encode(this.id, bytesToBase64Url(ed.privateKey)),
            bytesToBase64Url(ed.publicKey),
            _codec.encode(this.id, bytesToBase64Url(wrap.privateKey)),
            bytesToBase64Url(wrap.publicKey),
            Date.now(),
            Date.now(),
        );
    }

    // ---- access keys (the gate) -----------------------------------------

    public async listKeys(): Promise<SlotAccessKey[]> {
        const rows = this._s.listKeys.all(this.id) as { key_json: string }[];
        return rows.map((r) => _fromCanonicalKey(r.key_json));
    }

    public async hasKey(key: SlotAccessKey): Promise<boolean> {
        return this._s.hasKey.get(this.id, _canonicalKey(key)) !== undefined;
    }

    public async addKeys(...keys: SlotAccessKey[]): Promise<void> {
        if (keys.length === 0) return;
        this._ensureRow();
        for (const key of keys) {
            this._s.addKey.run(this.id, _canonicalKey(key));
        }
    }

    public async deleteKey(key: SlotAccessKey): Promise<boolean> {
        const res = this._s.delKey.run(this.id, _canonicalKey(key));
        return res.changes > 0;
    }

    /** Internal: has this slot ever been created? */
    public async _exists(): Promise<boolean> {
        return this._s.slotExists.get(this.id) !== undefined;
    }

    // ---- consent snooze (the time axis) ---------------------------------

    public async getSnooze(): Promise<IdentitySnooze | undefined> {
        const row = this._s.getSnooze.get(this.id) as
            | { snooze_scope: string | null; snooze_expires_at: number | null }
            | undefined;
        if (
            row === undefined ||
            row.snooze_scope === null ||
            row.snooze_expires_at === null
        ) {
            return undefined;
        }
        if (Date.now() >= row.snooze_expires_at) return undefined;
        return {
            scope: row.snooze_scope as IdentitySnooze["scope"],
            expiresAt: row.snooze_expires_at,
        };
    }

    public async setSnooze(snooze: IdentitySnooze): Promise<void> {
        this._ensureRow();
        this._s.setSnooze.run(snooze.scope, snooze.expiresAt, this.id);
    }

    public async clearSnooze(): Promise<void> {
        this._s.clearSnooze.run(this.id);
    }

    // ---- associated plaintext file folder -------------------------------

    public async getFilesDir(): Promise<string | undefined> {
        const row = this._s.getFilesDir.get(this.id) as
            | { files_dir: string | null }
            | undefined;
        if (row === undefined || row.files_dir === null) return undefined;
        return row.files_dir;
    }

    public async setFilesDir(absPath: string): Promise<void> {
        this._ensureRow();
        this._s.setFilesDir.run(absPath, this.id);
    }

    public async hasFiles(): Promise<boolean> {
        const dir = await this.getFilesDir();
        if (dir === undefined) return false;
        try {
            const entries = await fs.readdir(dir);
            return entries.length > 0;
        } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
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
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
            throw e;
        }
        await Promise.all(
            entries.map((name) => fs.rm(path.join(dir, name), { recursive: true, force: true })),
        );
    }

    // ---- state ----------------------------------------------------------

    public async hasState(): Promise<boolean> {
        if (await this.peekIdentity()) return true;
        const { n } = this._s.storCount.get(this.id) as { n: number };
        if (n > 0) return true;
        return this.hasFiles();
    }

    // ---- lifecycle ------------------------------------------------------

    public async delete(): Promise<void> {
        const filesDir = await this.getFilesDir().catch(() => undefined);
        if (filesDir !== undefined) {
            await fs.rm(filesDir, { recursive: true, force: true });
        }
        this._s.delStorage.run(this.id);
        this._s.delKeys.run(this.id);
        this._s.delSlot.run(this.id);
    }

    private _ensureRow(): void {
        this._s.ensureSlot.run(this.id, Date.now());
    }
}

/** Per-slot KV backing `identity.storage::*`, one row per key in `identity_storage`. */
class _SqliteSlotStorage implements ManagedIdentityStorageBackend {
    constructor(
        private readonly _slotId: SlotId,
        private readonly _s: _Stmts,
    ) {}

    public async get(key: string): Promise<unknown | undefined> {
        const row = this._s.storGet.get(this._slotId, key) as { value: string } | undefined;
        if (row === undefined) return undefined;
        return JSON.parse(_codec.decode(this._slotId, row.value));
    }

    public async set(key: string, value: unknown): Promise<void> {
        this._s.ensureSlot.run(this._slotId, Date.now());
        this._s.storSet.run(this._slotId, key, _codec.encode(this._slotId, JSON.stringify(value)));
    }

    public async delete(key: string): Promise<boolean> {
        const res = this._s.storDel.run(this._slotId, key);
        return res.changes > 0;
    }

    public async list(prefix?: string): Promise<string[]> {
        const rows = this._s.storKeys.all(this._slotId) as { key: string }[];
        const keys = rows.map((r) => r.key);
        return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    }
}

/** Canonical (sorted-field) JSON for exact access-key equality. */
function _canonicalKey(key: SlotAccessKey): string {
    const entries = Object.keys(key)
        .sort()
        .map((k) => [k, key[k]] as const);
    return JSON.stringify(entries);
}

/** Rebuild an access key from its canonical (sorted `[key, value]` pairs) JSON. */
function _fromCanonicalKey(canonical: string): SlotAccessKey {
    const entries = JSON.parse(canonical) as [string, string][];
    return Object.fromEntries(entries);
}
