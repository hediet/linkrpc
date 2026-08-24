/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Used as the byte-deterministic encoding under every hubrpc signature
 * (RPC calls, capabilities, hub-signed previews). Both signer and verifier
 * canonicalize the same value object and obtain byte-identical UTF-8 bytes.
 *
 * Implementation inlined from the `canonicalize` npm package (Apache-2.0,
 * https://github.com/erdtman/canonicalize) so this module stays
 * zero-dependency for browser bundlers that don't resolve transitive
 * npm specifiers (e.g. the in-house app-bundler).
 */


/** RFC 8785 canonical JSON string for `value`. */
export function jcsCanonicalize(value: unknown): string {
    const out = _canonicalize(value);
    if (out === undefined) {
        throw new Error("jcsCanonicalize: value is not JSON-representable");
    }
    return out;
}

const _encoder = new TextEncoder();

/** UTF-8 bytes of the RFC 8785 canonical JSON for `value`. The thing actually signed / hashed. */
export function jcsCanonicalizeBytes(value: unknown): Uint8Array {
    return _encoder.encode(jcsCanonicalize(value));
}

function _canonicalize(object: unknown, seen: Set<object> = new Set()): string | undefined {
    if (typeof object === "number" && Number.isNaN(object)) {
        throw new Error("NaN is not allowed");
    }
    if (typeof object === "number" && !Number.isFinite(object)) {
        throw new Error("Infinity is not allowed");
    }
    if (object === null || typeof object !== "object") {
        return JSON.stringify(object);
    }

    const obj = object as { toJSON?: () => unknown } & Record<string, unknown>;

    if (typeof obj.toJSON === "function") {
        if (seen.has(obj)) throw new Error("Circular reference detected");
        seen.add(obj);
        const result = _canonicalize(obj.toJSON(), seen);
        seen.delete(obj);
        return result;
    }

    if (seen.has(obj)) throw new Error("Circular reference detected");
    seen.add(obj);

    let result: string;
    if (Array.isArray(obj)) {
        const values = obj.map((cv) => {
            const value = cv === undefined || typeof cv === "symbol" ? null : cv;
            return _canonicalize(value, seen);
        });
        result = `[${values.join(",")}]`;
    } else {
        const parts: string[] = [];
        for (const key of Object.keys(obj).sort()) {
            const v = obj[key];
            if (v === undefined || typeof v === "symbol") continue;
            parts.push(`${JSON.stringify(key)}:${_canonicalize(v, seen)}`);
        }
        result = `{${parts.join(",")}}`;
    }

    seen.delete(obj);
    return result;
}
