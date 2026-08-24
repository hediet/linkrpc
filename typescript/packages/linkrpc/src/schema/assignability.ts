import type {
    LinkRpcJsonSchema,
    JsonValue,
    ObjectSchema,
    ArraySchema,
    TupleSchema,
    UnionSchema,
    OneOfSchema,
    ConstSchema,
    EnumSchema,
    RefSchema,
} from "./linkRpcJsonSchema";

/**
 * Structural subtype check: returns `true` iff every JSON value matching
 * `sub` also matches `sup`, over the SvcJsonSchema subset.
 *
 * Cycles introduced by `$ref` are broken by assuming the recursive case
 * holds (standard coinductive subtyping). This is sound for productive
 * (non-degenerate) schemas; pathological inputs are out of scope.
 */
export function isAssignable(
    sub: LinkRpcJsonSchema,
    sup: LinkRpcJsonSchema,
    components: Components = {},
): boolean {
    return _check(sub, sup, components, new Set());
}

export interface Components {
    schemas?: Record<string, LinkRpcJsonSchema>;
}

function _check(sub: LinkRpcJsonSchema, sup: LinkRpcJsonSchema, c: Components, seen: Set<string>): boolean {
    // top / bottom shortcuts
    if (sup === true) return true;
    if (sub === false) return true;
    if (sup === false) return _isBottom(sub, c, seen);
    if (sub === true) return false;

    // resolve refs
    if (_isRef(sub)) {
        const k = `S:${sub.$ref}|${_keyOf(sup)}`;
        if (seen.has(k)) return true;
        const resolved = _resolveRef(sub, c);
        if (!resolved) return false;
        return _check(resolved, sup, c, new Set(seen).add(k));
    }
    if (_isRef(sup)) {
        const k = `${_keyOf(sub)}|T:${sup.$ref}`;
        if (seen.has(k)) return true;
        const resolved = _resolveRef(sup, c);
        if (!resolved) return false;
        return _check(sub, resolved, c, new Set(seen).add(k));
    }

    // unions distribute (anyOf / oneOf treated identically for assignability;
    // see SvcJsonSchema doc-comment)
    if (_isUnion(sub)) {
        return _branches(sub).every((branch) => _check(branch, sup, c, seen));
    }
    if (_isUnion(sup)) {
        return _branches(sup).some((branch) => _check(sub, branch, c, seen));
    }

    // const / enum on sub: every value must match sup
    if (_isConst(sub)) return _matches(sub.const, sup, c, seen);
    if (_isEnum(sub)) return sub.enum.every((v) => _matches(v, sup, c, seen));

    // const / enum on sup: sub must reduce to a subset
    if (_isConst(sup)) {
        if (_isConst(sub)) return _jsonEq(sub.const, sup.const);
        return false;
    }
    if (_isEnum(sup)) {
        if (_isConst(sub)) return sup.enum.some((v) => _jsonEq(sub.const, v));
        return false;
    }

    // From here on, both sides have a `type`. Mismatching types => not assignable,
    // except integer <: number.
    const subType = (sub as { type?: string }).type;
    const supType = (sup as { type?: string }).type;
    if (subType !== supType) {
        if (subType === "integer" && supType === "number") return true;
        return false;
    }

    switch (subType) {
        case "null":
        case "boolean":
            return true;

        case "number":
        case "integer":
            return _formatCompatible(
                (sub as { format?: string }).format,
                (sup as { format?: string }).format,
            );

        case "string":
            return _formatCompatible(
                (sub as { format?: string }).format,
                (sup as { format?: string }).format,
            );

        case "array":
            return _checkArrayLike(sub as ArrayLike, sup as ArrayLike, c, seen);

        case "object":
            return _checkObject(sub as ObjectSchema, sup as ObjectSchema, c, seen);

        default:
            return false;
    }
}

// ---- object ----

