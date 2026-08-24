import type { SignedCapability } from '@hediet/linkrpc';

/** A flattened, human-/LLM-readable view of one permission inside a capability. */
export interface GrantPermissionSummary {
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly members: readonly string[];
    readonly canInvoke: boolean;
    readonly canDelegate: boolean;
}

/** A flattened view of a single held capability. */
export interface GrantSummary {
    readonly issuer: string;
    readonly audience: string;
    /** Unix ms the cap expires at, when bounded. */
    readonly expiresAtMs?: number;
    /** True when the cap is pinned to a single call (`callBind`); not reusable. */
    readonly oneShot: boolean;
    readonly permissions: readonly GrantPermissionSummary[];
}

/** The shape returned to the model by `con.grants()`. */
export interface GrantsSummary {
    readonly count: number;
    readonly grants: readonly GrantSummary[];
}

/** Render a single `serviceId` / `interfaceId` / member matcher as a string. */
function _fmtPattern(p: { exact: string } | { prefix: string }): string {
    if ('exact' in p) return p.exact;
    return p.prefix === '' ? '*' : `${p.prefix}*`;
}

/**
 * Summarise the durable capabilities a connection currently holds into a
 * compact, JSON-friendly shape the model can read to understand what access it
 * already has (and therefore what it still needs to request).
 */
export function summarizeGrants(caps: readonly SignedCapability[]): GrantsSummary {
    const grants = caps.map((c): GrantSummary => {
        const oneShot = c.permissions.some((p) => p.callBind !== undefined);
        return {
            issuer: c.issuer,
            audience: c.audience,
            ...(c.expiresAtMs !== undefined ? { expiresAtMs: c.expiresAtMs } : {}),
            oneShot,
            permissions: c.permissions.map((p): GrantPermissionSummary => ({
                serviceId: _fmtPattern(p.target.serviceId),
                interfaceId: _fmtPattern(p.target.interfaceId),
                members: p.target.members.map(_fmtPattern),
                canInvoke: p.canInvoke ?? false,
                canDelegate: p.canDelegate ?? false,
            })),
        };
    });
    return { count: grants.length, grants };
}
