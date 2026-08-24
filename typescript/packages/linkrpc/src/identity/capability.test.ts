import { describe, expect, it } from "vitest";
import { type PrincipalId } from "../crypto/cryptoProvider";
import { KeypairSigningIdentity } from "./identity";
import {
    capabilityFreshAt,
    capBagFreshAt,
    issueCapability,
    permissionMatchesTarget,
    permits,
    signCapability,
    signedHash,
    type Call,
    type CallTarget,
    type Capability,
    type Permission,
    type SignedCapability,
} from "./capability";
import { permissionPermits } from "../protocol/capability";

// ---- helpers ------------------------------------------------------------

/** Parent content hash, for wiring a leaf's `parentHash`. */
function parentHashOf(cap: SignedCapability) {
    return signedHash<Capability>("capability", cap);
}

/** A permission addressing everything, usable as both leaf and delegate link. */
const fullAccess: Permission = {
    target: { serviceId: { prefix: "" }, interfaceId: { prefix: "" }, members: [{ prefix: "" }] },
    canInvoke: true,
    canDelegate: true,
};

/** `read*` members on a single service, usable as both leaf and delegate link. */
function readService(svc: string): Permission {
    return {
        target: { serviceId: { prefix: svc }, interfaceId: { prefix: "" }, members: [{ prefix: "read" }] },
        canInvoke: true,
        canDelegate: true,
    };
}

function makeCall(target: CallTarget, signer: PrincipalId): Call {
    return { target, params: undefined, nonce: "req", signedAtMs: 0, signer, callHash: "" };
}

// ---- permissionMatchesTarget (pure addressing) --------------------------

describe("permissionMatchesTarget", () => {
    const target: CallTarget = { serviceId: "github/repos", interfaceId: "linkrpc.directory", member: "list" };

    it("matches when a permission addresses every axis", () => {
        expect(permissionMatchesTarget(target, {
            target: { serviceId: { prefix: "github" }, interfaceId: { exact: "linkrpc.directory" }, members: [{ exact: "list" }] },
            canInvoke: true,
        })).toBe(true);
    });

    it("delimited-prefix on serviceId distinguishes `github` from `githubclone`", () => {
        const perm: Permission = {
            target: { serviceId: { prefix: "github" }, interfaceId: { prefix: "" }, members: [{ prefix: "" }] },
            canInvoke: true,
        };
        expect(permissionMatchesTarget({ ...target, serviceId: "github" }, perm)).toBe(true);
        expect(permissionMatchesTarget({ ...target, serviceId: "github/repos" }, perm)).toBe(true);
        expect(permissionMatchesTarget({ ...target, serviceId: "githubclone" }, perm)).toBe(false);
    });

    it("delimited-prefix on interfaceId uses `.`", () => {
        const perm: Permission = {
            target: { serviceId: { prefix: "" }, interfaceId: { prefix: "linkrpc" }, members: [{ prefix: "" }] },
            canInvoke: true,
        };
        expect(permissionMatchesTarget({ ...target, interfaceId: "linkrpc" }, perm)).toBe(true);
        expect(permissionMatchesTarget({ ...target, interfaceId: "linkrpc.directory" }, perm)).toBe(true);
        expect(permissionMatchesTarget({ ...target, interfaceId: "linkrpcx.foo" }, perm)).toBe(false);
    });

    it("member uses raw startsWith (no delimiter)", () => {
        const perm: Permission = {
            target: { serviceId: { prefix: "" }, interfaceId: { prefix: "" }, members: [{ prefix: "get" }] },
            canInvoke: true,
        };
        expect(permissionMatchesTarget({ ...target, member: "get" }, perm)).toBe(true);
        expect(permissionMatchesTarget({ ...target, member: "getter" }, perm)).toBe(true);
        expect(permissionMatchesTarget({ ...target, member: "set" }, perm)).toBe(false);
    });

    it("empty prefix matches anything on that axis", () => {
        expect(permissionMatchesTarget(target, fullAccess)).toBe(true);
    });

    it("returns false when the permission does not address the call", () => {
        expect(permissionMatchesTarget(target, {
            target: { serviceId: { exact: "gitlab" }, interfaceId: { prefix: "" }, members: [{ prefix: "" }] },
            canInvoke: true,
        })).toBe(false);
    });

    it("ORs across multiple permissions", () => {
        const perms: Permission[] = [
            { target: { serviceId: { exact: "gitlab" }, interfaceId: { prefix: "" }, members: [{ prefix: "" }] }, canInvoke: true },
            { target: { serviceId: { prefix: "github" }, interfaceId: { prefix: "" }, members: [{ prefix: "" }] }, canInvoke: true },
        ];
        expect(perms.some((p) => permissionMatchesTarget(target, p))).toBe(true);
    });
});

