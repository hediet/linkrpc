import type { IRequestSender, Principal, SigningCallCtx } from '@vscode/hubrpc';
import {
    createManagedPrincipal,
    createSelfManagedPrincipal,
    createSelfManagedPrincipalFromFile,
} from '@vscode/hubrpc/node';

/**
 * Identity slot the managed-with-fallback default falls back to when the peer
 * does not offer a managed identity overlay (e.g. a plain stdio server). Maps
 * to the same on-disk slot `logout` clears.
 */
export const MANAGED_FALLBACK_USER_ID = 'hubrpc-cli';

/**
 * Which identity the CLI signs outbound calls with, parsed from `--principal`:
 *  - `managed` — the peer signs for us via its `identity::*` overlay; falls
 *    back to a local self-managed `{@link MANAGED_FALLBACK_USER_ID}` keypair
 *    when no overlay is available.
 *  - `user:<id>` — a local Ed25519 keypair stored in the per-user data dir,
 *    keyed by `<id>`.
 *  - `file:<path>` — a local Ed25519 keypair stored at exactly `<path>`.
 */
export type PrincipalSpec =
    | { readonly kind: 'managed'; }
    | { readonly kind: 'user'; readonly id: string; }
    | { readonly kind: 'file'; readonly path: string; };

/**
 * Parse a `--principal` value. `undefined` and `managed` both yield the
 * managed-with-fallback default. Throws on malformed input.
 */
export function parsePrincipalSpec(raw: string | undefined): PrincipalSpec {
    if (raw === undefined || raw === 'managed') return { kind: 'managed' };
    if (raw.startsWith('user:')) {
        const id = raw.slice('user:'.length);
        if (id === '') throw new Error('--principal "user:<id>" requires a non-empty id');
        return { kind: 'user', id };
    }
    if (raw.startsWith('file:')) {
        const path = raw.slice('file:'.length);
        if (path === '') throw new Error('--principal "file:<path>" requires a non-empty path');
        return { kind: 'file', path };
    }
    throw new Error(
        `invalid --principal "${raw}" (expected "managed", "user:<id>", or "file:<path>")`,
    );
}

/**
 * Which identity actually ended up signing the calls, after resolution. Unlike
 * {@link PrincipalSpec} (what the user asked for), this records what was really
 * used — e.g. whether a `managed` request fell back to a local keypair because
 * the peer offered no identity overlay.
 */
export type PrincipalSource =
    | { readonly kind: 'managed'; }
    | { readonly kind: 'managed-fallback'; readonly userId: string; }
    | { readonly kind: 'user'; readonly id: string; }
    | { readonly kind: 'file'; readonly path: string; };

/**
 * A resolved {@link Principal} together with a description of which identity
 * actually ended up signing the calls.
 */
export interface ResolvedPrincipal {
    readonly principal: Principal;
    readonly source: PrincipalSource;
}

/**
 * Resolve a {@link PrincipalSpec} into a concrete {@link Principal}, given the
 * (signed) sender used to bootstrap a managed identity. Cheap/idempotent, so
 * it can be re-derived on each reconnect. Also reports the {@link PrincipalSource}
 * that was actually used, including whether `managed` fell back to a local key.
 */
export async function resolvePrincipal(
    spec: PrincipalSpec,
    sender: IRequestSender<SigningCallCtx>,
): Promise<ResolvedPrincipal> {
    switch (spec.kind) {
        case 'managed':
            try {
                return {
                    principal: await createManagedPrincipal(sender),
                    source: { kind: 'managed' },
                };
            } catch {
                return {
                    principal: await createSelfManagedPrincipal(MANAGED_FALLBACK_USER_ID),
                    source: { kind: 'managed-fallback', userId: MANAGED_FALLBACK_USER_ID },
                };
            }
        case 'user':
            return {
                principal: await createSelfManagedPrincipal(spec.id),
                source: { kind: 'user', id: spec.id },
            };
        case 'file':
            return {
                principal: await createSelfManagedPrincipalFromFile(spec.path),
                source: { kind: 'file', path: spec.path },
            };
    }
}

/**
 * Render a one-line, human-readable description of the identity used to sign
 * calls, e.g. `managed (node abcd012345…)` or
 * `local user:hubrpc-cli (node abcd012345…)`. `nodeId` is truncated to its
 * first 10 characters.
 */
export function formatPrincipalSource(source: PrincipalSource, nodeId: string): string {
    const node = `node ${nodeId.slice(0, 10)}…`;
    switch (source.kind) {
        case 'managed':
            return `managed (${node})`;
        case 'managed-fallback':
            return `local user:${source.userId} (managed unavailable) (${node})`;
        case 'user':
            return `local user:${source.id} (${node})`;
        case 'file':
            return `local file:${source.path} (${node})`;
    }
}
