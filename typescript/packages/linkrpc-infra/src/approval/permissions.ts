import type { Pattern, Permission } from '@hediet/linkrpc';

/** Build one permission per requested interface, scoped to `serviceId`. */
export function buildSlotPermissions(
    serviceId: string,
    interfaces: readonly { id: string; hash?: string; }[],
    members: readonly { interfaceId: string; member: Pattern; }[],
    present: ReadonlySet<string>,
): Permission[] {
    const hashByIface = new Map(interfaces.map((i) => [i.id, i.hash]));
    const buckets = new Map<string, { interfaceId: string; hash: string | undefined; members: Pattern[]; }>();
    for (const m of members) {
        if (!present.has(m.interfaceId)) continue;
        const hash = hashByIface.get(m.interfaceId);
        const key = `${m.interfaceId}\u0000${hash ?? ''}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { interfaceId: m.interfaceId, hash, members: [] };
            buckets.set(key, bucket);
        }
        bucket.members.push(m.member);
    }
    // No member-level requests: grant the whole interface (any member).
    if (buckets.size === 0) {
        return [...present].map((interfaceId) => {
            const hash = hashByIface.get(interfaceId);
            const target: Permission['target'] = {
                serviceId: { exact: serviceId },
                interfaceId: { exact: interfaceId },
                members: [{ prefix: '' }],
            };
            if (hash !== undefined) target.interfaceHash = hash;
            return { target, canInvoke: true };
        });
    }
    return [...buckets.values()].map((b) => {
        const target: Permission['target'] = {
            serviceId: { exact: serviceId },
            interfaceId: { exact: b.interfaceId },
            members: b.members,
        };
        if (b.hash !== undefined) target.interfaceHash = b.hash;
        return { target, canInvoke: true };
    });
}