describe("permissionPermits target diagnostics", () => {
    const target: CallTarget = {
        serviceId: "docker/auth",
        interfaceId: "auth",
        interfaceHash: "current-hash",
        member: "listIdentities",
    };
    const call = makeCall(target, "id:key:caller" as PrincipalId);

    it.each([
        {
            label: "service id",
            permission: {
                target: {
                    serviceId: { exact: "docker/other" },
                    interfaceId: { exact: "auth" },
                    members: [{ exact: "listIdentities" }],
                },
                canInvoke: true,
            } satisfies Permission,
            reason: 'serviceId "docker/auth" does not match exact "docker/other"',
        },
        {
            label: "interface id",
            permission: {
                target: {
                    serviceId: { exact: "docker/auth" },
                    interfaceId: { exact: "other" },
                    members: [{ exact: "listIdentities" }],
                },
                canInvoke: true,
            } satisfies Permission,
            reason: 'interfaceId "auth" does not match exact "other"',
        },
        {
            label: "interface hash",
            permission: {
                target: {
                    serviceId: { exact: "docker/auth" },
                    interfaceId: { exact: "auth" },
                    interfaceHash: "old-hash",
                    members: [{ exact: "listIdentities" }],
                },
                canInvoke: true,
            } satisfies Permission,
            reason: 'interfaceHash "current-hash" does not match required "old-hash"',
        },
        {
            label: "member",
            permission: {
                target: {
                    serviceId: { exact: "docker/auth" },
                    interfaceId: { exact: "auth" },
                    members: [{ exact: "listAccounts" }, { prefix: "get" }],
                },
                canInvoke: true,
            } satisfies Permission,
            reason: 'member "listIdentities" does not match allowed patterns [exact "listAccounts", prefix "get"]',
        },
    ])("reports the mismatched $label", ({ permission, reason }) => {
        expect(permissionPermits(call, permission, "invoke")).toEqual({
            ok: false,
            reason: `permission does not address this call: ${reason}`,
        });
    });
});

// ---- chain verification (exercised through the public `permits`) --------

