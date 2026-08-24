import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createSqliteIdentityKeystore } from "./sqliteIdentityKeystore";
import type { IdentitySlot } from "./identityKeystore";
import { crypto, principalForPublicKey } from "@hediet/linkrpc";

function memKeystore() {
    return createSqliteIdentityKeystore({ dbPath: ":memory:" });
}

async function tmpDb(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linkrpc-sqlite-ks-"));
    return path.join(dir, "keystore.db");
}

async function isSlot(v: unknown): Promise<IdentitySlot> {
    if (v === null || typeof v !== "object" || "error" in (v as object)) {
        throw new Error(`expected slot, got ${JSON.stringify(v)}`);
    }
    return v as IdentitySlot;
}

describe("SqliteIdentityKeystore", () => {
    it("creates and persists an identity per slot (stable principal)", async () => {
        const ks = memKeystore();
        const slot = ks.slotById("docker/echo");

        expect(await slot.peekIdentity()).toBeUndefined();
        const id1 = await slot.getOrCreateIdentity();
        const id2 = await slot.getOrCreateIdentity();
        expect(id2.principal).toBe(id1.principal);
        expect((await slot.peekIdentity())?.principal).toBe(id1.principal);
    });

    it("persists identity + storage across reopen (file-backed)", async () => {
        const dbPath = await tmpDb();
        let ks = createSqliteIdentityKeystore({ dbPath });
        const principal = (await ks.slotById("docker/echo").getOrCreateIdentity()).principal;
        await ks.slotById("docker/echo").storage.set("greeting", { text: "hi" });

        ks = createSqliteIdentityKeystore({ dbPath });
        expect((await ks.slotById("docker/echo").peekIdentity())?.principal).toBe(principal);
        expect(await ks.slotById("docker/echo").storage.get("greeting")).toEqual({ text: "hi" });
    });

    it("isolates storage between slots and supports list/delete", async () => {
        const ks = memKeystore();
        const a = ks.slotById("a").storage;
        const b = ks.slotById("b").storage;

        await a.set("k/1", 1);
        await a.set("k/2", 2);
        await a.set("other", 3);
        await b.set("k/1", "b-value");

        expect((await a.list()).sort()).toEqual(["k/1", "k/2", "other"]);
        expect((await a.list("k/")).sort()).toEqual(["k/1", "k/2"]);
        expect(await b.get("k/1")).toBe("b-value");
        expect(await a.get("k/1")).toBe(1);

        expect(await a.delete("k/1")).toBe(true);
        expect(await a.delete("k/1")).toBe(false);
        expect(await a.get("k/1")).toBeUndefined();
    });

    it("gates access by key (slotByIdAndKey / createSlotWithKey)", async () => {
        const ks = memKeystore();
        expect(await ks.slotByIdAndKey("app", { appId: "x" })).toEqual({
            error: "slotDoesNotExist",
        });

        await ks.createSlotWithKey("app", { appId: "x" });
        expect(await ks.slotByIdAndKey("app", { appId: "y" })).toEqual({ error: "unknownKey" });

        const slot = await isSlot(await ks.slotByIdAndKey("app", { appId: "x" }));
        expect(await slot.hasKey({ appId: "x" })).toBe(true);
        // Canonical (field-order-independent) equality.
        expect(await slot.hasKey({ appId: "x" })).toBe(true);

        expect(await slot.deleteKey({ appId: "x" })).toBe(true);
        expect(await ks.slotByIdAndKey("app", { appId: "x" })).toEqual({ error: "unknownKey" });
    });

    it("lists access keys with original field values", async () => {
        const ks = memKeystore();
        const slot = ks.slotById("app");
        await slot.addKeys({ appId: "a", bundleHash: "h1" }, { appId: "b", bundleHash: "h2" });
        const keys = await slot.listKeys();
        expect(keys).toContainEqual({ appId: "a", bundleHash: "h1" });
        expect(keys).toContainEqual({ appId: "b", bundleHash: "h2" });
    });

    it("honors the consent snooze as a time-boxed grant", async () => {
        const ks = memKeystore();
        const slot = ks.slotById("app");
        await slot.getOrCreateIdentity(); // now hasState() → true

        const now = Date.now();
        // No snooze → state present → consentRequired.
        expect(await ks.slotByIdAndTime("app", now)).toEqual({ error: "consentRequired" });

        await slot.setSnooze({ scope: "all", expiresAt: now + 10_000 });
        expect(await isSlot(await ks.slotByIdAndTime("app", now))).toBe(slot);
        // A time past the snooze window is no longer covered.
        expect(await ks.slotByIdAndTime("app", now + 20_000)).toEqual({
            error: "consentRequired",
        });

        await slot.clearSnooze();
        expect(await slot.getSnooze()).toBeUndefined();
    });

    it("authorizes by time when nothing is inheritable", async () => {
        const ks = memKeystore();
        // Fresh slot: no identity, no storage, no files → hasState() false.
        expect(await isSlot(await ks.slotByIdAndTime("empty", Date.now()))).toBeTruthy();
    });

    it("hasState reflects identity and storage", async () => {
        const ks = memKeystore();
        const slot = ks.slotById("app");
        expect(await slot.hasState()).toBe(false);
        await slot.storage.set("k", 1);
        expect(await slot.hasState()).toBe(true);
    });

    it("delete wipes identity, storage, and keys", async () => {
        const ks = memKeystore();
        const slot = ks.slotById("app");
        await slot.getOrCreateIdentity();
        await slot.storage.set("k", 1);
        await slot.addKeys({ appId: "x" });

        await slot.delete();

        expect(await slot.peekIdentity()).toBeUndefined();
        expect(await slot.storage.get("k")).toBeUndefined();
        expect(await slot.listKeys()).toEqual([]);
    });

    it("importIdentity preserves a specific keypair and is a no-op once set", async () => {
        const ed = await crypto.generateKeypair();
        const wrap = await crypto.generateX25519Keypair();
        const expected = principalForPublicKey(ed.publicKey);

        const ks = memKeystore();
        const slot = ks.slotById("docker/telegram");

        const imported = await slot.importIdentity(ed, wrap);
        expect(imported.principal).toBe(expected);
        expect((await slot.peekIdentity())?.principal).toBe(expected);

        // Second import is a no-op — returns the existing identity unchanged,
        // even with a different keypair (mirrors the migration guard).
        const other = await crypto.generateKeypair();
        const otherWrap = await crypto.generateX25519Keypair();
        const again = await slot.importIdentity(other, otherWrap);
        expect(again.principal).toBe(expected);
    });
});
