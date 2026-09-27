import type { Permission } from '@hediet/linkrpc';

/** `once` is additionally call-bound; `persistent` has no expiration. */
export type AccessDurationName = 'once' | 'shortLived' | 'longLived' | 'persistent';

const durationMs: Record<Exclude<AccessDurationName, 'persistent'>, number> = {
    once: 5 * 60 * 1000,
    shortLived: 5 * 60 * 1000,
    longLived: 24 * 60 * 60 * 1000,
};

/** Default to a short TTL; persistent grants do not expire. */
export function durationToExp(duration: AccessDurationName | undefined): number | undefined {
    const value = duration ?? 'shortLived';
    return value === 'persistent' ? undefined : Date.now() + durationMs[value];
}

/** Consent-only invocation preview used to derive an exact signed call binding. */
export interface AccessCallIntent {
    readonly method: string;
    readonly params?: unknown;
    readonly interfaceHash?: string;
    readonly nonce: string;
    readonly signedAtMs: number;
    readonly summary?: string;
    readonly suggestion?: AccessDurationName;
}

export interface AccessDirectPermission extends Permission {
    readonly callIntent?: AccessCallIntent;
}
