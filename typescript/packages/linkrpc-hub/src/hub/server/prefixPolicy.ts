import type { PrincipalId } from '@hediet/linkrpc';
import type { ITransportWithProvenance } from './provenance';
import { isValidServiceId, ROOT_SERVICE_ID, type ServiceId } from '@hediet/linkrpc/hub/common';
import type { Transport } from '@hediet/linkrpc/hub/common';

/** What a prefix-claim is judged against. */
export interface ClaimContext<TTransport extends Transport> {
    /**
     * Node id of the participant's hub-minted managed identity, or `undefined`
     * if the connection has no identity (anonymous routing).
     */
    readonly principal: PrincipalId | undefined;
    /** The connecting transport (may carry provenance, depending on `T`). */
    readonly transport: TTransport;
    /** ServiceId prefix the participant is trying to claim. */
    readonly requestedPrefix: ServiceId;
}

/**
 * Decides whether a participant may own a routing prefix. This is the policy
 * wrapped around the hub's single privileged write seam (`claimPrefix`) — the
 * only place identity/provenance gates routing.
 */
export interface PrefixPolicy<TTransport extends Transport> {
    authorizeClaim(
        ctx: ClaimContext<TTransport>,
    ): { ok: true; } | { ok: false; reason: string; };
}

export interface PrincipalIdPrefixPolicyOptions<TTransport extends ITransportWithProvenance> {
    /**
     * Prefixes a participant is allowed to claim. Default: the transport's
     * attested {@link ConnectionProvenance.identityKey} used **verbatim** as
     * the sole claimable prefix (e.g. `"docker/echo-provider"`). The full,
     * namespace-scoped key is the prefix — it is never split or rewritten. A
     * connection with no provenance may claim nothing.
     */
    derivePrefixes?(ctx: ClaimContext<TTransport>): readonly ServiceId[];
}

/**
 * Default {@link PrefixPolicy}: a participant may claim only the prefix(es)
 * {@link PrincipalIdPrefixPolicyOptions.derivePrefixes} grants it. The out-of-box
 * derivation ties the claimable prefix to the peer's attested provenance, so
 * `docker/echo-provider` can serve `docker/echo-provider/*` and nothing can
 * impersonate it.
 */
export class PrincipalIdPrefixPolicy<TTransport extends ITransportWithProvenance>
    implements PrefixPolicy<TTransport>
{
    private readonly _derive: (ctx: ClaimContext<TTransport>) => readonly ServiceId[];

    constructor(options: PrincipalIdPrefixPolicyOptions<TTransport> = {}) {
        this._derive = options.derivePrefixes ?? defaultDerivePrefixes;
    }

    public authorizeClaim(
        ctx: ClaimContext<TTransport>,
    ): { ok: true; } | { ok: false; reason: string; } {
        const allowed = this._derive(ctx);
        if (allowed.includes(ctx.requestedPrefix)) {
            return { ok: true };
        }
        return {
            ok: false,
            reason: `not authorized to claim '${ctx.requestedPrefix}'`,
        };
    }
}

function defaultDerivePrefixes<TTransport extends ITransportWithProvenance>(
    ctx: ClaimContext<TTransport>,
): readonly ServiceId[] {
    const provenance = ctx.transport.provenance;
    if (!provenance) {
        return [];
    }
    // SECURITY: the attested `identityKey` is itself the claimable prefix and
    // is used verbatim. It is a fully-qualified, namespace-scoped ServiceId
    // (e.g. `docker/echo-provider`). The namespace segment is load-bearing —
    // stripping it would let `docker/echo` and `k8s/echo` derive the same
    // prefix and impersonate one another. We only accept it if it is a
    // well-formed, non-root ServiceId; anything else grants no claim.
    const prefix = provenance.identityKey;
    if (prefix === ROOT_SERVICE_ID || !isValidServiceId(prefix)) {
        return [];
    }
    return [prefix];
}