function _checkObject(
    sub: ObjectSchema,
    sup: ObjectSchema,
    c: Components,
    seen: Set<string>,
): boolean {
    const subReq = new Set(sub.required ?? []);
    const supReq = new Set(sup.required ?? []);

    // every required prop in sup must be required in sub
    for (const k of supReq) {
        if (!subReq.has(k)) return false;
    }

    // for each named prop in sup: sub.prop (or sub.additionalProperties) <: sup.prop
    for (const [k, supProp] of Object.entries(sup.properties)) {
        const subProp = sub.properties[k] ?? sub.additionalProperties;
        if (subProp === false) {
            // sub forbids this prop; only OK if sup doesn't require it AND
            // its schema is `true` (any). Otherwise sub-values omit it but
            // sup wouldn't permit absence.
            if (supReq.has(k)) return false;
            continue;
        }
        if (!_check(subProp, supProp, c, seen)) return false;
    }

    // sub may have extra named props: each must be <: sup.additionalProperties
    for (const [k, subProp] of Object.entries(sub.properties)) {
        if (k in sup.properties) continue;
        if (sup.additionalProperties === false) return false;
        if (!_check(subProp, sup.additionalProperties, c, seen)) return false;
    }

    // sub's additionalProperties bucket must fit sup's
    if (sub.additionalProperties === false) {
        // closed sub fits any sup additional bucket
    } else if (sup.additionalProperties === false) {
        // sub leaves room for arbitrary keys; sup forbids them — only sound
        // if sub's bucket is itself empty (`false`), which we handled above.
        return false;
    } else {
        if (!_check(sub.additionalProperties, sup.additionalProperties, c, seen)) return false;
    }

    return true;
}

// ---- array / tuple ----

type ArrayLike = (ArraySchema | TupleSchema) & { type: "array" };

function _checkArrayLike(
    sub: ArrayLike,
    sup: ArrayLike,
    c: Components,
    seen: Set<string>,
): boolean {
    const subPrefix = (sub as TupleSchema).prefixItems ?? [];
    const supPrefix = (sup as TupleSchema).prefixItems ?? [];
    const subRest = _restOf(sub);
    const supRest = _restOf(sup);

    const n = Math.max(subPrefix.length, supPrefix.length);
    for (let i = 0; i < n; i++) {
        const a = subPrefix[i] ?? subRest;
        const b = supPrefix[i] ?? supRest;
        if (a === false) {
            // sub asserts length <= i, so this position in sup is unreached.
            // Only OK if sup also forbids it (b === false) OR sup's position
            // is `true` (vacuously satisfied for non-existent values).
            if (b !== false && b !== true) return false;
            continue;
        }
        if (b === false) {
            // sup forbids this position; sub permits it.
            return false;
        }
        if (!_check(a, b, c, seen)) return false;
    }

    if (subRest === false) {
        // sub has bounded length; sup may permit more — OK.
    } else if (supRest === false) {
        // sup has bounded length but sub permits more.
        return false;
    } else {
        if (!_check(subRest, supRest, c, seen)) return false;
    }

    return true;
}

function _restOf(s: ArrayLike): LinkRpcJsonSchema | false {
    if ("items" in s) {
        if (s.items === undefined) return false; // exact-length tuple
        return s.items;
    }
    return true;
}

// ---- value matching (for const / enum on sub side) ----

function _matches(
    v: JsonValue,
    sup: LinkRpcJsonSchema,
    c: Components,
    seen: Set<string>,
): boolean {
    if (sup === true) return true;
    if (sup === false) return false;
    if (_isRef(sup)) {
        const r = _resolveRef(sup, c);
        return r ? _matches(v, r, c, seen) : false;
    }
    if (_isUnion(sup)) return _branches(sup).some((b) => _matches(v, b, c, seen));
    if (_isConst(sup)) return _jsonEq(v, sup.const);
    if (_isEnum(sup)) return sup.enum.some((e) => _jsonEq(v, e));

    const t = (sup as { type?: string }).type;
    switch (t) {
        case "null": return v === null;
        case "boolean": return typeof v === "boolean";
        case "number": return typeof v === "number";
        case "integer": return typeof v === "number" && Number.isInteger(v);
        case "string": return typeof v === "string";
        case "array": return Array.isArray(v) && _matchesArray(v, sup as ArrayLike, c, seen);
        case "object":
            return v !== null && typeof v === "object" && !Array.isArray(v)
                && _matchesObject(v as Record<string, JsonValue>, sup as ObjectSchema, c, seen);
        default: return false;
    }
}

