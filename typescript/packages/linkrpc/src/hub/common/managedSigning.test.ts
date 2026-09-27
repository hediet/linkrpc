import { describe, expect, it, vi } from "vitest";
import {
    createMemoryPrincipal,
    issueCapability,
    KeypairSigningIdentity,
    type IRequestSender,
    type JsonValue,
    type SigningCallCtx,
} from "../../index";
import { createAutoNegotiatingCapProvider } from "./managedSigning";

describe("createAutoNegotiatingCapProvider", () => {
    it("reuses a hash-pinned prefix capability", async () => {
        const principal = await createMemoryPrincipal();
        const issuer = await KeypairSigningIdentity.generateNew();
        const capability = await issueCapability(issuer, {
            audience: principal.identity.publicSigningIdentity,
            permissions: [{
                target: {
                    serviceId: { prefix: "embedded/parent/child" },
                    interfaceId: { exact: "sample.child" },
                    interfaceHash: "schema-hash",
                    members: [{ exact: "invoke" }],
                },
                canInvoke: true,
            }],
        });
        await principal.capBag.add(capability);

        const sendRequest = vi.fn(async (): Promise<JsonValue> => {
            throw new Error("existing capability should avoid access negotiation");
        });
        const sender: IRequestSender<SigningCallCtx> = {
            sendRequest,
            sendNotification: async () => { },
            sendRequestWithStream: () => {
                throw new Error("not used");
            },
            close: () => { },
        };
        const provider = createAutoNegotiatingCapProvider({
            sender,
            principal,
            consumer: { name: "test" },
        });

        const result = await provider({
            method: "embedded/parent/child/instance::sample.child::invoke",
            params: {},
            signer: principal.id,
            nonce: "call",
            signedAtMs: Date.now(),
            interfaceHash: "schema-hash",
        });

        expect(sendRequest).not.toHaveBeenCalled();
        expect(result.capabilities).toContain(capability);
    });

    it.each(["complete", "missing-parent", "wrong-audience", "delegate-only", "expired-parent"] as const)(
        "handles %s delegated cached authority", async kind => {
            const principal = await createMemoryPrincipal();
            const root = await KeypairSigningIdentity.generateNew();
            const delegate = await KeypairSigningIdentity.generateNew();
            const target = {
                serviceId: { exact: "files" }, interfaceId: { exact: "fs" }, members: [{ exact: "read" }],
            };
            const parent = await issueCapability(root, {
                audience: delegate.publicSigningIdentity,
                permissions: [{ target, canDelegate: true }],
                ...(kind === "expired-parent" ? { expiresAtMs: 1 } : {}),
            });
            const leaf = await issueCapability(delegate, {
                audience: kind === "wrong-audience" ? root.publicSigningIdentity : principal.identity.publicSigningIdentity,
                permissions: [{ target, canInvoke: kind !== "delegate-only", canDelegate: true }],
                parent,
            });
            await principal.capBag.add(...(kind === "missing-parent" ? [leaf] : [parent, leaf]));
            const sendRequest = vi.fn(async (): Promise<JsonValue> => ({ status: "denied" }));
            const provider = createAutoNegotiatingCapProvider({
                principal, consumer: { name: "test" },
                sender: {
                    sendRequest, sendNotification: async () => {},
                    sendRequestWithStream: () => { throw new Error("not used"); }, close: () => {},
                },
            });
            const result = await provider({
                method: "files::fs::read", params: {}, signer: principal.id, nonce: "call", signedAtMs: Date.now(),
            });
            expect(sendRequest).toHaveBeenCalledTimes(kind === "complete" ? 0 : 1);
            if (kind === "complete") expect(result.capabilities).toEqual([parent, leaf]);
        },
    );
});
