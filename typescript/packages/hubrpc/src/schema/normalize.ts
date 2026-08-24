import type { HubRpcJsonSchema, DiscriminatorSchema } from "./hubRpcJsonSchema";

/**
 * Keys that describe structural shape and are part of the decidable subset.
 * Everything else gets stripped during normalization.
 *
 * Note: `not` is intentionally NOT in this list. The special case `{"not":{}}`
 * (i.e. matches-nothing) is mapped to the literal `false` bottom; any other
 * `not` is dropped.
 */
const KEPT_KEYS = new Set([
    "type", "format",
    "properties", "required", "additionalProperties",
    "items", "prefixItems",
    "const", "enum",
    "anyOf", "oneOf", "discriminator",
    "$ref",
    "title", "description",
]);

/**
 * Normalize raw JSON Schema output (e.g. from `z.toJSONSchema`) into the
 * SvcJsonSchema subset:
 *
 *  - drop annotation keys (`examples`, `default`, `$comment`, `readOnly`, ...)
 *  - drop out-of-subset refinements (`pattern`, `minimum`, `multipleOf`,
 *    `allOf`, `oneOf`, `if/then/else`, `patternProperties`, ...)
 *  - empty schema `{}` ⇒ `true` (top)
 *  - `{"not":{}}` ⇒ `false` (bottom); any other `not` is stripped
 *  - `type:"object"` without `additionalProperties` ⇒ closed (`false`),
 *    matching hubrpc's stricter contract
 *
 * The output is canonical: structurally equal inputs produce structurally
 * equal outputs, which is what `computeInterfaceHash` relies on.
 */
export function normalizeJsonSchema(raw: unknown): HubRpcJsonSchema {
    if (raw === true || raw === false) return raw;
    if (raw === null || typeof raw !== "object") {
        throw new Error(`normalizeJsonSchema: expected object, got ${typeof raw}`);
    }
    if (Array.isArray(raw)) {
        throw new Error("normalizeJsonSchema: expected object, got array");
    }

    const r = raw as Record<string, unknown>;

    // {"not": {}} => false (bottom). Handle before generic descent.
    if ("not" in r && isEmptyObject(r["not"])) return false;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
        if (!KEPT_KEYS.has(k)) continue;
        const normalized = normalizeChild(k, v);
        if (normalized === undefined) continue;
        out[k] = normalized;
    }

    // Object: hubrpc requires `additionalProperties` to be set. Default to
    // closed, matching what zod typically emits for `z.object`.
    if (out["type"] === "object" && !("additionalProperties" in out)) {
        out["additionalProperties"] = false;
    }

    // `oneOf`: if no explicit `discriminator` survived, try to synthesize
    // one from the branches. Zod's `z.discriminatedUnion` lowers via
    // `z.toJSONSchema` to `oneOf` without a `discriminator` keyword, so
    // without this auto-detection the tag information is invisible to
    // consumers (codegen, consent UIs).
    if (Array.isArray(out["oneOf"]) && !("discriminator" in out)) {
        const detected = _detectDiscriminator(out["oneOf"] as HubRpcJsonSchema[]);
        if (detected !== undefined) out["discriminator"] = detected;
    }

    // Drop a `discriminator` that has no `oneOf` to attach to — it would be
    // meaningless and would just bloat the hash.
    if ("discriminator" in out && !Array.isArray(out["oneOf"])) {
        delete out["discriminator"];
    }

    // Collapse empty into `true` (top).
    if (Object.keys(out).length === 0) return true;

    return out as unknown as HubRpcJsonSchema;
}

function normalizeChild(key: string, v: unknown): unknown {
    switch (key) {
        case "properties": {
            if (!isPlainObject(v)) return {};
            const out: Record<string, HubRpcJsonSchema> = {};
            for (const [pk, pv] of Object.entries(v)) {
                out[pk] = normalizeJsonSchema(pv);
            }
            return out;
        }
        case "items":
        case "additionalProperties": {
            if (v === false) return false;
            return normalizeJsonSchema(v);
        }
        case "prefixItems":
        case "anyOf":
        case "oneOf": {
            if (!Array.isArray(v)) return [];
            return v.map((s) => normalizeJsonSchema(s));
        }
        case "discriminator": {
            // Only `propertyName` is part of the subset. OpenAPI's `mapping`
            // (and anything else) is dropped — we have no use for it and it
            // would complicate hashing.
            if (!isPlainObject(v)) return undefined;
            const name = (v as Record<string, unknown>)["propertyName"];
            if (typeof name !== "string" || name.length === 0) return undefined;
            return { propertyName: name };
        }
        case "enum": {
            if (!Array.isArray(v)) return [];
            return v.slice();
        }
        case "required": {
            if (!Array.isArray(v)) return [];
            return v.slice().sort();
        }
        default:
            return v;
    }
}

function isEmptyObject(v: unknown): boolean {
    return isPlainObject(v) && Object.keys(v).length === 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Inspect a `oneOf` branch list and return a `discriminator` hint when
 * every branch is an object schema and there is exactly one property name
 * that appears in every branch with a distinct `const`-valued schema.
 *
 * This is the canonical JSON-Schema-only encoding of a tagged union, and
 * the shape `z.toJSONSchema(z.discriminatedUnion(...))` emits.
 */
function _detectDiscriminator(branches: HubRpcJsonSchema[]): DiscriminatorSchema | undefined {
    if (branches.length < 2) return undefined;
    // Each branch must be an object schema with `properties`.
    const branchPropsList: Record<string, HubRpcJsonSchema>[] = [];
    for (const b of branches) {
        if (b === true || b === false) return undefined;
        if ((b as { type?: string }).type !== "object") return undefined;
        const props = (b as { properties?: Record<string, HubRpcJsonSchema> }).properties;
        if (!props) return undefined;
        branchPropsList.push(props);
    }
    // Property names present (with a `const`-valued schema) on every branch.
    const firstConstProps = _constPropNames(branchPropsList[0]);
    let candidates = firstConstProps;
    for (let i = 1; i < branchPropsList.length; i++) {
        candidates = candidates.filter((n) => _constPropNames(branchPropsList[i]).includes(n));
        if (candidates.length === 0) return undefined;
    }
    // Of the surviving candidates, keep those whose const values are
    // pairwise distinct across all branches (a real discriminator).
    for (const name of candidates) {
        const seen = new Set<string>();
        let allDistinct = true;
        for (const props of branchPropsList) {
            const s = props[name] as { const?: unknown };
            const key = JSON.stringify(s.const);
            if (seen.has(key)) { allDistinct = false; break; }
            seen.add(key);
        }
        if (allDistinct) return { propertyName: name };
    }
    return undefined;
}

function _constPropNames(props: Record<string, HubRpcJsonSchema>): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(props)) {
        if (v === true || v === false) continue;
        if ("const" in (v as object)) out.push(k);
    }
    return out;
}
