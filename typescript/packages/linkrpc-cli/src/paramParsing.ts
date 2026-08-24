/**
 * Parse `--param k=v` style overrides into a JSON object. Values that parse
 * as JSON are used as-is (numbers, booleans, null, arrays, objects); the rest
 * are treated as strings. Nested keys use `.` segments: `--param user.name=x`.
 *
 * Combined with `--params <json>` (the whole params blob), `--param k=v`
 * entries layer on top (object-merge for `--params`, then per-key overrides).
 */
export interface ParseParamsOptions {
    /** Optional base params object (from `--params <json>` or stdin). */
    base?: unknown;
    /** Raw `--param k=v` strings, in order. */
    overrides?: readonly string[];
}

export function parseParamOverride(raw: string): { path: string[]; value: unknown } {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
        throw new Error(`Invalid --param "${raw}" (expected key=value)`);
    }
    const key = raw.slice(0, eq);
    const valueStr = raw.slice(eq + 1);
    const path = key.split(".");
    if (path.some((p) => p.length === 0)) {
        throw new Error(`Invalid --param key "${key}" (empty segment)`);
    }
    const value = parseScalar(valueStr);
    return { path, value };
}

function parseScalar(raw: string): unknown {
    // Try JSON first: lets users pass numbers, booleans, null, arrays, objects.
    // Fall back to the raw string — the common `--param to=a@b.c` case.
    if (raw.length === 0) return "";
    const first = raw[0];
    if (first === '"' || first === "{" || first === "[" || first === "-"
        || first === "t" || first === "f" || first === "n"
        || (first >= "0" && first <= "9")) {
        try {
            return JSON.parse(raw);
        } catch {
            // fall through
        }
    }
    return raw;
}

export function mergeParams(opts: ParseParamsOptions): unknown {
    const base = opts.base !== undefined ? cloneJson(opts.base) : undefined;
    const overrides = opts.overrides ?? [];
    if (overrides.length === 0) return base;

    let root: unknown = base;
    for (const raw of overrides) {
        const { path, value } = parseParamOverride(raw);
        root = setDeep(root, path, value);
    }
    return root;
}

function setDeep(root: unknown, path: readonly string[], value: unknown): unknown {
    if (path.length === 1) {
        const target = asPlainObject(root) ?? {};
        target[path[0]] = value;
        return target;
    }
    const target = asPlainObject(root) ?? {};
    const [head, ...rest] = path;
    target[head] = setDeep(target[head], rest, value);
    return target;
}

function asPlainObject(v: unknown): Record<string, unknown> | undefined {
    if (v && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>;
    }
    return undefined;
}

function cloneJson<T>(v: T): T {
    if (v === undefined) return v;
    return JSON.parse(JSON.stringify(v)) as T;
}