describe("chain verification (via permits)", () => {
    const target: CallTarget = { serviceId: "github/repos", interfaceId: "linkrpc.directory", member: "readItems" };

    /**
     * Accept exactly `issuer` as the chain root for any service, so a failing
     * assertion reflects chain *structure* (signature/expiry/delegation/depth)
     * rather than a root-trust rejection.
     */
    function accept(issuer: PrincipalId) {
        return () => [{ principal: issuer, isPublic: true }];
    }

    async function setup() {
        const admin = await KeypairSigningIdentity.generateNew();
        const middle = await KeypairSigningIdentity.generateNew();
        const holder = await KeypairSigningIdentity.generateNew();
        return {
            admin,
            middle,
            holder,
            adminId: admin.publicSigningIdentity.principal,
            middleId: middle.publicSigningIdentity.principal,
            holderId: holder.publicSigningIdentity.principal,
        };
    }

    it("accepts a single-link valid cap", async () => {
        const s = await setup();
        const leaf = await signCapability({
            issuer: s.adminId, audience: s.holderId, nonce: "n1", permissions: [fullAccess],
        }, s.admin);

        const r = await permits(makeCall(target, s.holderId), [leaf], accept(s.adminId), 0);
        expect(r).toMatchObject({ ok: true, rootIssuer: s.adminId });
    });

    it("rejects audience mismatch on the leaf", async () => {
        const s = await setup();
        const leaf = await signCapability({
            issuer: s.adminId, audience: s.middleId, nonce: "n1", permissions: [fullAccess],
        }, s.admin);

        const r = await permits(makeCall(target, s.holderId), [leaf], accept(s.adminId), 0);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/audience mismatch/);
    });

    it("rejects expired cap", async () => {
        const s = await setup();
        const leaf = await signCapability({
            issuer: s.adminId, audience: s.holderId, nonce: "n1", expiresAtMs: 1000, permissions: [fullAccess],
        }, s.admin);
        const r = await permits(makeCall(target, s.holderId), [leaf], accept(s.adminId), 2000);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("expired");
    });

    it("rejects forged signature", async () => {
        const s = await setup();
        const leaf = await signCapability({
            issuer: s.adminId, audience: s.holderId, nonce: "n1", permissions: [fullAccess],
        }, s.admin);
        const tampered = {
            ...leaf,
            $linkrpcSignature: {
                capability: {
                    ...leaf.$linkrpcSignature.capability!,
                    sig: (leaf.$linkrpcSignature.capability!.sig.startsWith("A") ? "B" : "A")
                        + leaf.$linkrpcSignature.capability!.sig.slice(1),
                },
            },
        };
        const r = await permits(makeCall(target, s.holderId), [tampered], accept(s.adminId), 0);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("bad signature");
    });

    it("rejects a call the leaf does not address", async () => {
        const s = await setup();
        const leaf = await signCapability({
            issuer: s.adminId, audience: s.holderId, nonce: "n1", permissions: [readService("gitlab")],
        }, s.admin);
        const r = await permits(makeCall(target, s.holderId), [leaf], accept(s.adminId), 0);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/does not address/);
    });

    it("rejects a leaf that grants only delegate (not invoke)", async () => {
        const s = await setup();
        const leaf = await signCapability({
            issuer: s.adminId, audience: s.holderId, nonce: "n1",
            permissions: [{ ...fullAccess, canInvoke: false, canDelegate: true }],
        }, s.admin);
        const r = await permits(makeCall(target, s.holderId), [leaf], accept(s.adminId), 0);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/does not grant invoke/);
    });

    it("accepts a valid 2-link delegation chain", async () => {
        const s = await setup();
        const parent = await signCapability({
            issuer: s.adminId, audience: s.middleId, nonce: "p", permissions: [readService("github")],
        }, s.admin);
        const leaf = await signCapability({
            issuer: s.middleId, audience: s.holderId, nonce: "l",
            permissions: [readService("github")],
            parentHash: parentHashOf(parent),
        }, s.middle);

        const r = await permits(makeCall(target, s.holderId), [leaf, parent], accept(s.adminId), 0);
        expect(r).toMatchObject({ ok: true, rootIssuer: s.adminId });
    });

    it("issues a delegated capability with a generated nonce and parent hash", async () => {
        const s = await setup();
        const parent = await issueCapability(s.admin, {
            audience: s.middle.publicSigningIdentity,
            permissions: [readService("github")],
        });
        const leaf = await issueCapability(s.middle, {
            audience: s.holder.publicSigningIdentity,
            permissions: [readService("github")],
            parent,
        });

        expect(parent.nonce).not.toBe("");
        expect(leaf.nonce).not.toBe("");
        expect(leaf.parentHash).toBe(signedHash("capability", parent));
        const roundTripped = JSON.parse(JSON.stringify([leaf, parent])) as SignedCapability[];
        const r = await permits(makeCall(target, s.holderId), roundTripped, accept(s.adminId), Date.now());
        expect(r).toMatchObject({ ok: true, rootIssuer: s.adminId });
    });

    it("rejects a parent that grants invoke but not delegate", async () => {
        const s = await setup();
        const parent = await signCapability({
            issuer: s.adminId, audience: s.middleId, nonce: "p",
            permissions: [{ ...readService("github"), canDelegate: false }],
        }, s.admin);
        const leaf = await signCapability({
            issuer: s.middleId, audience: s.holderId, nonce: "l",
            permissions: [readService("github")],
            parentHash: parentHashOf(parent),
        }, s.middle);

        const r = await permits(makeCall(target, s.holderId), [leaf, parent], accept(s.adminId), 0);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/does not grant delegate/);
    });

    it("rejects amplification: leaf grants more than parent (intersection clamps)", async () => {
        const s = await setup();
        // parent: read on github
        const parent = await signCapability({
            issuer: s.adminId, audience: s.middleId, nonce: "p", permissions: [readService("github")],
        }, s.admin);
        // child claims write on anything (amplification!)
        const leaf = await signCapability({
            issuer: s.middleId, audience: s.holderId, nonce: "l",
            permissions: [{
                target: { serviceId: { prefix: "" }, interfaceId: { prefix: "" }, members: [{ prefix: "write" }] },
                canInvoke: true,
            }],
            parentHash: parentHashOf(parent),
        }, s.middle);

        // call: write on github → leaf says yes, parent says no (parent only allows read*)
        const r = await permits(
            makeCall({ serviceId: "github", interfaceId: "x.y", member: "writeFoo" }, s.holderId),
            [leaf, parent], accept(s.adminId), 0,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/does not address/);
    });

    it("rejects parent audience != child issuer", async () => {
        const s = await setup();
        // parent issued to admin itself (wrong: should be issued to middle)
        const parent = await signCapability({
            issuer: s.adminId, audience: s.adminId, nonce: "p", permissions: [fullAccess],
        }, s.admin);
        const leaf = await signCapability({
            issuer: s.middleId, audience: s.holderId, nonce: "l",
            permissions: [fullAccess],
            parentHash: parentHashOf(parent),
        }, s.middle);

        const r = await permits(makeCall(target, s.holderId), [leaf, parent], accept(s.adminId), 0);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/audience mismatch/);
    });

    it("enforces maxDepth", async () => {
        const s = await setup();
        // Build a 3-deep chain: admin → middle → middle → holder (depth 3).
        const root = await signCapability({
            issuer: s.adminId, audience: s.middleId, nonce: "r", permissions: [fullAccess],
        }, s.admin);
        const mid = await signCapability({
            issuer: s.middleId, audience: s.middleId, nonce: "m",
            permissions: [fullAccess],
            parentHash: parentHashOf(root),
        }, s.middle);
        const leaf = await signCapability({
            issuer: s.middleId, audience: s.holderId, nonce: "l",
            permissions: [fullAccess],
            parentHash: parentHashOf(mid),
        }, s.middle);

        const r = await permits(makeCall(target, s.holderId), [leaf, root, mid], accept(s.adminId), 0, { maxDepth: 2 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("chain too deep");
    });
});