function _matchesArray(
    v: JsonValue[],
    sup: ArrayLike,
    c: Components,
    seen: Set<string>,
): boolean {
    const prefix = (sup as TupleSchema).prefixItems ?? [];
    const rest = _restOf(sup);
    if (rest === false && v.length !== prefix.length) {
        if (v.length > prefix.length) return false;
    }
    for (let i = 0; i < v.length; i++) {
        const s = prefix[i] ?? (rest === false ? false : rest);
        if (s === false) return false;
        if (!_matches(v[i], s, c, seen)) return false;
    }
    return true;
}

function _matchesObject(
    v: Record<string, JsonValue>,
    sup: ObjectSchema,
    c: Components,
    seen: Set<string>,
): boolean {
    for (const k of sup.required ?? []) {
        if (!(k in v)) return false;
    }
    for (const [k, val] of Object.entries(v)) {
        const s = sup.properties[k] ?? sup.additionalProperties;
        if (s === false) return false;
        if (!_matches(val, s, c, seen)) return false;
    }
    return true;
}

// ---- bottom check ----

function _isBottom(s: LinkRpcJsonSchema, c: Components, seen: Set<string>): boolean {
    if (s === false) return true;
    if (s === true) return false;
    if (_isRef(s)) {
        const k = `B:${s.$ref}`;
        if (seen.has(k)) return false;
        const r = _resolveRef(s, c);
        return r ? _isBottom(r, c, new Set(seen).add(k)) : false;
    }
    if (_isUnion(s)) return _branches(s).every((b) => _isBottom(b, c, seen));
    return false;
}

// ---- helpers ----

function _formatCompatible(subFmt: string | undefined, supFmt: string | undefined): boolean {
    if (supFmt === undefined) return true;
    return subFmt === supFmt;
}

function _isRef(s: LinkRpcJsonSchema): s is RefSchema {
    return s !== true && s !== false && "$ref" in s;
}
function _isUnion(s: LinkRpcJsonSchema): s is UnionSchema | OneOfSchema {
    return s !== true && s !== false && ("anyOf" in s || "oneOf" in s);
}
function _branches(s: UnionSchema | OneOfSchema): LinkRpcJsonSchema[] {
    return "anyOf" in s ? s.anyOf : s.oneOf;
}
function _isConst(s: LinkRpcJsonSchema): s is ConstSchema {
    return s !== true && s !== false && "const" in s;
}
function _isEnum(s: LinkRpcJsonSchema): s is EnumSchema {
    return s !== true && s !== false && "enum" in s;
}

function _resolveRef(r: RefSchema, c: Components): LinkRpcJsonSchema | undefined {
    const prefix = "#/components/schemas/";
    if (!r.$ref.startsWith(prefix)) return undefined;
    const name = r.$ref.slice(prefix.length);
    return c.schemas?.[name];
}

function _keyOf(s: LinkRpcJsonSchema): string {
    if (s === true || s === false) return String(s);
    if ("$ref" in s) return `R:${s.$ref}`;
    return JSON.stringify(s);
}

function _jsonEq(a: JsonValue, b: JsonValue): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        return a.every((v, i) => _jsonEq(v, b[i]));
    }
    if (typeof a === "object") {
        const ao = a as Record<string, JsonValue>;
        const bo = b as Record<string, JsonValue>;
        const ak = Object.keys(ao).sort();
        const bk = Object.keys(bo).sort();
        if (ak.length !== bk.length) return false;
        return ak.every((k, i) => k === bk[i] && _jsonEq(ao[k], bo[k]));
    }
    return false;
}
