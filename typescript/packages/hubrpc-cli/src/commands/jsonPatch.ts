export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };

export type JsonPatchOperation =
    | { readonly op: "add" | "replace"; readonly path: string; readonly value: JsonValue }
    | { readonly op: "remove"; readonly path: string };

export function createJsonPatch(
    before: JsonValue,
    after: JsonValue,
    path = "",
): JsonPatchOperation[] {
    if (Object.is(before, after)) {
        return [];
    }
    if (isJsonObject(before) && isJsonObject(after)) {
        const operations: JsonPatchOperation[] = [];
        const beforeKeys = Object.keys(before).sort();
        const afterKeys = Object.keys(after).sort();
        const afterKeySet = new Set(afterKeys);
        for (const key of beforeKeys) {
            if (!afterKeySet.has(key)) {
                operations.push({ op: "remove", path: appendPath(path, key) });
            }
        }
        const beforeKeySet = new Set(beforeKeys);
        for (const key of afterKeys) {
            const childPath = appendPath(path, key);
            if (!beforeKeySet.has(key)) {
                operations.push({ op: "add", path: childPath, value: after[key] });
            } else {
                operations.push(...createJsonPatch(before[key], after[key], childPath));
            }
        }
        return operations;
    }
    return [{ op: "replace", path, value: after }];
}

export function applyJsonPatch(
    value: JsonValue,
    operations: readonly JsonPatchOperation[],
): JsonValue {
    let result = structuredClone(value);
    for (const operation of operations) {
        if (operation.path === "") {
            if (operation.op === "remove") {
                throw new Error("Cannot remove the JSON document root");
            }
            result = structuredClone(operation.value);
            continue;
        }
        const segments = operation.path
            .slice(1)
            .split("/")
            .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
        let target = result;
        for (const segment of segments.slice(0, -1)) {
            if (typeof target !== "object" || target === null || Array.isArray(target)) {
                throw new Error(`JSON patch path does not address an object: ${operation.path}`);
            }
            target = target[segment];
        }
        if (typeof target !== "object" || target === null || Array.isArray(target)) {
            throw new Error(`JSON patch path does not address an object: ${operation.path}`);
        }
        const key = segments.at(-1)!;
        if (operation.op === "remove") {
            delete target[key];
        } else {
            target[key] = structuredClone(operation.value);
        }
    }
    return result;
}

function appendPath(path: string, key: string): string {
    return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
