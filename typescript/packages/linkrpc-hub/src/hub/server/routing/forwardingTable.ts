import { isValidServiceId, ROOT_SERVICE_ID, SERVICE_ID_SEPARATOR, type ServiceId } from '@hediet/linkrpc/hub/common';

/**
 * A longest-prefix routing table keyed by {@link ServiceId} prefixes — the
 * hub's equivalent of an IP forwarding table.
 *
 * A prefix `"a/b"` owns every serviceId equal to it or beneath it
 * (`"a/b"`, `"a/b/c"`, …) *unless* a longer claimed prefix matches first.
 * Matching is segment-aware: `"a/bc"` is **not** under `"a/b"`.
 *
 * The table is intentionally a plain stateful container with no opinion on
 * *who* may claim what — that policy lives in {@link Hub.claimPrefix}. This
 * keeps the data structure trivially testable in isolation.
 */
export class ForwardingTable<T> {
    private readonly _entries = new Map<ServiceId, T>();
    /**
     * Reverse index: value → the set of prefixes claimed for it. Kept in
     * lock-step with {@link _entries} so {@link deleteByValue} (used when a
     * link detaches) is O(claims-for-that-value) instead of an O(size) scan.
     */
    private readonly _prefixesByValue = new Map<T, Set<ServiceId>>();

    /** Number of claimed prefixes. */
    public get size(): number {
        return this._entries.size;
    }

    public has(prefix: ServiceId): boolean {
        return this._entries.has(prefix);
    }

    public get(prefix: ServiceId): T | undefined {
        return this._entries.get(prefix);
    }

    /**
     * Claim `prefix` for `value`. Overwrites any existing claim — callers
     * that want claim-once semantics must check {@link has} first (the hub
     * does).
     */
    public set(prefix: ServiceId, value: T): void {
        const prev = this._entries.get(prefix);
        if (prev !== undefined && prev !== value) this._dropFromIndex(prev, prefix);
        this._entries.set(prefix, value);
        let prefixes = this._prefixesByValue.get(value);
        if (!prefixes) {
            prefixes = new Set();
            this._prefixesByValue.set(value, prefixes);
        }
        prefixes.add(prefix);
    }

    public delete(prefix: ServiceId): boolean {
        const value = this._entries.get(prefix);
        if (value === undefined) return false;
        this._entries.delete(prefix);
        this._dropFromIndex(value, prefix);
        return true;
    }

    /**
     * Remove every claim bound to `value` (matched by reference/equality).
     * O(number of prefixes that value owns). Returns the removed prefixes.
     */
    public deleteByValue(value: T): ServiceId[] {
        const prefixes = this._prefixesByValue.get(value);
        if (!prefixes) return [];
        this._prefixesByValue.delete(value);
        for (const prefix of prefixes) this._entries.delete(prefix);
        return [...prefixes];
    }

    private _dropFromIndex(value: T, prefix: ServiceId): void {
        const prefixes = this._prefixesByValue.get(value);
        if (!prefixes) return;
        prefixes.delete(prefix);
        if (prefixes.size === 0) this._prefixesByValue.delete(value);
    }

    public entries(): IterableIterator<[ServiceId, T]> {
        return this._entries.entries();
    }

    public prefixes(): ServiceId[] {
        return [...this._entries.keys()];
    }

    /**
     * Find the value owning the longest claimed prefix of `serviceId`.
     * Walks up the `'/'` segments — `"a/b/c"` tries `"a/b/c"`, `"a/b"`,
     * `"a"` in that order — and returns the first hit, or `undefined` if
     * none of its ancestors are claimed.
     */
    public longestPrefixMatch(serviceId: ServiceId): { prefix: ServiceId; value: T; } | undefined {
        let candidate = serviceId;
        while (candidate.length > 0) {
            const value = this._entries.get(candidate);
            if (value !== undefined) return { prefix: candidate, value };
            const slash = candidate.lastIndexOf(SERVICE_ID_SEPARATOR);
            if (slash === -1) break;
            candidate = candidate.slice(0, slash);
        }
        return undefined;
    }
}

/**
 * Validate a forwarding-table **prefix**: a non-root {@link ServiceId}. The
 * root (`""`) is a valid service id but cannot be claimed as a prefix (it
 * would capture every address); the uplink is the route of last resort
 * instead. Returns an error string, or `undefined` when well-formed.
 */
export function validatePrefix(prefix: unknown): string | undefined {
    if (typeof prefix !== 'string' || prefix === ROOT_SERVICE_ID) return 'prefix required';
    if (!isValidServiceId(prefix)) return "prefix must be a valid serviceId (no leading/trailing/empty '/' segments)";
    return undefined;
}
