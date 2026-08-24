import type { CallTarget } from "./capability";

/**
 * Parsed JSON-RPC method string. The linkrpc dialect uses `::` to
 * separate up to three segments:
 *
 *   - `"member"`                         — bare (preset-bound dispatch)
 *   - `"interfaceId::member"`            — interface form (root service)
 *   - `"::interfaceId::member"`          — explicit root form
 *   - `"serviceId::interfaceId::member"` — fully-qualified form
 *
 * The hub does not accept the `bare` form (it has no interface context
 * to route on). Connection-level dispatch accepts all three.
 */
export type ParsedMethodName =
    | { kind: "bare"; member: string }
    | { kind: "interface"; interfaceId: string; member: string }
    | { kind: "full"; serviceId: string; interfaceId: string; member: string };

/**
 * Parse a JSON-RPC method string. Returns `undefined` if any segment is
 * empty or the segment count is out of range.
 */
export function parseMethodName(method: string): ParsedMethodName | undefined {
    const parts = method.split("::");
    if (parts.length === 3 && parts[0].length === 0 && parts[1].length > 0 && parts[2].length > 0) {
        return { kind: "interface", interfaceId: parts[1], member: parts[2] };
    }
    if (parts.some((p) => p.length === 0)) return undefined;
    if (parts.length === 1) return { kind: "bare", member: parts[0] };
    if (parts.length === 2) return { kind: "interface", interfaceId: parts[0], member: parts[1] };
    if (parts.length === 3) return { kind: "full", serviceId: parts[0], interfaceId: parts[1], member: parts[2] };
    return undefined;
}

/**
 * Convert a parsed method string to a {@link CallTarget} for capability
 * matching. Interface-form calls are addressed to the root service —
 * represented as an empty `serviceId`. Throws on `bare` form (no
 * interface context) and on malformed input.
 */
export function methodNameToTarget(method: string): CallTarget {
    const p = parseMethodName(method);
    if (!p) throw new Error(`linkrpc: malformed method: ${method}`);
    if (p.kind === "bare") {
        throw new Error(`linkrpc: bare method has no interface context: ${method}`);
    }
    if (p.kind === "interface") {
        return { serviceId: "", interfaceId: p.interfaceId, member: p.member };
    }
    return { serviceId: p.serviceId, interfaceId: p.interfaceId, member: p.member };
}
