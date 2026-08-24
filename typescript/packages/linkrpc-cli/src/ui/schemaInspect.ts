import type { LinkRpcJsonSchema as SvcJsonSchema } from "@hediet/linkrpc";

/**
 * Coarse classification of a field for the TUI. The form uses this to pick
 * a widget — fall back to free-form JSON editing for anything we can't render
 * inline.
 */
export type FieldKind =
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "enum"
    | "json";

export interface FieldClassification {
    readonly kind: FieldKind;
    /** Enumerated values for `kind === "enum"`. */
    readonly enumValues?: ReadonlyArray<unknown>;
}

export function classifyField(schema: SvcJsonSchema): FieldClassification {
    if (typeof schema === "boolean") return { kind: "json" };
    if ("enum" in schema) {
        return { kind: "enum", enumValues: schema.enum };
    }
    if ("const" in schema) {
        return { kind: "enum", enumValues: [schema.const] };
    }
    if ("anyOf" in schema) {
        // Treat unions of constants (or single-value branches) as enums so
        // they get the cycle widget instead of a JSON editor.
        const values: unknown[] = [];
        for (const branch of schema.anyOf) {
            if (typeof branch === "object" && "const" in branch) values.push(branch.const);
            else if (typeof branch === "object" && "enum" in branch) values.push(...branch.enum);
            else return { kind: "json" };
        }
        return { kind: "enum", enumValues: values };
    }
    if ("type" in schema && typeof schema.type === "string") {
        switch (schema.type) {
            case "string": return { kind: "string" };
            case "number": return { kind: "number" };
            case "integer": return { kind: "integer" };
            case "boolean": return { kind: "boolean" };
            default: return { kind: "json" }; // object, array, null
        }
    }
    return { kind: "json" };
}

/** A sensible default value for a freshly-focused field, by kind. */
export function defaultValueFor(c: FieldClassification): unknown {
    switch (c.kind) {
        case "string": return "";
        case "number":
        case "integer": return 0;
        case "boolean": return false;
        case "enum": return c.enumValues?.[0] ?? null;
        case "json": return null;
    }
}

/**
 * Move to the next/previous value in an enum field. Wraps at the ends. The
 * cycle is what powers `←`/`→` on enum fields without needing edit mode.
 */
export function cycleEnum(
    values: ReadonlyArray<unknown>,
    current: unknown,
    delta: 1 | -1,
): unknown {
    if (values.length === 0) return current;
    const idx = values.findIndex((v) => deepEqual(v, current));
    const next = (idx < 0 ? 0 : idx + delta + values.length) % values.length;
    return values[next];
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (typeof a !== "object") return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Parse a user-typed string into a value compatible with the given kind. */
export function parseTypedValue(
    raw: string,
    kind: FieldKind,
): { ok: true; value: unknown } | { ok: false; error: string } {
    switch (kind) {
        case "string": return { ok: true, value: raw };
        case "number": {
            if (raw.trim() === "") return { ok: true, value: undefined };
            const n = Number(raw);
            if (!Number.isFinite(n)) return { ok: false, error: `not a number: ${raw}` };
            return { ok: true, value: n };
        }
        case "integer": {
            if (raw.trim() === "") return { ok: true, value: undefined };
            const n = Number(raw);
            if (!Number.isInteger(n)) return { ok: false, error: `not an integer: ${raw}` };
            return { ok: true, value: n };
        }
        case "json": {
            if (raw.trim() === "") return { ok: true, value: undefined };
            try { return { ok: true, value: JSON.parse(raw) }; }
            catch (e) { return { ok: false, error: (e as Error).message }; }
        }
        case "boolean":
        case "enum":
            // These don't go through edit mode at all.
            return { ok: false, error: "not editable via text input" };
    }
}

/** Render the current value for display next to the field label. */
export function displayValue(value: unknown, kind: FieldKind): string {
    if (value === undefined) return "(unset)";
    if (kind === "string") return typeof value === "string" ? value : JSON.stringify(value);
    if (kind === "boolean") return value ? "[x]" : "[ ]";
    if (kind === "json") {
        const text = JSON.stringify(value);
        return text.length > 60 ? text.slice(0, 57) + "..." : text;
    }
    return JSON.stringify(value);
}

/** A short human description of the schema, shown in dim text after the value. */
export function describeSchema(s: SvcJsonSchema): string {
    if (typeof s === "boolean") return s ? "any" : "never";
    if ("type" in s && typeof s.type === "string") return s.type;
    if ("enum" in s) return `enum(${s.enum.map((v) => JSON.stringify(v)).join(" | ")})`;
    if ("const" in s) return `const ${JSON.stringify(s.const)}`;
    if ("anyOf" in s) return s.anyOf.map(describeSchema).join(" | ");
    if ("$ref" in s) return s.$ref;
    return "?";
}
