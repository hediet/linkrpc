/**
 * Pure-JS SHA-256 (RFC 6234 / FIPS 180-4). Synchronous, dependency-free,
 * isomorphic. Used internally by hubrpc for content-hashing interface
 * schemas and deriving identity slot names; also surfaced through the
 * `crypto` API as `crypto.sha256`. For signature work we go through the
 * `crypto` module (`./identity/crypto`).
 *
 * Replaces the previous `@noble/hashes/sha2` import so the bundle has
 * no runtime npm dependencies. Trades the well-vetted dep for ~80 lines
 * of straight-line code that has no branching on input contents and is
 * exercised by the existing test vectors plus `sha256.test.ts`.
 */

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function _rotr(x: number, n: number): number {
    return (x >>> n) | (x << (32 - n));
}

export function sha256(data: Uint8Array): Uint8Array {
    const inputLen = data.length;
    const bitLen = inputLen * 8;
    // Round up to next 64-byte block leaving room for 0x80 marker + 8-byte length.
    const paddedLen = (inputLen + 9 + 63) & ~63;
    const padded = new Uint8Array(paddedLen);
    padded.set(data);
    padded[inputLen] = 0x80;

    const view = new DataView(padded.buffer);
    // Big-endian 64-bit bit length. Bottom 32 bits hold values < 2^32 bits = 2^29 bytes (~512 MiB).
    view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x1_0000_0000), false);
    view.setUint32(paddedLen - 4, bitLen >>> 0, false);

    const H = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const W = new Uint32Array(64);

    for (let block = 0; block < paddedLen; block += 64) {
        for (let t = 0; t < 16; t++) {
            W[t] = view.getUint32(block + t * 4, false);
        }
        for (let t = 16; t < 64; t++) {
            const w15 = W[t - 15];
            const w2 = W[t - 2];
            const s0 = _rotr(w15, 7) ^ _rotr(w15, 18) ^ (w15 >>> 3);
            const s1 = _rotr(w2, 17) ^ _rotr(w2, 19) ^ (w2 >>> 10);
            W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
        }

        let a = H[0], b = H[1], c = H[2], d = H[3];
        let e = H[4], f = H[5], g = H[6], h = H[7];
        for (let t = 0; t < 64; t++) {
            const S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
            const S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
            const mj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + mj) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0;
        H[1] = (H[1] + b) >>> 0;
        H[2] = (H[2] + c) >>> 0;
        H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0;
        H[5] = (H[5] + f) >>> 0;
        H[6] = (H[6] + g) >>> 0;
        H[7] = (H[7] + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false);
    return out;
}
