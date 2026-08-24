import { isAssignable, type HubRpcJsonSchema as SvcJsonSchema } from "@vscode/hubrpc";

/**
 * Validate a concrete value against an `SvcJsonSchema`. Reuses hubrpc's
 * structural assignability — the value is lowered to a closed, const-shaped
 * schema and then asked "is this assignable to the target?". This avoids
 * pulling in a separate JSON-Schema validator and stays consistent with how
 * the connection layer reasons about interface compatibility.
 *
 * Returns `undefined` if the value is valid, or a short reason string.
 */
export function validateValueAgainstSchema(
    value: unknown,
    target: SvcJsonSchema,
    components: Record<string, SvcJsonSchema> = {},
): string | undefined {
    const actual = valueToConstSchema(value);
    try {
        return isAssignable(actual, target, { schemas: components })
            ? undefined
            : "does not match schema";
    } catch (e) {
        return (e as Error).message;
    }
}

/**
 * Lower a JSON value to the tightest `SvcJsonSchema` that matches only it.
 * Primitives become `{ const }`; arrays become tuples with `items: false`
 * (forbidding extras); objects become closed records with every property
 * required.
 *
 * `undefined` becomes the empty closed object — that's the
 * "no params supplied" case, which is only assignable to a target that has
 * no required properties.
 */
export function valueToConstSchema(v: unknown): SvcJsonSchema {
    if (v === undefined) {
        return { type: "object", properties: {}, additionalProperties: false };
    }
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
        return { const: v as never };
    }
    if (Array.isArray(v)) {
        return { type: "array", prefixItems: v.map(valueToConstSchema), items: false };
    }
    const obj = v as Record<string, unknown>;
    const properties: Record<string, SvcJsonSchema> = {};
    const required: string[] = [];
    for (const [k, val] of Object.entries(obj)) {
        properties[k] = valueToConstSchema(val);
        required.push(k);
    }
    return { type: "object", properties, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// Path-aware diagnostic validator
// ---------------------------------------------------------------------------

/**
 * One thing wrong with `value` at a given JSON path. Path uses dot/bracket
 * notation rooted at the validated value, e.g. `.query`, `.items[0].id`.
 * The empty string is the root.
 */
export interface ValidationIssue {
    readonly path: string;
    readonly reason: string;
}

/**
 * Walk `value` against `schema` and collect every mismatch we can pinpoint.
 * Returns `[]` on success. Each issue has a JSON-style path plus a single
 * line saying why that location is wrong — designed to be printed directly
 * under a "Param validation failed:" header.
 *
 * Coverage is best-effort: scalar / object / array / tuple / const / enum /
 * union / `$ref`. Unions report the branch with the fewest mismatches
 * (heuristic) so the user gets one concrete trail to fix instead of a
 * cascade of "no branch matched".
 */
export function explainValidation(
    value: unknown,
    schema: SvcJsonSchema,
    components: Record<string, SvcJsonSchema> = {},
): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    _walk(value, schema, "", components, issues);
    return issues;
}

function _walk(
    value: unknown,
    schema: SvcJsonSchema,
    path: string,
    components: Record<string, SvcJsonSchema>,
    out: ValidationIssue[],
): void {
    if (schema === true) return;
    if (schema === false) {
        out.push({ path, reason: "no value is valid here" });
        return;
    }
    if ("$ref" in schema) {
        const resolved = _resolveRef(schema.$ref, components);
        if (!resolved) {
            out.push({ path, reason: `unresolved $ref ${schema.$ref}` });
            return;
        }
        _walk(value, resolved, path, components, out);
        return;
    }
    if ("const" in schema) {
        if (!_jsonEq(value, schema.const)) {
            out.push({ path, reason: `expected ${_jsonShow(schema.const)}, got ${_describeValue(value)}` });
        }
        return;
    }
    if ("enum" in schema) {
        if (!schema.enum.some((v) => _jsonEq(value, v))) {
            const opts = schema.enum.slice(0, 5).map(_jsonShow).join(" | ");
            const more = schema.enum.length > 5 ? ` | …` : "";
            out.push({
                path,
                reason: `expected one of ${opts}${more}, got ${_describeValue(value)}`,
            });
        }
        return;
    }
    if ("anyOf" in schema || "oneOf" in schema) {
        const branches = "anyOf" in schema ? schema.anyOf : schema.oneOf;
        // Pick the branch with the fewest sub-issues — heuristic best-effort
        // for "what the user probably meant".
        let best: ValidationIssue[] | undefined;
        for (const b of branches) {
            const sub: ValidationIssue[] = [];
            _walk(value, b, path, components, sub);
            if (sub.length === 0) return;
            if (!best || sub.length < best.length) best = sub;
        }
        if (best) out.push(...best);
        else out.push({ path, reason: "value does not match any union branch" });
        return;
    }

    // Type-based dispatch.
    const t = (schema as { type?: string }).type;
    switch (t) {
        case "null":
            if (value !== null) out.push({ path, reason: `expected null, got ${_describeValue(value)}` });
            return;
        case "boolean":
            if (typeof value !== "boolean") {
                out.push({ path, reason: `expected boolean, got ${_describeValue(value)}` });
            }
            return;
        case "number":
            if (typeof value !== "number") {
                out.push({ path, reason: `expected number, got ${_describeValue(value)}` });
            }
            return;
        case "integer":
            if (typeof value !== "number" || !Number.isInteger(value)) {
                out.push({ path, reason: `expected integer, got ${_describeValue(value)}` });
            }
            return;
        case "string":
            if (typeof value !== "string") {
                out.push({ path, reason: `expected string, got ${_describeValue(value)}` });
            }
            return;
        case "array":
            _walkArray(value, schema as never, path, components, out);
            return;
        case "object":
            _walkObject(value, schema as never, path, components, out);
            return;
        default:
            // Unknown schema shape — fall back to a vague but honest message.
            out.push({ path, reason: "does not match schema" });
    }
}

