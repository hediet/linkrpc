import { readFileSync } from "node:fs";

/**
 * Read params either from a `--params <json>` argument (treated as inline
 * JSON) or `--params -` (read from stdin). `undefined` if neither was given.
 */
export function readParamsArg(value: string | undefined): unknown {
    if (value === undefined) return undefined;
    const text = value === "-" ? readFileSync(0, "utf8") : value;
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    try {
        return JSON.parse(trimmed);
    } catch (e) {
        throw new Error(`--params: invalid JSON (${(e as Error).message})`);
    }
}

export function formatJson(v: unknown): string {
    if (v === undefined) return "undefined";
    return JSON.stringify(v, null, 2);
}

/** Stringify a value for one-line tabular output. */
export function oneLine(v: unknown): string {
    if (v === undefined) return "";
    if (typeof v === "string") return v;
    return JSON.stringify(v);
}
