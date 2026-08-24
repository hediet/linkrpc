import { describe, expect, it } from 'vitest';
import { PrincipalIdPrefixPolicy } from './prefixPolicy';
import type { ClaimContext } from './prefixPolicy';
import type { ConnectionProvenance } from './provenance';
import type { Transport } from '@hediet/linkrpc/hub/common';
import { fakeConnection } from './testUtil';

type AttestedTransport = Transport & { provenance: ConnectionProvenance | undefined; };

function ctx(
    identityKey: string | undefined,
    requestedPrefix: string,
): ClaimContext<AttestedTransport> {
    const transport = Object.assign(fakeConnection().server, {
        provenance: identityKey === undefined
            ? undefined
            : { identityKey, attributes: {} },
    }) as AttestedTransport;
    return { principal: 'node-abc', transport, requestedPrefix };
}

describe('PrincipalIdPrefixPolicy', () => {
    it('allows claiming the full attested identityKey verbatim (namespace kept)', () => {
        const policy = new PrincipalIdPrefixPolicy<AttestedTransport>();
        expect(policy.authorizeClaim(ctx('docker/echo-provider', 'docker/echo-provider')))
            .toEqual({ ok: true });
    });

    it('denies claiming the namespace-stripped tail (no impersonation across namespaces)', () => {
        const policy = new PrincipalIdPrefixPolicy<AttestedTransport>();
        expect(policy.authorizeClaim(ctx('docker/echo-provider', 'echo-provider')).ok).toBe(false);
    });

    it('denies claiming a different prefix', () => {
        const policy = new PrincipalIdPrefixPolicy<AttestedTransport>();
        const verdict = policy.authorizeClaim(ctx('docker/echo-provider', 'docker/echo-caller'));
        expect(verdict.ok).toBe(false);
    });

    it('denies any claim when there is no provenance', () => {
        const policy = new PrincipalIdPrefixPolicy<AttestedTransport>();
        const verdict = policy.authorizeClaim(ctx(undefined, 'echo-provider'));
        expect(verdict.ok).toBe(false);
    });

    it('honours a custom derivePrefixes', () => {
        const policy = new PrincipalIdPrefixPolicy<AttestedTransport>({
            derivePrefixes: () => ['fixed'],
        });
        expect(policy.authorizeClaim(ctx('docker/whatever', 'fixed'))).toEqual({ ok: true });
        expect(policy.authorizeClaim(ctx('docker/whatever', 'other')).ok).toBe(false);
    });
});