function _walkObject(
    value: unknown,
    schema: {
        type: "object";
        properties: Record<string, SvcJsonSchema>;
        required?: string[];
        additionalProperties: SvcJsonSchema | false;
    },
    path: string,
    components: Record<string, SvcJsonSchema>,
    out: ValidationIssue[],
): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        out.push({ path: path || "(root)", reason: `expected object, got ${_describeValue(value)}` });
        return;
    }
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
        if (!(req in obj)) {
            const p = _joinKey(path, req);
            const propSchema = schema.properties[req];
            const typeHint = propSchema ? ` (${_typeHint(propSchema, components)})` : "";
            out.push({ path: p, reason: `required${typeHint}, but missing` });
        }
    }
    for (const [k, v] of Object.entries(obj)) {
        const propSchema = schema.properties[k];
        const p = _joinKey(path, k);
        if (propSchema !== undefined) {
            _walk(v, propSchema, p, components, out);
        } else if (schema.additionalProperties === false) {
            out.push({ path: p, reason: "unknown property" });
        } else {
            _walk(v, schema.additionalProperties, p, components, out);
        }
    }
}

function _walkArray(
    value: unknown,
    schema: { type: "array"; items?: SvcJsonSchema | false; prefixItems?: SvcJsonSchema[] },
    path: string,
    components: Record<string, SvcJsonSchema>,
    out: ValidationIssue[],
): void {
    if (!Array.isArray(value)) {
        out.push({ path: path || "(root)", reason: `expected array, got ${_describeValue(value)}` });
        return;
    }
    const prefix = schema.prefixItems ?? [];
    for (let i = 0; i < value.length; i++) {
        if (i < prefix.length) {
            _walk(value[i], prefix[i], `${path}[${i}]`, components, out);
        } else if (schema.items === false) {
            out.push({ path: `${path}[${i}]`, reason: "extra element (tuple is closed)" });
        } else if (schema.items !== undefined) {
            _walk(value[i], schema.items, `${path}[${i}]`, components, out);
        }
        // schema.items === undefined && i >= prefix.length: nothing said
    }
    if (prefix.length > 0 && value.length < prefix.length && schema.items === false) {
        out.push({
            path: path || "(root)",
            reason: `expected tuple of length ${prefix.length}, got ${value.length}`,
        });
    }
}

// ---------------------------------------------------------------------------
// describeSchema — compact "expected shape" summary
// ---------------------------------------------------------------------------

/**
 * Render an `SvcJsonSchema` as a short, copy-paste-friendly type expression.
 * Used as a hint next to required-property errors (`"name required (string)"`)
 * and as the "Expected" footer when full-on params reporting fires.
 */
