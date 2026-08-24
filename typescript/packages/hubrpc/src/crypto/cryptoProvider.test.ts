import { describe, it, expect } from "vitest";
import {
    base64UrlToBytes,
    bytesToBase64Url,
    keyIdForPublicKey,
    principalForPublicKey,
    publicKeyForKeyId,
    keyIdForPrincipal,
} from "./cryptoProvider";

describe("base64url codec", () => {
    it("round-trips arbitrary byte sequences (length 0..16)", () => {
        for (let len = 0; len <= 16; len++) {
            const src = new Uint8Array(len);
            for (let i = 0; i < len; i++) src[i] = (i * 37 + 11) & 0xff;
            const enc = bytesToBase64Url(src);
            const dec = base64UrlToBytes(enc);
            expect(dec).toEqual(src);
            expect(enc).not.toMatch(/[=+/]/);
        }
    });

    it("uses url-safe alphabet (no '+' or '/')", () => {
        const bytes = new Uint8Array([0xff, 0xff, 0xff]);
        const enc = bytesToBase64Url(bytes);
        expect(enc).toBe("____");
    });

    it("encodes a 32-byte key to 43 chars (no padding)", () => {
        const key = new Uint8Array(32).fill(0x42);
        expect(bytesToBase64Url(key)).toHaveLength(43);
    });

    it("rejects invalid characters and lengths", () => {
        expect(() => base64UrlToBytes("a")).toThrow(/invalid length/);
        expect(() => base64UrlToBytes("a*aa")).toThrow(/invalid char/);
    });

    it("publicKey ↔ keyId ↔ principal round-trips", () => {
        const pk = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
        const keyId = keyIdForPublicKey(pk);
        expect(publicKeyForKeyId(keyId)).toEqual(pk);
        const principal = principalForPublicKey(pk);
        expect(keyIdForPrincipal(principal)).toBe(keyId);
    });
});
