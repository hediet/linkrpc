import { describe, expect, it, vi } from "vitest";
import {
    CapabilityIssuanceError, getDelegationRootIds, prepareCapabilityIssuance, issueCapabilities, issueCapability,
    permits, signedHash, type Call, type Permission,
} from "../index";
import { KeypairSigningIdentity } from "./identity";

const scope: Permission = {
    target: {
        serviceId: { prefix: "files" },
        interfaceId: { prefix: "example" },
        members: [{ prefix: "read" }],
    },
    canDelegate: true,
};
const request: Permission = {
    target: {
        serviceId: { exact: "files/docs" },
        interfaceId: { exact: "example.fs" },
        members: [{ exact: "readText" }],
    },
    canInvoke: true,
};

async function setup() {
    const [root, delegate, consumer] = await Promise.all(Array.from({ length: 3 }, () => KeypairSigningIdentity.generateNew()));
    const parent = await issueCapability(root, { audience: delegate.publicSigningIdentity, permissions: [scope] });
    const options = {
        audience: consumer.publicSigningIdentity.principal,
        permissions: [request],
        capabilities: [parent],
        acceptableRootIds: [root.publicSigningIdentity.principal],
    };
    const call: Call = {
        target: { serviceId: "files/docs", interfaceId: "example.fs", member: "readText" },
        signer: consumer.publicSigningIdentity.principal,
        params: {}, nonce: "call", signedAtMs: Date.now(), callHash: "",
    };
    const roots = () => [{ principal: root.publicSigningIdentity.principal, isPublic: false }];
    return { root, delegate, consumer, parent, options, call, roots };
}

