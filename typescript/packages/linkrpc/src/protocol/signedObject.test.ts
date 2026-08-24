import { describe, expect, it } from "vitest";
import { signingDomainValue, signingInput } from "./signedObject";

const decoder = new TextDecoder();

describe("signingInput", () => {
    it("frames the version and domain as a JCS object key", () => {
        expect(signingDomainValue("call")).toBe("linkrpc-sig/v1/call");
        expect(decoder.decode(signingInput("call", { b: 2, a: 1 })))
            .toBe('{"linkrpc-sig/v1/call":{"a":1,"b":2}}');
    });

    it("strips reserved keys before wrapping the signed object", () => {
        const input = signingInput("capability", {
            issuer: "id:key:test",
            $linkrpcSignature: { capability: { keyId: "key:test", sig: "ignored" } },
            $linkrpcUnsigned: { attachment: true },
        });

        expect(decoder.decode(input))
            .toBe('{"linkrpc-sig/v1/capability":{"issuer":"id:key:test"}}');
    });
});
