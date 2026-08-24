import { describe, expect, it } from "vitest";
import { KeypairSigningIdentity } from "./identity";
import {
    permits,
    signCapability,
    type CallTarget,
    type Permission,
} from "./capability";
import { signParams, verifyCall } from "./metaEnvelope";
import { methodNameToTarget } from "../protocol/methodName";

const NOW = 1_000_000; // Unix ms baseline used throughout.

const fullAccess: Permission = {
    target: { serviceId: { prefix: "" }, interfaceId: { prefix: "" }, members: [{ prefix: "" }] },
    canInvoke: true,
};

/** Demo: `serviceId::interfaceId::member`. */
function parseMethod(method: string): CallTarget {
    return methodNameToTarget(method);
}

async function setup() {
    const admin = await KeypairSigningIdentity.generateNew();
    const caller = await KeypairSigningIdentity.generateNew();
    return {
        admin,
        caller,
        adminId: admin.publicSigningIdentity.principal,
        callerId: caller.publicSigningIdentity.principal,
    };
}

// ---- authenticity (verifyCall) -----------------------------------------

describe("signParams / verifyCall (authenticity)", () => {
    it("injects $hubrpc envelope into params and verifies round-trip", async () => {
        const s = await setup();
        const params = await signParams({
            method: "github::linkrpc.directory::list",
            params: { foo: 1 },
            signingIdentity: s.caller,
            nowMs: NOW,
        });
        const signed = (params as { $hubrpc?: { principal: string; nonce: string; signedAtMs: number } }).$hubrpc;
        const signature = (params as { $linkrpcSignature?: { call?: { keyId: string; sig: string } } }).$linkrpcSignature;
        expect(signed).toBeDefined();
        expect(signature).toBeDefined();
        expect(typeof signature?.call?.sig).toBe("string");
        expect(typeof signature?.call?.keyId).toBe("string");
        expect(typeof signed?.nonce).toBe("string");
        expect(signed?.signedAtMs).toBe(NOW);
        expect(signed?.principal).toBe(s.callerId);

        const r = await verifyCall({
            method: "github::linkrpc.directory::list",
            params, parseMethod, nowMs: NOW,
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.signer).toBe(s.callerId);
            expect(r.call.signer).toBe(s.callerId);
            expect(r.call.target).toEqual({ serviceId: "github", interfaceId: "linkrpc.directory", member: "list" });
            expect(r.strippedParams).toEqual({ foo: 1 });
            expect(r.capabilities).toEqual([]);
        }
    });

    it("returns empty strippedParams when only $hubrpc envelope was present", async () => {
        const s = await setup();
        const params = await signParams({
            method: "x::y::z", params: undefined,
            signingIdentity: s.caller, nowMs: NOW,
        });
        const r = await verifyCall({
            method: "x::y::z", params, parseMethod, nowMs: NOW,
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.strippedParams).toEqual({});
    });

    it("rejects tampered signature", async () => {
        const s = await setup();
        const params = await signParams({
            method: "x::y::z", params: { a: 1 },
            signingIdentity: s.caller, nowMs: NOW,
        });
        const u = (params as { $linkrpcSignature: { call: { keyId: string; sig: string } } }).$linkrpcSignature;
        const tampered = {
            ...params,
            $linkrpcSignature: { ...u, call: { ...u.call, sig: u.call.sig.slice(0, -4) + "AAAA" } },
        };
        const r = await verifyCall({
            method: "x::y::z", params: tampered, parseMethod, nowMs: NOW,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("bad signature");
    });

    it("rejects tampered method", async () => {
        const s = await setup();
        const params = await signParams({
            method: "x::y::z", params: { a: 1 },
            signingIdentity: s.caller, nowMs: NOW,
        });
        const r = await verifyCall({
            method: "x::y::other", params, parseMethod, nowMs: NOW,
        });
        expect(r.ok).toBe(false);
        // The signed `$hubrpc.method` no longer matches the wire method.
        if (!r.ok) expect(r.reason).toBe("method mismatch");
    });

    it("rejects ts skew beyond window", async () => {
        const s = await setup();
        const params = await signParams({
            method: "x::y::z", params: {},
            signingIdentity: s.caller, nowMs: NOW,
        });
        const r = await verifyCall({
            method: "x::y::z", params, parseMethod,
            nowMs: NOW + 400_000, maxSkewMs: 300_000,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/timestamp skew/);
    });

    it("rejects a call with no $hubrpc envelope (verifyCall always requires a signature)", async () => {
        const r = await verifyCall({
            method: "x::y::z", params: { a: 1 },
            parseMethod, nowMs: NOW,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/identity envelope/);
    });

    it("rejects when requireCapability and no signed envelope", async () => {
        const r = await verifyCall({
            method: "x::y::z", params: { a: 1 },
            parseMethod, nowMs: NOW, requireCapability: true,
        });
        expect(r.ok).toBe(false);
    });

    it("rejects when requireCapability and capabilities empty", async () => {
        const s = await setup();
        const params = await signParams({
            method: "x::y::z", params: {},
            signingIdentity: s.caller, nowMs: NOW,
        });
        const r = await verifyCall({
            method: "x::y::z", params, parseMethod,
            nowMs: NOW, requireCapability: true,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("capability required but none provided");
    });
});

// ---- authorization (verifyCall + permits) -------------------------------

describe("verifyCall + permits (authorization)", () => {
    it("permits a call a capability addresses, rooted at an accepted issuer", async () => {
        const s = await setup();
        const cap = await signCapability({
            issuer: s.adminId, audience: s.callerId, nonce: "c1", permissions: [fullAccess],
        }, s.admin);

        const params = await signParams({
            method: "github::linkrpc.directory::list", params: {},
            signingIdentity: s.caller, nowMs: NOW, capabilities: [cap],
        });

        const r = await verifyCall({
            method: "github::linkrpc.directory::list",
            params, parseMethod, nowMs: NOW, requireCapability: true,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const p = await permits(r.call, r.capabilities, () => [{ principal: s.adminId, isPublic: true }], NOW);
        expect(p.ok).toBe(true);
        if (p.ok) expect(p.rootIssuer).toBe(s.adminId);
    });

    it("denies when no capability addresses the call", async () => {
        const s = await setup();
        const cap = await signCapability({
            issuer: s.adminId, audience: s.callerId, nonce: "c1",
            permissions: [{
                target: { serviceId: { prefix: "github" }, interfaceId: { prefix: "" }, members: [{ prefix: "" }] },
                canInvoke: true,
            }],
        }, s.admin);

        const params = await signParams({
            method: "gitlab::x.y::m", params: {},
            signingIdentity: s.caller, nowMs: NOW, capabilities: [cap],
        });

        const r = await verifyCall({
            method: "gitlab::x.y::m", params, parseMethod, nowMs: NOW, requireCapability: true,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const p = await permits(r.call, r.capabilities, () => [{ principal: s.adminId, isPublic: true }], NOW);
        expect(p.ok).toBe(false);
    });

    it("interfaceHash on the permission enforces schema-version binding", async () => {
        const s = await setup();
        const cap = await signCapability({
            issuer: s.adminId, audience: s.callerId, nonce: "h1",
            permissions: [{
                target: {
                    serviceId: { prefix: "" },
                    interfaceId: { exact: "github.issues" },
                    interfaceHash: "v1",
                    members: [{ exact: "list" }],
                },
                canInvoke: true,
            }],
        }, s.admin);

        async function tryHash(hash: string | undefined): Promise<boolean> {
            const params = await signParams({
                method: "github::github.issues::list", params: {},
                signingIdentity: s.caller, nowMs: NOW, capabilities: [cap],
                ...(hash !== undefined ? { interfaceHash: hash } : {}),
            });
            const r = await verifyCall({
                method: "github::github.issues::list",
                params, parseMethod, nowMs: NOW, requireCapability: true,
            });
            if (!r.ok) return false;
            const p = await permits(r.call, r.capabilities, () => [{ principal: s.adminId, isPublic: true }], NOW);
            return p.ok;
        }

        expect(await tryHash("v1")).toBe(true);
        expect(await tryHash("v2")).toBe(false);
        expect(await tryHash(undefined)).toBe(false);
    });

    it("permission without interfaceHash matches any asserted hash (or none)", async () => {
        const s = await setup();
        const cap = await signCapability({
            issuer: s.adminId, audience: s.callerId, nonce: "h2",
            permissions: [{
                target: { serviceId: { prefix: "" }, interfaceId: { exact: "github.issues" }, members: [{ exact: "list" }] },
                canInvoke: true,
            }],
        }, s.admin);

        for (const hash of [undefined, "anything", "v1"]) {
            const params = await signParams({
                method: "github::github.issues::list", params: {},
                signingIdentity: s.caller, nowMs: NOW, capabilities: [cap],
                ...(hash !== undefined ? { interfaceHash: hash } : {}),
            });
            const r = await verifyCall({
                method: "github::github.issues::list",
                params, parseMethod, nowMs: NOW, requireCapability: true,
            });
            expect(r.ok).toBe(true);
            if (!r.ok) continue;
            const p = await permits(r.call, r.capabilities, () => [{ principal: s.adminId, isPublic: true }], NOW);
            expect(p.ok).toBe(true);
        }
    });

    it("members[] any-of: a permission with multiple members matches each", async () => {
        const s = await setup();
        const cap = await signCapability({
            issuer: s.adminId, audience: s.callerId, nonce: "m1",
            permissions: [{
                target: {
                    serviceId: { prefix: "" },
                    interfaceId: { exact: "github.issues" },
                    members: [{ exact: "list" }, { exact: "get" }, { exact: "listComments" }],
                },
                canInvoke: true,
            }],
        }, s.admin);

        async function tryMember(m: string): Promise<boolean> {
            const params = await signParams({
                method: `github::github.issues::${m}`, params: {},
                signingIdentity: s.caller, nowMs: NOW, capabilities: [cap],
            });
            const r = await verifyCall({
                method: `github::github.issues::${m}`,
                params, parseMethod, nowMs: NOW, requireCapability: true,
            });
            if (!r.ok) return false;
            const p = await permits(r.call, r.capabilities, () => [{ principal: s.adminId, isPublic: true }], NOW);
            return p.ok;
        }

        expect(await tryMember("list")).toBe(true);
        expect(await tryMember("get")).toBe(true);
        expect(await tryMember("listComments")).toBe(true);
        expect(await tryMember("update")).toBe(false);
    });
});
