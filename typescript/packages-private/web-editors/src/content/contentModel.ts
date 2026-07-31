import type { ContentEdit, TextEdit } from "../protocol";

export type JsonValue = unknown;

/**
 * Apply a list of {@link ContentEdit}s to a JSON value.
 *
 * Edits are applied in order. Each edit either replaces the value at `path`
 * or applies a sequence of string edits to the string at `path`.
 *
 * Returns the new root value. May mutate intermediate containers — callers
 * should treat the input as consumed.
 */
export function applyContentEdits(root: JsonValue, edits: readonly ContentEdit[]): JsonValue {
    let current = root;
    for (const edit of edits) {
        if (edit.kind === "replace") {
            current = setAtPath(current, edit.path, edit.newValue);
        } else {
            const existing = getAtPath(current, edit.path);
            if (typeof existing !== "string") {
                throw new Error(
                    `applyContentEdits: stringEdits at path [${edit.path.join(", ")}] requires a string, got ${typeof existing}`,
                );
            }
            current = setAtPath(current, edit.path, applyTextEdits(existing, edit.stringEdits));
        }
    }
    return current;
}

/** Apply a list of {@link TextEdit}s to a string. Edits are applied in array order. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
    let result = text;
    for (const e of edits) {
        result = result.slice(0, e.offset) + e.newText + result.slice(e.offset + e.length);
    }
    return result;
}

function getAtPath(root: JsonValue, path: readonly string[]): JsonValue {
    let cur: any = root;
    for (const key of path) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[key];
    }
    return cur;
}

function setAtPath(root: JsonValue, path: readonly string[], value: JsonValue): JsonValue {
    if (path.length === 0) return value;
    const rootObj: any = root === null || typeof root !== "object" ? {} : root;
    let cur: any = rootObj;
    for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        const next = cur[key];
        if (next === null || typeof next !== "object") {
            cur[key] = {};
        }
        cur = cur[key];
    }
    cur[path[path.length - 1]] = value;
    return rootObj;
}
