import { jcsCanonicalize } from "../protocol/jcs";
import { sha256 } from "../crypto/sha256";
import type { LinkRpcInterfaceSchema, MethodSchema } from "./linkRpcInterfaceSchema";
import { normalizeJsonSchema } from "./normalize";

const methodSchemaFields = [
    "params",
    "result",
    "clientStream",
    "serverStream",
] as const;

/**
 * Compute the interface hash: SHA-256 of the canonicalized schema, truncated
 * to 16 hex chars (64 bits of collision budget per id).
 *
 * Canonicalization strips the schema down to its **normative wire-contract
 * projection** before hashing, so a single interface document can carry richer
 * non-normative material (codegen hints, safety expressions, notes) without
 * changing identity:
 *
 *   1. Normalize every JSON-Schema position (`params`, `result`, streams, and
 *      `components.schemas`) onto the decidable linkrpc subset.
 *   2. Strip every `comment` field (non-normative — must not affect identity).
 *      `description` is NORMATIVE and kept in the hash.
 *   3. Strip every **specification-extension** field — any object key whose name
 *      begins with `x-` — at every level of the document (see
 *      {@link EXTENSION_PREFIX}). This is the minimal, explicit "one document,
 *      two views" mechanism: the stored document keeps the rich `x-…`
 *      expressions; identity hashes only the simple contract. It mirrors
 *      OpenRPC/OpenAPI specification extensions (this schema format is a subset
 *      of OpenRPC 1.x). Editing an `x-…` value never changes the hash; changing
 *      a wire field (`params`, `result`, member names, `type`, `required`,
 *      `description`, `annotations`, …) does.
 *   4. Omit the top-level `hash` field itself.
 *   5. RFC 8785 JCS encode (recursive key sort, no whitespace) via {@link jcsCanonicalize}.
 *
 * Because no interface schema uses `x-…` keys today, this preserves every
 * existing hash: stripping a set of keys that are always absent is a no-op.
 *
 * > Reservation. `x-…` is reserved for non-normative extensions at every level.
 * > Member names cannot collide (they are alphanumeric per chapter 01 §2), and
 * > object property names in the JSON Schema subset MUST NOT begin with `x-`.
 */
export function computeInterfaceHash(schema: LinkRpcInterfaceSchema): string {
    const normalized = normalizeSchemaPositions(schema);
    const json = jcsCanonicalize(stripNonNormative(normalized, /* isRoot */ true));
    const digest = sha256(new TextEncoder().encode(json));
    const result = Array.from(digest.subarray(0, 8), (b) =>
        b.toString(16).padStart(2, "0")
    ).join("");
    return result;
}

function normalizeSchemaPositions(schema: LinkRpcInterfaceSchema): LinkRpcInterfaceSchema {
    const methods: LinkRpcInterfaceSchema["methods"] = Object.fromEntries(
        Object.entries(schema.methods).map(([name, method]) => {
            const normalized: MethodSchema = { ...method };
            for (const field of methodSchemaFields) {
                const value = normalized[field];
                if (value !== undefined) {
                    normalized[field] = normalizeJsonSchema(value);
                }
                if (method.errors !== undefined) {
                    normalized.errors = method.errors.map((error) => ({
                        ...error,
                        ...(error.data === undefined ? {} : { data: normalizeJsonSchema(error.data) }),
                    }));
                }
            }
            return [name, normalized];
        }),
    );
    const componentSchemas = schema.components?.schemas;
    const components = componentSchemas === undefined
        ? schema.components
        : {
            ...schema.components,
            schemas: Object.fromEntries(
                Object.entries(componentSchemas).map(([name, value]) => [
                    name,
                    normalizeJsonSchema(value),
                ]),
            ),
        };
    return {
        ...schema,
        methods,
        ...(components === undefined ? {} : { components }),
    };
}

/**
 * Prefix marking a non-normative **specification-extension** key. Any object
 * key beginning with this prefix is stripped before hashing (at every level),
 * exactly like `comment`. Reserved for rich, identity-neutral material such as
 * codegen directives, richer validation/safety expressions, or tooling hints.
 */
export const EXTENSION_PREFIX = "x-";

/** True for a key that must not contribute to the interface hash. */
function isNonNormativeKey(key: string, isRoot: boolean): boolean {
    return (
        key === "comment" ||
        key.startsWith(EXTENSION_PREFIX) ||
        (isRoot && key === "hash")
    );
}

function stripNonNormative(value: unknown, isRoot = false): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => stripNonNormative(v));

    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
        if (isNonNormativeKey(k, isRoot)) continue;
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) continue;
        out[k] = stripNonNormative(v);
    }
    return out;
}
