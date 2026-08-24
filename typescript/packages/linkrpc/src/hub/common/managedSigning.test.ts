import { describe, expect, it, vi } from "vitest";
import {
    createMemoryPrincipal,
    type IRequestSender,
    type JsonValue,
    type SigningCallCtx,
    type SignedCapability,
} from "../../index";
import { createAutoNegotiatingCapProvider } from "./managedSigning";

describe("createAutoNegotiatingCapProvider", () => {
    it("reuses a hash-pinned prefix capability", async () => {
        const principal = await createMemoryPrincipal();
        const capability: SignedCapability = {
            issuer: "id:key:issuer",
            audience: principal.id,
            nonce: "cap",
            permissions: [{
                target: {
                    serviceId: { prefix: "embedded/parent/child" },
                    interfaceId: { exact: "sample.child" },
                    interfaceHash: "schema-hash",
                    members: [{ exact: "invoke" }],
                },
                canInvoke: true,
            }],
            $linkrpcSignature: {},
        };
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
});