export function describeSchema(
    schema: SvcJsonSchema,
    components: Record<string, SvcJsonSchema> = {},
    depth = 0,
): string {
    if (schema === true) return "any";
    if (schema === false) return "never";
    if ("$ref" in schema) {
        const name = schema.$ref.split("/").pop() ?? schema.$ref;
        return name;
    }
    if ("const" in schema) return _jsonShow(schema.const);
    if ("enum" in schema) {
        return schema.enum.slice(0, 6).map(_jsonShow).join(" | ")
            + (schema.enum.length > 6 ? " | …" : "");
    }
    if ("anyOf" in schema || "oneOf" in schema) {
        const branches = "anyOf" in schema ? schema.anyOf : schema.oneOf;
        return branches.map((b) => describeSchema(b, components, depth + 1)).join(" | ");
    }
    const t = (schema as { type?: string }).type;
    switch (t) {
        case "null":
        case "boolean":
        case "number":
        case "integer":
        case "string":
            return t;
        case "array": {
            const arr = schema as { items?: SvcJsonSchema | false; prefixItems?: SvcJsonSchema[] };
            if (arr.prefixItems && arr.prefixItems.length > 0) {
                const head = arr.prefixItems.map((s) => describeSchema(s, components, depth + 1)).join(", ");
                if (arr.items === false || arr.items === undefined) return `[${head}]`;
                return `[${head}, …${describeSchema(arr.items, components, depth + 1)}]`;
            }
            return arr.items === false || arr.items === undefined
                ? "[]"
                : `${describeSchema(arr.items, components, depth + 1)}[]`;
        }
        case "object": {
            if (depth >= 2) return "object";
            const obj = schema as {
                properties: Record<string, SvcJsonSchema>;
                required?: string[];
                additionalProperties: SvcJsonSchema | false;
            };
            const reqSet = new Set(obj.required ?? []);
            const fields = Object.entries(obj.properties).map(([k, v]) => {
                const opt = reqSet.has(k) ? "" : "?";
                return `${k}${opt}: ${describeSchema(v, components, depth + 1)}`;
            });
            return `{ ${fields.join("; ")} }`;
        }
    }
    return "any";
}

/**
 * Multi-line table of an object schema's properties: name, required-marker,
 * type, and description. Used as the "Expected params:" footer printed under
 * a validation error. Returns `undefined` if `schema` is not an object —
 * fall back to a single `describeSchema` line in that case.
 */
export function describeObjectParams(
    schema: SvcJsonSchema,
    components: Record<string, SvcJsonSchema> = {},
): string | undefined {
    const resolved = _resolveTop(schema, components);
    if (!resolved || typeof resolved !== "object" || !("type" in resolved) || resolved.type !== "object") {
        return undefined;
    }
    const obj = resolved as {
        type: "object";
        properties: Record<string, SvcJsonSchema>;
        required?: string[];
    };
    const required = new Set(obj.required ?? []);
    const rows: { name: string; type: string; req: string; desc: string; }[] = [];
    for (const [k, v] of Object.entries(obj.properties)) {
        const resolvedV = _resolveTop(v, components);
        const desc = (resolvedV && typeof resolvedV === "object" && "description" in resolvedV
            ? (resolvedV as { description?: string }).description
            : undefined) ?? "";
        rows.push({
            name: k,
            type: describeSchema(v, components, 1),
            req: required.has(k) ? "required" : "optional",
            desc,
        });
    }
    if (rows.length === 0) return "(no params)";
    const nameW = Math.max(...rows.map((r) => r.name.length));
    const typeW = Math.max(...rows.map((r) => r.type.length));
    const reqW = Math.max(...rows.map((r) => r.req.length));
    return rows
        .map((r) => {
            const head = `  ${r.name.padEnd(nameW)}  ${r.type.padEnd(typeW)}  ${r.req.padEnd(reqW)}`;
            return r.desc ? `${head}  ${r.desc}` : head;
        })
        .join("\n");
}

// ---------------------------------------------------------------------------
// helpers (private)
// ---------------------------------------------------------------------------

function _resolveTop(
    schema: SvcJsonSchema,
    components: Record<string, SvcJsonSchema>,
): SvcJsonSchema | undefined {
    if (schema === true || schema === false) return schema;
    if ("$ref" in schema) return _resolveRef(schema.$ref, components);
    return schema;
}

function _resolveRef(
    ref: string,
    components: Record<string, SvcJsonSchema>,
): SvcJsonSchema | undefined {
    const prefix = "#/components/schemas/";
    if (!ref.startsWith(prefix)) return undefined;
    return components[ref.slice(prefix.length)];
}

function _typeHint(schema: SvcJsonSchema, components: Record<string, SvcJsonSchema>): string {
    return describeSchema(schema, components, 1);
}

function _joinKey(parent: string, key: string): string {
    if (/^[A-Za-z_$][\w$]*$/.test(key)) return `${parent}.${key}`;
    return `${parent}[${JSON.stringify(key)}]`;
}

function _jsonEq(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function _jsonShow(v: unknown): string {
    return typeof v === "string" ? JSON.stringify(v) : String(v);
}

function _describeValue(v: unknown): string {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (Array.isArray(v)) return `array (length ${v.length})`;
    if (typeof v === "object") return "object";
    if (typeof v === "string") return `string (${JSON.stringify(v.length > 40 ? v.slice(0, 37) + "…" : v)})`;
    return `${typeof v} (${JSON.stringify(v)})`;
}
