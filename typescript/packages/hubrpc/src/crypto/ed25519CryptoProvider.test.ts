import { describe, expect, it } from "vitest";
import {
    KeypairSigningIdentity,
    permits,
    signCapability,
    signedHash,
    type Call,
    type CallTarget,
    type PrincipalId,
    type Permission,
    type SignedCapability,
} from "../index";
import * as crypto from "./crypto";

const fullAccess: Permission = {
    target: { serviceId: { prefix: "" }, interfaceId: { prefix: "" }, members: [{ prefix: "" }] },
    canInvoke: true,
    canDelegate: true,
};

function makeCall(target: CallTarget, signer: PrincipalId): Call {
    return { target, params: undefined, nonce: "req", signedAtMs: 0, signer, callHash: "" };
}

/** Accept-all root policy pinned to a single trusted issuer. */
function accept(issuer: PrincipalId) {
    return () => [{ principal: issuer, isPublic: true }];
}

describe("crypto facade", () => {
    it("generates 32-byte keys", async () => {
        const k = await crypto.generateKeypair();
        expect(k.publicKey.length).toBe(32);
        expect(k.privateKey.length).toBe(32);
    });

    it("sign/verify round-trip succeeds with the right key", async () => {
        const k = await crypto.generateKeypair();
        const msg = new TextEncoder().encode("hello");
        const sig = await crypto.sign(k.privateKey, msg);
        expect(sig.length).toBe(64);
        expect(await crypto.verify(k.publicKey, msg, sig)).toBe(true);
    });

    it("verify rejects a wrong key", async () => {
        const a = await crypto.generateKeypair();
        const b = await crypto.generateKeypair();
        const msg = new TextEncoder().encode("hello");
        const sig = await crypto.sign(a.privateKey, msg);
        expect(await crypto.verify(b.publicKey, msg, sig)).toBe(false);
    });

    it("verify rejects a tampered message", async () => {
        const k = await crypto.generateKeypair();
        const sig = await crypto.sign(k.privateKey, new TextEncoder().encode("hello"));
        expect(await crypto.verify(k.publicKey, new TextEncoder().encode("hello!"), sig)).toBe(false);
    });

    it("verify rejects garbage signature without throwing", async () => {
        const k = await crypto.generateKeypair();
        expect(await crypto.verify(k.publicKey, new Uint8Array([1, 2, 3]), new Uint8Array(64))).toBe(false);
    });

    it("works end-to-end with permits", async () => {
        const admin = await KeypairSigningIdentity.generateNew();
        const holder = await KeypairSigningIdentity.generateNew();
        const adminId = admin.publicSigningIdentity.principal;
        const holderId = holder.publicSigningIdentity.principal;

        const leaf = await signCapability({
            issuer: adminId, audience: holderId, nonce: "n1",
            permissions: [fullAccess],
        }, admin);

        const target: CallTarget = { serviceId: "github", interfaceId: "x.y", member: "do" };
        const r = await permits(makeCall(target, holderId), [leaf], accept(adminId), 0);
        expect(r).toMatchObject({ ok: true, rootIssuer: adminId });
    });

    it("end-to-end 2-link chain", async () => {
        const admin = await KeypairSigningIdentity.generateNew();
        const middle = await KeypairSigningIdentity.generateNew();
        const holder = await KeypairSigningIdentity.generateNew();
        const adminId = admin.publicSigningIdentity.principal;
        const middleId = middle.publicSigningIdentity.principal;
        const holderId = holder.publicSigningIdentity.principal;

        const parent = await signCapability({
            issuer: adminId, audience: middleId, nonce: "p",
            permissions: [fullAccess],
        }, admin);
        const leaf = await signCapability({
            issuer: middleId, audience: holderId, nonce: "l",
            permissions: [fullAccess],
            parentHash: signedHash("capability", parent),
        }, middle);

        const r = await permits(
            makeCall({ serviceId: "anything", interfaceId: "any.thing", member: "do" }, holderId),
            [leaf, parent as SignedCapability],
            accept(adminId),
            0,
        );
        expect(r).toMatchObject({ ok: true, rootIssuer: adminId });
    });

    describe("X25519 + HPKE", () => {
        const enc = (s: string) => new TextEncoder().encode(s);

        it("generates 32-byte X25519 keys", async () => {
            const k = await crypto.generateX25519Keypair();
            expect(k.publicKey.length).toBe(32);
            expect(k.privateKey.length).toBe(32);
        });

        it("seal/open round-trip recovers the plaintext", async () => {
            const r = await crypto.generateX25519Keypair();
            const pt = enc("the master key");
            const blob = await crypto.hpkeSeal({
                recipientPublicKey: r.publicKey,
                domain: enc("test.master.v1"),
                plaintext: pt,
            });
            // enc (32) || ct (== pt.length) || tag (16)
            expect(blob.length).toBe(32 + pt.length + 16);
            const opened = await crypto.hpkeOpen({
                recipientPrivateKey: r.privateKey,
                domain: enc("test.master.v1"),
                blob,
            });
            expect(Array.from(opened)).toEqual(Array.from(pt));
        });

        it("each seal produces a fresh ephemeral key (non-deterministic)", async () => {
            const r = await crypto.generateX25519Keypair();
            const a = await crypto.hpkeSeal({
                recipientPublicKey: r.publicKey,
                domain: enc("d"),
                plaintext: enc("x"),
            });
            const b = await crypto.hpkeSeal({
                recipientPublicKey: r.publicKey,
                domain: enc("d"),
                plaintext: enc("x"),
            });
            expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
        });

        it("open with the wrong domain fails", async () => {
            const r = await crypto.generateX25519Keypair();
            const blob = await crypto.hpkeSeal({
                recipientPublicKey: r.publicKey,
                domain: enc("d.a"),
                plaintext: enc("secret"),
            });
            await expect(crypto.hpkeOpen({
                recipientPrivateKey: r.privateKey,
                domain: enc("d.b"),
                blob,
            })).rejects.toThrow();
        });

        it("open with the wrong recipient private key fails", async () => {
            const a = await crypto.generateX25519Keypair();
            const b = await crypto.generateX25519Keypair();
            const blob = await crypto.hpkeSeal({
                recipientPublicKey: a.publicKey,
                domain: enc("d"),
                plaintext: enc("secret"),
            });
            await expect(crypto.hpkeOpen({
                recipientPrivateKey: b.privateKey,
                domain: enc("d"),
                blob,
            })).rejects.toThrow();
        });

        it("open on a tampered ciphertext fails", async () => {
            const r = await crypto.generateX25519Keypair();
            const blob = await crypto.hpkeSeal({
                recipientPublicKey: r.publicKey,
                domain: enc("d"),
                plaintext: enc("secret"),
            });
            blob[blob.length - 17] ^= 0x01; // flip a bit in the ciphertext, just before the tag
            await expect(crypto.hpkeOpen({
                recipientPrivateKey: r.privateKey,
                domain: enc("d"),
                blob,
            })).rejects.toThrow();
        });

        it("open on a too-short blob fails", async () => {
            const r = await crypto.generateX25519Keypair();
            await expect(crypto.hpkeOpen({
                recipientPrivateKey: r.privateKey,
                domain: enc("d"),
                blob: new Uint8Array(10),
            })).rejects.toThrow();
        });
    });
});