// ---- permits (the single authorization entry point) ---------------------

describe("permits", () => {
    const target: CallTarget = { serviceId: "github/repos", interfaceId: "linkrpc.directory", member: "readItems" };

    async function setup() {
        const admin = await KeypairSigningIdentity.generateNew();
        const holder = await KeypairSigningIdentity.generateNew();
        const adminId = admin.publicSigningIdentity.principal;
        const holderId = holder.publicSigningIdentity.principal;
        const leaf = await signCapability({
            issuer: adminId, audience: holderId, nonce: "cap-n", permissions: [fullAccess],
        }, admin);
        return { admin, adminId, holderId, leaf };
    }

    it("permits when the chain roots at an accepted issuer for the service", async () => {
        const s = await setup();
        const r = await permits(makeCall(target, s.holderId), [s.leaf], () => [{ principal: s.adminId, isPublic: true }], 0);
        expect(r).toEqual({ ok: true, capabilityNonce: "cap-n", rootIssuer: s.adminId });
    });

    it("consults acceptedRootIssuers with the call's serviceId", async () => {
        const s = await setup();
        const seen: string[] = [];
        await permits(makeCall(target, s.holderId), [s.leaf], (svc) => {
            seen.push(svc);
            return [{ principal: s.adminId, isPublic: true }];
        }, 0);
        expect(seen).toEqual(["github/repos"]);
    });

    it("rejects (fail closed) when no root issuer is accepted for the service", async () => {
        const s = await setup();
        const r = await permits(makeCall(target, s.holderId), [s.leaf], () => [], 0);
        expect(r.ok).toBe(false);
    });

    it("rejects when the chain roots at an issuer that is not accepted", async () => {
        const s = await setup();
        const stranger = await KeypairSigningIdentity.generateNew();
        const r = await permits(
            makeCall(target, s.holderId),
            [s.leaf],
            () => [{ principal: stranger.publicSigningIdentity.principal, isPublic: true }],
            0,
        );
        expect(r.ok).toBe(false);
    });

    it("rejects when the signer is not the leaf audience", async () => {
        const s = await setup();
        const impostor = await KeypairSigningIdentity.generateNew();
        const r = await permits(
            makeCall(target, impostor.publicSigningIdentity.principal),
            [s.leaf],
            () => [{ principal: s.adminId, isPublic: true }],
            0,
        );
        expect(r.ok).toBe(false);
    });
});

