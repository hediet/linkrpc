import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createIdentityKeystore as _createIdentityKeystore, type IdentityKeystoreOptions } from "./identityKeystore";

// `createIdentityKeystore` no longer takes a crypto provider (it uses the
// package `crypto` module). This adapter strips the `crypto` field so the
// existing call sites keep working unchanged.
function createIdentityKeystore(opts: IdentityKeystoreOptions & { crypto?: unknown }): ReturnType<typeof _createIdentityKeystore> {
    const { crypto: _c, ...rest } = opts;
    return _createIdentityKeystore(rest);
}

describe("identityKeystore (node, encrypted at rest)", () => {
    let dir: string;
    let secret: Uint8Array;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "hubrpc-idks-"));
        secret = new Uint8Array(randomBytes(32));
    });

    it("creates an identity on first getOrCreate and persists it across instances", async () => {
        const a = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
        const id1 = await a.slotById("service:az").getOrCreateIdentity();
        const nodeId1 = id1.principal;
        const wrapPub1 = Array.from(id1.wrapPublicKey);

        // New instance, same dir + same secret → same identity.
        const b = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
        const id2 = await b.slotById("service:az").getOrCreateIdentity();
        expect(id2.principal).toBe(nodeId1);
        expect(Array.from(id2.wrapPublicKey)).toEqual(wrapPub1);
    });

    it("get returns undefined when no file exists", async () => {
        const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
        expect(await ks.slotById("service:never-created").peekIdentity()).toBeUndefined();
    });

    it("file on disk does NOT contain the raw private key in cleartext", async () => {
        const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
        const id = await ks.slotById("service:az").getOrCreateIdentity();

        // We can't enumerate by slot because filenames are hashed, but the
        // directory only has one file at this point.
        const files = await fs.readdir(dir);
        expect(files).toHaveLength(1);
        const raw = await fs.readFile(path.join(dir, files[0]));
        // Sanity: file is not plaintext JSON.
        expect(() => JSON.parse(raw.toString("utf8"))).toThrow();
        // The ed25519 private key bytes must not appear in the file.
        const priv = (id as unknown as { _ed: { privateKey: Uint8Array } })._ed.privateKey;
        for (let i = 0; i + priv.length <= raw.length; i++) {
            let match = true;
            for (let j = 0; j < priv.length; j++) {
                if (raw[i + j] !== priv[j]) { match = false; break; }
            }
            expect(match, `private key bytes found at offset ${i}`).toBe(false);
        }
    });

    it("get fails with the wrong keystore secret", async () => {
        const goodSecret = new Uint8Array(randomBytes(32));
        const badSecret = new Uint8Array(randomBytes(32));

        const a = createIdentityKeystore({ storageDir: dir, keystoreSecret: goodSecret, crypto });
        await a.slotById("service:az").getOrCreateIdentity();

        const b = createIdentityKeystore({ storageDir: dir, keystoreSecret: badSecret, crypto });
        await expect(b.slotById("service:az").peekIdentity()).rejects.toThrow();
    });

    it("delete removes the file and forgets the cached identity", async () => {
        const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
        const slot = ks.slotById("service:tmp");
        await slot.getOrCreateIdentity();
        await slot.delete();
        expect(await slot.peekIdentity()).toBeUndefined();
    });

    it("different slots get different identities, both persisted", async () => {
        const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
        const a = await ks.slotById("service:az").getOrCreateIdentity();
        const b = await ks.slotById("service:github").getOrCreateIdentity();
        expect(a.principal).not.toBe(b.principal);

        const ks2 = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
        const a2 = await ks2.slotById("service:az").peekIdentity();
        const b2 = await ks2.slotById("service:github").peekIdentity();
        expect(a2?.principal).toBe(a.principal);
        expect(b2?.principal).toBe(b.principal);
    });

    it("rejects too-short keystore secret", () => {
        expect(() =>
            createIdentityKeystore({ storageDir: dir, keystoreSecret: new Uint8Array(16), crypto }),
        ).toThrow();
    });

    describe("storageFor", () => {
        it("returns undefined for a missing key on a fresh slot", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("service:az");
            await slot.getOrCreateIdentity();
            const storage = slot.storage;
            expect(await storage.get("missing")).toBeUndefined();
            expect(await storage.list()).toEqual([]);
        });

        it("set / get round-trips and persists across instances", async () => {
            const a = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            await a.slotById("service:az").getOrCreateIdentity();
            const s1 = a.slotById("service:az").storage;
            await s1.set("caps.v1", [{ a: 1 }, { b: 2 }]);

            const b = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const s2 = b.slotById("service:az").storage;
            expect(await s2.get("caps.v1")).toEqual([{ a: 1 }, { b: 2 }]);
        });

        it("delete reports `existed` correctly", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("service:az");
            await slot.getOrCreateIdentity();
            const storage = slot.storage;
            await storage.set("k", 1);
            expect(await storage.delete("k")).toBe(true);
            expect(await storage.delete("k")).toBe(false);
        });

        it("list returns only entries matching the prefix", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("service:az");
            await slot.getOrCreateIdentity();
            const storage = slot.storage;
            await storage.set("a/x", 1);
            await storage.set("a/y", 2);
            await storage.set("b/z", 3);
            expect((await storage.list("a/")).sort()).toEqual(["a/x", "a/y"]);
            expect((await storage.list()).sort()).toEqual(["a/x", "a/y", "b/z"]);
        });

        it("different slots get isolated storage", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            await ks.slotById("service:a").getOrCreateIdentity();
            await ks.slotById("service:b").getOrCreateIdentity();
            await ks.slotById("service:a").storage.set("k", "from-a");
            await ks.slotById("service:b").storage.set("k", "from-b");
            expect(await ks.slotById("service:a").storage.get("k")).toBe("from-a");
            expect(await ks.slotById("service:b").storage.get("k")).toBe("from-b");
        });

        it("storage file on disk does NOT contain the cleartext value", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("service:az");
            await slot.getOrCreateIdentity();
            const storage = slot.storage;
            const marker = "PLAINTEXT-MARKER-VALUE";
            await storage.set("caps.v1", marker);

            const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".storage.bin"));
            expect(files).toHaveLength(1);
            const raw = await fs.readFile(path.join(dir, files[0]));
            expect(raw.toString("utf8").includes(marker)).toBe(false);
        });

        it("storage decryption fails with the wrong keystore secret", async () => {
            const good = new Uint8Array(randomBytes(32));
            const bad = new Uint8Array(randomBytes(32));

            const a = createIdentityKeystore({ storageDir: dir, keystoreSecret: good, crypto });
            await a.slotById("service:az").getOrCreateIdentity();
            await a.slotById("service:az").storage.set("k", "v");

            const b = createIdentityKeystore({ storageDir: dir, keystoreSecret: bad, crypto });
            // We must NOT create the identity (that would fail first on the identity file);
            // just hitting `slotById(...).storage.get(...)` exercises the storage decrypt path.
            await expect(b.slotById("service:az").storage.get("k")).rejects.toThrow();
        });

        it("delete(slot) wipes the storage file too", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            await ks.slotById("service:tmp").getOrCreateIdentity();
            await ks.slotById("service:tmp").storage.set("k", "v");
            await ks.slotById("service:tmp").delete();

            // Recreate the identity and verify storage starts empty.
            await ks.slotById("service:tmp").getOrCreateIdentity();
            expect(await ks.slotById("service:tmp").storage.get("k")).toBeUndefined();

            // Confirm no `*.storage.bin` file lingers.
            const files = await fs.readdir(dir);
            const storageFiles = files.filter((f) => f.endsWith(".storage.bin"));
            expect(storageFiles).toEqual([]);
        });
    });

    describe("consent snooze", () => {
        it("getSnooze returns undefined when none has been set", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            expect(await ks.slotById("app:x").getSnooze()).toBeUndefined();
        });

        it("setSnooze round-trips and persists across instances", async () => {
            const expiresAt = Date.now() + 60_000;
            const a = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            await a.slotById("app:x").setSnooze({ scope: "all", expiresAt });

            const b = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            expect(await b.slotById("app:x").getSnooze()).toEqual({ scope: "all", expiresAt });
        });

        it("setSnooze overwrites a previous snooze", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("app:x");
            await slot.setSnooze({ scope: "entry", expiresAt: Date.now() + 60_000 });
            const next = { scope: "all", expiresAt: Date.now() + 120_000 } as const;
            await slot.setSnooze(next);
            expect(await slot.getSnooze()).toEqual(next);
        });

        it("getSnooze treats an expired snooze as absent", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("app:x");
            await slot.setSnooze({ scope: "all", expiresAt: Date.now() - 1 });
            expect(await slot.getSnooze()).toBeUndefined();
        });

        it("clearSnooze removes the snooze", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("app:x");
            await slot.setSnooze({ scope: "all", expiresAt: Date.now() + 60_000 });
            await slot.clearSnooze();
            expect(await slot.getSnooze()).toBeUndefined();
        });

        it("the snooze file on disk does NOT contain the scope in cleartext", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            await ks.slotById("app:x").setSnooze({ scope: "all", expiresAt: Date.now() + 60_000 });
            const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".snooze.bin"));
            expect(files).toHaveLength(1);
            const raw = await fs.readFile(path.join(dir, files[0]));
            expect(() => JSON.parse(raw.toString("utf8"))).toThrow();
        });

        it("snooze decryption fails with the wrong keystore secret", async () => {
            const good = new Uint8Array(randomBytes(32));
            const bad = new Uint8Array(randomBytes(32));
            const a = createIdentityKeystore({ storageDir: dir, keystoreSecret: good, crypto });
            await a.slotById("app:x").setSnooze({ scope: "all", expiresAt: Date.now() + 60_000 });
            const b = createIdentityKeystore({ storageDir: dir, keystoreSecret: bad, crypto });
            await expect(b.slotById("app:x").getSnooze()).rejects.toThrow();
        });

        it("delete wipes the snooze file too", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.createSlotWithKey("app:x", { appId: "a", bundleHash: "h" });
            await (await slot).setSnooze({ scope: "all", expiresAt: Date.now() + 60_000 });
            await ks.slotById("app:x").delete();
            expect(await ks.slotById("app:x").getSnooze()).toBeUndefined();
            const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".snooze.bin"));
            expect(files).toEqual([]);
        });
    });

    describe("app files folder", () => {
        it("getFilesDir returns undefined when none has been recorded", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            expect(await ks.slotById("app:x").getFilesDir()).toBeUndefined();
        });

        it("setFilesDir round-trips and persists across instances", async () => {
            const target = path.join(dir, "app-files", "myapp");
            const a = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            await a.slotById("app:x").setFilesDir(target);

            const b = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            expect(await b.slotById("app:x").getFilesDir()).toBe(target);
        });

        it("hasFiles is false with no folder, no contents; true once a file exists", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("app:x");
            expect(await slot.hasFiles()).toBe(false);

            const target = path.join(dir, "files-x");
            await fs.mkdir(target, { recursive: true });
            await slot.setFilesDir(target);
            expect(await slot.hasFiles()).toBe(false);

            await fs.writeFile(path.join(target, "note.md"), "hi");
            expect(await slot.hasFiles()).toBe(true);
        });

        it("hasState reflects app files even without an identity or storage", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("app:x");
            expect(await slot.hasState()).toBe(false);

            const target = path.join(dir, "files-x");
            await fs.mkdir(target, { recursive: true });
            await slot.setFilesDir(target);
            await fs.writeFile(path.join(target, "note.md"), "hi");

            expect(await slot.hasState()).toBe(true);
        });

        it("wipeFiles empties the folder but keeps the folder and its record", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("app:x");
            const target = path.join(dir, "files-x");
            await fs.mkdir(path.join(target, "sub"), { recursive: true });
            await fs.writeFile(path.join(target, "a.md"), "a");
            await fs.writeFile(path.join(target, "sub", "b.md"), "b");
            await slot.setFilesDir(target);

            await slot.wipeFiles();

            expect(await slot.hasFiles()).toBe(false);
            // Folder still exists and the slot still points at it.
            expect((await fs.readdir(target))).toEqual([]);
            expect(await slot.getFilesDir()).toBe(target);
        });

        it("delete wipes the whole folder and forgets its record", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const slot = ks.slotById("app:x");
            const target = path.join(dir, "files-x");
            await fs.mkdir(target, { recursive: true });
            await fs.writeFile(path.join(target, "a.md"), "a");
            await slot.setFilesDir(target);

            await slot.delete();

            await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
            expect(await ks.slotById("app:x").getFilesDir()).toBeUndefined();
            const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".filesdir.bin"));
            expect(files).toEqual([]);
        });

        it("the filesdir record on disk does NOT contain the path in cleartext", async () => {
            const ks = createIdentityKeystore({ storageDir: dir, keystoreSecret: secret, crypto });
            const marker = path.join(dir, "PLAINTEXT-DIR-MARKER");
            await ks.slotById("app:x").setFilesDir(marker);
            const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".filesdir.bin"));
            expect(files).toHaveLength(1);
            const raw = await fs.readFile(path.join(dir, files[0]));
            expect(raw.toString("utf8").includes("PLAINTEXT-DIR-MARKER")).toBe(false);
        });

        it("filesdir decryption fails with the wrong keystore secret", async () => {
            const good = new Uint8Array(randomBytes(32));
            const bad = new Uint8Array(randomBytes(32));
            const a = createIdentityKeystore({ storageDir: dir, keystoreSecret: good, crypto });
            await a.slotById("app:x").setFilesDir(path.join(dir, "files-x"));
            const b = createIdentityKeystore({ storageDir: dir, keystoreSecret: bad, crypto });
            await expect(b.slotById("app:x").getFilesDir()).rejects.toThrow();
        });
    });
});
