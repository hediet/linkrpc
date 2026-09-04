import {
    array,
    discriminatedUnion,
    literal,
    number,
    object,
    optional,
    string,
    unknown,
} from 'zod/mini';
import type { output as zInfer } from 'zod/v4/core';
import type { JsonValue } from './jsonValue';

/**
 * Incremental edits addressed by RFC 6901 JSON Pointers.
 *
 * `set` and `remove` replace/remove values, while `append`, `splice`, and
 * `insert` efficiently update streamed text and arrays without retransmitting
 * the containing document.
 */
export const jsonDocumentEditSchema = discriminatedUnion('op', [
    object({ op: literal('set'), path: string(), value: unknown() }),
    object({ op: literal('remove'), path: string() }),
    object({ op: literal('append'), path: string(), value: string() }),
    object({
        op: literal('splice'),
        path: string(),
        offset: number(),
        delete: optional(number()),
        insert: optional(string()),
    }),
    object({ op: literal('insert'), path: string(), index: number(), value: unknown() }),
]);

export type JsonDocumentEdit = zInfer<typeof jsonDocumentEditSchema>;

export type RevisionedDocumentEvent<T> =
    | { readonly type: 'snapshot'; readonly revision: number; readonly document: T; }
    | { readonly type: 'patch'; readonly revision: number; readonly edits: readonly JsonDocumentEdit[]; };

export function parseJsonPointer(pointer: string): string[] {
    if (pointer === '') return [];
    if (!pointer.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer (must start with '/'): ${pointer}`);
    }
    return pointer
        .slice(1)
        .split('/')
        .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

interface Parent {
    readonly container: Record<string, JsonValue | undefined> | JsonValue[];
    readonly key: string;
}

function resolveParent(root: JsonValue, tokens: readonly string[]): Parent {
    let current: JsonValue | undefined = root;
    for (const token of tokens.slice(0, -1)) {
        if (Array.isArray(current)) {
            const index = parseArrayIndex(token, current.length, false);
            current = current[index];
        } else if (isJsonObject(current)) {
            current = current[token];
        } else {
            throw new Error(`Cannot descend into non-container at token '${token}'`);
        }
    }
    const key = tokens.at(-1);
    if (key === undefined) throw new Error('JSON Pointer does not address a child');
    if (!Array.isArray(current) && !isJsonObject(current)) {
        throw new Error(`Cannot resolve parent for JSON Pointer token '${key}'`);
    }
    return { container: current, key };
}

function readChild(parent: Parent): JsonValue | undefined {
    if (Array.isArray(parent.container)) {
        return parent.container[parseArrayIndex(parent.key, parent.container.length, false)];
    }
    return parent.container[parent.key];
}

function writeChild(parent: Parent, value: JsonValue): void {
    if (Array.isArray(parent.container)) {
        const index = parseArrayIndex(parent.key, parent.container.length, false);
        parent.container[index] = value;
    } else {
        parent.container[parent.key] = value;
    }
}

function parseArrayIndex(token: string, length: number, allowEnd: boolean): number {
    if (!/^(0|[1-9]\d*)$/.test(token)) {
        throw new Error(`Invalid array index '${token}'`);
    }
    const index = Number(token);
    const upperBound = allowEnd ? length : length - 1;
    if (!Number.isSafeInteger(index) || index < 0 || index > upperBound) {
        throw new Error(`Array index '${token}' is out of bounds`);
    }
    return index;
}

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue | undefined> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applyJsonDocumentEdit(root: JsonValue, edit: JsonDocumentEdit): JsonValue {
    const tokens = parseJsonPointer(edit.path);
    if (tokens.length === 0) {
        if (edit.op === 'set') return structuredClone(edit.value) as JsonValue;
        throw new Error(`Operation '${edit.op}' cannot target the document root`);
    }

    const parent = resolveParent(root, tokens);
    switch (edit.op) {
        case 'set':
            writeChild(parent, structuredClone(edit.value) as JsonValue);
            return root;
        case 'remove':
            if (Array.isArray(parent.container)) {
                parent.container.splice(parseArrayIndex(parent.key, parent.container.length, false), 1);
            } else {
                delete parent.container[parent.key];
            }
            return root;
        case 'append': {
            const current = readChild(parent) ?? '';
            if (typeof current !== 'string') {
                throw new Error(`Append target is not a string at '${edit.path}'`);
            }
            writeChild(parent, current + edit.value);
            return root;
        }
        case 'splice': {
            const current = readChild(parent) ?? '';
            if (typeof current !== 'string') {
                throw new Error(`Splice target is not a string at '${edit.path}'`);
            }
            if (!Number.isSafeInteger(edit.offset) || edit.offset < 0 || edit.offset > current.length) {
                throw new Error(`Splice offset is out of bounds at '${edit.path}'`);
            }
            const deleteCount = edit.delete ?? 0;
            if (!Number.isSafeInteger(deleteCount) || deleteCount < 0) {
                throw new Error(`Splice delete count is invalid at '${edit.path}'`);
            }
            writeChild(
                parent,
                current.slice(0, edit.offset)
                    + (edit.insert ?? '')
                    + current.slice(edit.offset + deleteCount),
            );
            return root;
        }
        case 'insert': {
            const target = readChild(parent);
            if (!Array.isArray(target)) {
                throw new Error(`Insert target is not an array at '${edit.path}'`);
            }
            const index = edit.index === -1
                ? target.length
                : parseArrayIndex(String(edit.index), target.length, true);
            target.splice(index, 0, structuredClone(edit.value) as JsonValue);
            return root;
        }
    }
}

export function applyJsonDocumentEdits(
    root: JsonValue,
    edits: readonly JsonDocumentEdit[],
): JsonValue {
    let current = structuredClone(root);
    for (const edit of edits) current = applyJsonDocumentEdit(current, edit);
    return current;
}

export const jsonDocumentPatchSchema = object({
    type: literal('patch'),
    revision: number(),
    edits: array(jsonDocumentEditSchema),
});
