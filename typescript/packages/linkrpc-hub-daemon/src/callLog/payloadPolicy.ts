import type { PayloadPolicy } from './callLogConfig';

export const REDACTED = '[redacted]';

/**
 * Apply the payload policy to an application payload (`$hubrpc*` meta already
 * stripped): redact values under sensitive keys and, in `truncated` mode, cut
 * long strings, long arrays, and deep nesting per property. Returns
 * `undefined` for `mode: "none"`.
 */
export function shapePayload(value: unknown, policy: PayloadPolicy): unknown {
    if (policy.mode === 'none' || value === undefined) return undefined;
    const redactKeys = policy.redactKeys.map(_normalizeKey);
    const truncate = policy.mode === 'truncated';
    const shape = (current: unknown, depth: number): unknown => {
        if (typeof current === 'string') {
            if (!truncate || current.length <= policy.maxStringLength) return current;
            return `${current.slice(0, policy.maxStringLength)}…(+${current.length - policy.maxStringLength} chars)`;
        }
        if (current === null || typeof current !== 'object') return current;
        if (truncate && depth >= policy.maxDepth) return Array.isArray(current) ? '[…]' : '{…}';
        if (Array.isArray(current)) {
            const kept = truncate ? current.slice(0, policy.maxArrayItems) : current;
            const items = kept.map(item => shape(item, depth + 1));
            if (kept.length < current.length) items.push(`…(+${current.length - kept.length} items)`);
            return items;
        }
        return Object.fromEntries(Object.entries(current).map(([key, entry]) => {
            const normalized = _normalizeKey(key);
            return [key, redactKeys.some(redact => normalized.includes(redact)) ? REDACTED : shape(entry, depth + 1)];
        }));
    };
    return shape(value, 0);
}

/** UTF-8 size of the JSON encoding; `undefined` for absent payloads. */
export function payloadBytes(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    const json = JSON.stringify(value);
    return json === undefined ? undefined : Buffer.byteLength(json);
}

function _normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[_-]/g, '');
}