// ---- capabilityFreshAt / capBagFreshAt (pure freshness) -----------------

describe("capabilityFreshAt", () => {
    function cap(expiresAtMs?: number): Capability {
        return {
            issuer: "iss" as PrincipalId,
            audience: "aud" as PrincipalId,
            permissions: [fullAccess],
            nonce: "n",
            ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
        };
    }

    it("treats a cap with no expiry as always fresh", () => {
        expect(capabilityFreshAt(cap(), 0)).toBe(true);
        expect(capabilityFreshAt(cap(), Number.MAX_SAFE_INTEGER, 60_000)).toBe(true);
    });

    it("is stale once expiresAtMs is at or before now", () => {
        expect(capabilityFreshAt(cap(1000), 2000)).toBe(false);
        expect(capabilityFreshAt(cap(1000), 1000)).toBe(false);
    });

    it("is fresh while expiresAtMs is strictly after now (zero margin)", () => {
        expect(capabilityFreshAt(cap(2000), 1000)).toBe(true);
    });

    it("treats a cap expiring within the margin as stale", () => {
        // expiresAtMs (1500) <= now (1000) + margin (1000) → stale.
        expect(capabilityFreshAt(cap(1500), 1000, 1000)).toBe(false);
    });

    it("treats a cap expiring exactly at now+margin as stale (boundary)", () => {
        expect(capabilityFreshAt(cap(2000), 1000, 1000)).toBe(false);
    });

    it("is fresh when expiry is beyond now+margin", () => {
        expect(capabilityFreshAt(cap(5000), 1000, 1000)).toBe(true);
    });
});

describe("capBagFreshAt", () => {
    function cap(expiresAtMs?: number): Capability {
        return {
            issuer: "iss" as PrincipalId,
            audience: "aud" as PrincipalId,
            permissions: [fullAccess],
            nonce: "n",
            ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
        };
    }

    it("is trivially fresh for an empty bag", () => {
        expect(capBagFreshAt([], 0)).toBe(true);
    });

    it("is fresh only when every link is fresh", () => {
        expect(capBagFreshAt([cap(), cap(5000)], 1000)).toBe(true);
    });

    it("is stale if ANY link is stale (chain intersection)", () => {
        expect(capBagFreshAt([cap(5000), cap(1500)], 1000, 1000)).toBe(false);
    });
});
