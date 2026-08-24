/**
 * `HubAccessGrantSigner` — a standalone, in-process consent signer for the
 * `hubAccess` flow. It bundles two things and nothing else:
 *
 *  - a {@link SigningIdentity} it mints capabilities with, and
 *  - a {@link GrantPolicy} that says, per request, permit or reject.
 *
 * It implements **no interface** — it is plumbing you adapt onto the hubAccess
 * front door via {@link createHubAccessConfig}:
 *
 * ```ts
 * const signer = new HubAccessGrantSigner(adminIdentity, () => ({ result: 'permitted' }));
 * registerHubAccessService(root, createHubAccessConfig(signer.decide));
 * ```
 *
 * This is the simple "the hub grants locally with its own key" path (tests, a
 * trusted local operator). The distributed, keyless path uses
 * {@link HubAccessManifestHost} instead, where a *remote* approver signs.
 */
import { type SignedCapability, type SigningIdentity } from '@hediet/linkrpc';
import { CapabilityProposalIssuer, durationToExp } from '../hub/server';
import { toSignedPermissions } from './consent';
import type { AccessDecider, AccessRequestContext } from './hubAccessConfig';

/** A grant policy's verdict on one request. */
export type GrantVerdict =
    | { readonly result: 'permitted' }
    | { readonly result: 'rejected'; readonly reason?: string };

/** Decides whether to grant a normalized request. May be sync or async. */
export type GrantPolicy = (request: AccessRequestContext) => GrantVerdict | Promise<GrantVerdict>;

export class HubAccessGrantSigner {
    private readonly _issuer: CapabilityProposalIssuer;

    constructor(
        signingIdentity: SigningIdentity,
        private readonly _grant: GrantPolicy,
    ) {
        this._issuer = new CapabilityProposalIssuer(signingIdentity);
    }

    /**
     * The {@link AccessDecider}: consult the grant policy and, on `permitted`,
     * mint a capability with the held identity (audience = the consumer,
     * honoring "Allow once" `callBind` byte-binding for one-shot durations).
     */
    public readonly decide: AccessDecider = async (ctx) => {
        const verdict = await this._grant(ctx);
        if (verdict.result === 'rejected') {
            return verdict.reason !== undefined ? { grant: false, reason: verdict.reason } : { grant: false };
        }
        const capability = await this._mint(ctx);
        return { grant: true, capabilities: [capability] };
    };

    private async _mint(ctx: AccessRequestContext): Promise<SignedCapability> {
        return this._issuer.mint({
            audience: ctx.consumerPrincipalId,
            permissions: await toSignedPermissions(ctx.permissions, ctx.consumerPrincipalId, ctx.duration),
            expiresAtMs: durationToExp(ctx.duration),
        });
    }
}