describe("issueCapabilities", () => {
    it("uses accepted self-root authority with no caps or expired unrelated caps", async () => {
        const { root, delegate, consumer, options, call, roots } = await setup();
        const expired = await issueCapability(delegate, {
            audience: root.publicSigningIdentity, permissions: [scope], expiresAtMs: 1,
        });
        for (const capabilities of [[], [expired]]) {
            const caps = await issueCapabilities(root, { ...options, capabilities, audience: consumer.publicSigningIdentity });
            expect(caps).toHaveLength(1);
            expect(caps[0].parentHash).toBeUndefined();
            expect((await permits(call, caps, roots, Date.now())).ok).toBe(true);
        }
    });

    it("delegates scoped delegate-only authority and returns the complete chain", async () => {
        const { delegate, parent, options, call, roots } = await setup();
        const caps = await issueCapabilities(delegate, options);
        expect(caps).toHaveLength(2);
        expect(caps[0].parentHash).toBe(signedHash("capability", parent));
        expect(caps[1]).toEqual(parent);
        expect((await permits(call, caps, roots, Date.now())).ok).toBe(true);
        expect((await permits(call, [caps[0]], roots, Date.now())).ok).toBe(false);
        expect((await permits({ ...call, target: { ...call.target, member: "writeText" } }, caps, roots, Date.now())).ok).toBe(false);
    });

    describe("capability issuance preparation", () => {
        it("previews effective authority without signing and preserves its snapshot", async () => {
            const { root, delegate, options, call, roots } = await setup();
            const expiresAtMs = Date.now() + 60_000;
            const parent = await issueCapability(root, {
                audience: delegate.publicSigningIdentity, permissions: [scope], expiresAtMs,
            });
            const requested = structuredClone([request]);
            const sign = vi.spyOn(delegate, "sign");
            const plan = await prepareCapabilityIssuance(delegate, {
                ...options, permissions: requested, capabilities: [parent], expiresAtMs: expiresAtMs + 60_000,
            });
            expect(sign).not.toHaveBeenCalled();
            expect(plan.audience).toBe(call.signer);
            expect(plan.proposals).toEqual([{
                permissions: [request], rootIssuer: root.publicSigningIdentity.principal,
                expiresAtMs, parentHash: signedHash("capability", parent),
            }]);
            parent.nonce = "changed-after-preview";
            requested[0].target.serviceId = { exact: "changed-after-preview" };
            plan.proposals[0].permissions[0].target.serviceId = { exact: "changed-proposal" };
            const caps = await plan.issue();
            expect(sign).toHaveBeenCalledTimes(1);
            expect(caps[0].expiresAtMs).toBe(expiresAtMs);
            expect((await permits(call, caps, roots, Date.now())).ok).toBe(true);
        });

        it("does not mint on preview or switch authority after the selected chain expires", async () => {
            const { root, delegate, options } = await setup();
            const now = Date.now();
            const old = await issueCapability(root, {
                audience: delegate.publicSigningIdentity, permissions: [scope], expiresAtMs: now + 10_000,
            });
            const bag = [old];
            const sign = vi.spyOn(delegate, "sign");
            const clock = vi.spyOn(Date, "now").mockReturnValue(now);
            try {
                const plan = await prepareCapabilityIssuance(delegate, { ...options, capabilities: bag });
                bag.push(await issueCapability(root, { audience: delegate.publicSigningIdentity, permissions: [scope] }));
                clock.mockReturnValue(now + 10_001);
                await expect(plan.issue()).rejects.toThrow(/expired/);
                expect(sign).not.toHaveBeenCalled();
            } finally {
                clock.mockRestore();
            }
        });

        it("previews self-root authority without invoking its signer", async () => {
            const { root, options } = await setup();
            const sign = vi.spyOn(root, "sign");
            const plan = await prepareCapabilityIssuance(root, options);
            expect(sign).not.toHaveBeenCalled();
            expect(plan.proposals[0].rootIssuer).toBe(root.publicSigningIdentity.principal);
            expect(plan.proposals[0].parentHash).toBeUndefined();
            expect(await plan.issue()).toHaveLength(1);
            expect(sign).toHaveBeenCalledTimes(1);
        });

        it("discovers only authenticated, fresh, complete delegation roots without signing", async () => {
            const { root, delegate, parent } = await setup();
            const otherRoot = await KeypairSigningIdentity.generateNew();
            const middle = await KeypairSigningIdentity.generateNew();
            const ancestor = await issueCapability(otherRoot, { audience: middle.publicSigningIdentity, permissions: [scope] });
            const middleCap = await issueCapability(middle, { audience: delegate.publicSigningIdentity, permissions: [scope], parent: ancestor });
            const expired = await issueCapability(otherRoot, {
                audience: delegate.publicSigningIdentity, permissions: [scope], expiresAtMs: 1,
            });
            const invokeOnly = await issueCapability(otherRoot, {
                audience: delegate.publicSigningIdentity, permissions: [{ ...scope, canInvoke: true, canDelegate: false }],
            });
            const sign = vi.spyOn(delegate, "sign");
            expect(await getDelegationRootIds(delegate, [parent, middleCap, ancestor])).toEqual([
                root.publicSigningIdentity.principal, otherRoot.publicSigningIdentity.principal,
            ]);
            expect(await getDelegationRootIds(delegate, [middleCap, expired, invokeOnly, { ...parent, nonce: "tampered" }])).toEqual([]);
            expect(await getDelegationRootIds(root, [])).toEqual([]);
            expect(sign).not.toHaveBeenCalled();
        });
    });

    it("validates multi-hop authority and clamps expiration to the earliest ancestor", async () => {
        const { root, delegate, consumer, options, call, roots } = await setup();
        const middle = await KeypairSigningIdentity.generateNew();
        const expiresAtMs = Date.now() + 60_000;
        const first = await issueCapability(root, { audience: middle.publicSigningIdentity, permissions: [scope], expiresAtMs });
        const second = await issueCapability(middle, { audience: delegate.publicSigningIdentity, permissions: [scope], parent: first });
        const caps = await issueCapabilities(delegate, {
            ...options, audience: consumer.publicSigningIdentity,
            capabilities: [second, first], expiresAtMs: expiresAtMs + 60_000,
        });
        expect(caps).toHaveLength(3);
        expect(caps[0].expiresAtMs).toBe(expiresAtMs);
        expect((await permits(call, caps, roots, Date.now())).ok).toBe(true);
        expect((await permits(call, caps, roots, expiresAtMs + 1)).ok).toBe(false);
    });

    it("chooses usable delegated authority before self-root fallback when roots are unknown", async () => {
        const { delegate, parent, options } = await setup();
        expect((await issueCapabilities(delegate, { ...options, acceptableRootIds: undefined }))[0].parentHash)
            .toBe(signedHash("capability", parent));
        expect((await issueCapabilities(delegate, { ...options, capabilities: [], acceptableRootIds: undefined }))[0].parentHash)
            .toBeUndefined();
    });

    it("can combine independent accepted roots without including irrelevant caps", async () => {
        const { root, delegate, consumer, parent, options, call } = await setup();
        const otherRoot = await KeypairSigningIdentity.generateNew();
        const otherPermission = { ...request, target: { ...request.target, serviceId: { exact: "other" } } };
        const other = await issueCapability(otherRoot, {
            audience: delegate.publicSigningIdentity,
            permissions: [{ ...otherPermission, canDelegate: true }],
        });
        const caps = await issueCapabilities(delegate, {
            ...options, audience: consumer.publicSigningIdentity,
            permissions: [request, otherPermission],
            capabilities: [parent, other],
            acceptableRootIds: [root.publicSigningIdentity.principal, otherRoot.publicSigningIdentity.principal],
        });
        expect(caps).toHaveLength(4);
        const roots = () => [root, otherRoot].map(id => ({ principal: id.publicSigningIdentity.principal, isPublic: false }));
        expect((await permits(call, caps, roots, Date.now())).ok).toBe(true);
        expect((await permits({ ...call, target: { ...call.target, serviceId: "other" } }, caps, roots, Date.now())).ok).toBe(true);
    });

    it.each(["expired", "tampered", "audience", "invoke-only", "missing-parent", "ancestor-scope", "unaccepted"] as const)(
        "rejects %s delegated chains", async kind => {
            const { root, delegate, consumer, parent, options } = await setup();
            let capabilities = [parent];
            if (kind === "expired") capabilities = [await issueCapability(root, {
                audience: delegate.publicSigningIdentity, permissions: [scope], expiresAtMs: 1,
            })];
            if (kind === "tampered") capabilities = [{ ...parent, nonce: "tampered" }];
            if (kind === "audience") capabilities = [await issueCapability(root, {
                audience: consumer.publicSigningIdentity, permissions: [scope],
            })];
            if (kind === "invoke-only") capabilities = [await issueCapability(root, {
                audience: delegate.publicSigningIdentity, permissions: [{ ...scope, canDelegate: false, canInvoke: true }],
            })];
            if (kind === "missing-parent" || kind === "ancestor-scope") {
                const middle = await KeypairSigningIdentity.generateNew();
                const first = await issueCapability(root, {
                    audience: middle.publicSigningIdentity,
                    permissions: [{ ...scope, target: { ...scope.target, members: [{ exact: "other" }] } }],
                });
                const second = await issueCapability(middle, { audience: delegate.publicSigningIdentity, permissions: [scope], parent: first });
                capabilities = kind === "missing-parent" ? [second] : [first, second];
            }
            await expect(issueCapabilities(delegate, {
                ...options, capabilities,
                ...(kind === "unaccepted" ? { acceptableRootIds: [] } : {}),
            })).rejects.toThrow(/Insufficient delegation authority/);
        },
    );

    it.each([
        { serviceId: { prefix: "" } },
        { serviceId: { exact: "filesClone" } },
        { interfaceId: { exact: "exampleClone" } },
        { members: [{ prefix: "" }] },
    ])("rejects out-of-scope target %j rather than issuing a partially usable cap", async target => {
        const { delegate, options } = await setup();
        await expect(issueCapabilities(delegate, {
            ...options, permissions: [{ ...request, target: { ...request.target, ...target } }],
        })).rejects.toThrow(/Insufficient delegation authority/);
    });

    it("narrows parameter prefix, enum and subset matchers with exact key sets", async () => {
        const { root, delegate, options, call, roots } = await setup();
        const parent = await issueCapability(root, {
            audience: delegate.publicSigningIdentity,
            permissions: [{ ...scope, params: {
                path: { prefix: "/docs/" }, mode: { enum: ["text", "json"] }, tags: { subsetOf: ["a", "b"] },
            } }],
        });
        const permissions = [{ ...request, params: {
            path: { prefix: "/docs/public/" }, mode: { exact: "text" }, tags: { subsetOf: ["a"] },
        } }] satisfies Permission[];
        const caps = await issueCapabilities(delegate, { ...options, capabilities: [parent], permissions });
        const permitted = { ...call, params: { path: "/docs/public/readme", mode: "text", tags: ["a"] } };
        expect((await permits(permitted, caps, roots, Date.now())).ok).toBe(true);
        expect((await permits({ ...permitted, params: { ...permitted.params, tags: ["b"] } }, caps, roots, Date.now())).ok).toBe(false);
        for (const params of [undefined, { path: { prefix: "/" } }, {
            path: { prefix: "/docs/public/" }, mode: { any: true }, tags: { subsetOf: ["a"] },
        }] as (Permission["params"])[]) {
            await expect(issueCapabilities(delegate, {
                ...options, capabilities: [parent], permissions: [{ ...request, params }],
            })).rejects.toThrow(/Insufficient delegation authority/);
        }
    });

    it("enforces schema hash and call bindings", async () => {
        const { root, delegate, options } = await setup();
        const binding = { alg: "sha256", payloadHash: "one-call" } as const;
        const parent = await issueCapability(root, {
            audience: delegate.publicSigningIdentity,
            permissions: [{ ...scope, target: { ...scope.target, interfaceHash: "v1" }, callBind: binding }],
        });
        await expect(issueCapabilities(delegate, { ...options, capabilities: [parent] })).rejects.toThrow(/Insufficient/);
        const caps = await issueCapabilities(delegate, {
            ...options, capabilities: [parent],
            permissions: [{ ...request, target: { ...request.target, interfaceHash: "v1" }, callBind: binding }],
        });
        expect(caps).toHaveLength(2);
    });

    it("rejects expired requested lifetimes and empty authority", async () => {
        const { root, options } = await setup();
        for (const expiresAtMs of [1, NaN, Infinity]) {
            await expect(issueCapabilities(root, { ...options, expiresAtMs })).rejects.toThrow(/expiration/);
        }
        await expect(issueCapabilities(root, { ...options, permissions: [] })).rejects.toThrow(/permission/);
    });

    it("distinguishes expected insufficient authority from invalid requests and signer failures", async () => {
        const { delegate, root, options } = await setup();
        await expect(issueCapabilities(delegate, { ...options, capabilities: [] }))
            .rejects.toMatchObject({ name: "CapabilityIssuanceError", code: "insufficientAuthority" });
        await expect(issueCapabilities(delegate, { ...options, capabilities: [] }))
            .rejects.toBeInstanceOf(CapabilityIssuanceError);
        await expect(issueCapabilities(root, { ...options, permissions: [] }))
            .rejects.not.toBeInstanceOf(CapabilityIssuanceError);
        const failure = new Error("signer unavailable");
        vi.spyOn(root, "sign").mockRejectedValue(failure);
        await expect(issueCapabilities(root, options)).rejects.toBe(failure);
    });
});
