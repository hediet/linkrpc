import { describe, it, expect } from "vitest";
import { sha256 } from "./sha256";

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();

describe("sha256", () => {
    it("matches the empty-string vector", () => {
        expect(hex(sha256(new Uint8Array(0)))).toBe(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    });

    it("matches the FIPS 180-2 short vector 'abc'", () => {
        expect(hex(sha256(enc.encode("abc")))).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    });

    it("matches the FIPS 180-2 long vector (448-bit message)", () => {
        const msg = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
        expect(hex(sha256(enc.encode(msg)))).toBe(
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        );
    });

    it("handles a 1MiB input correctly (multi-block path)", () => {
        // Known digest for 1,000,000 'a' bytes — RFC 6234 §A.4 vector 3.
        const buf = new Uint8Array(1_000_000).fill(0x61);
        expect(hex(sha256(buf))).toBe(
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
        );
    });

    it("produces a 32-byte Uint8Array", () => {
        const out = sha256(enc.encode("anything"));
        expect(out).toBeInstanceOf(Uint8Array);
        expect(out.length).toBe(32);
    });
});
