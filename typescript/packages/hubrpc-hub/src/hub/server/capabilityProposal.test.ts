import { describe, expect, it } from 'vitest';
import { InMemoryManagedIdentity } from '@vscode/hubrpc';
import { permits, type Call, type CallTarget, type Permission } from '@vscode/hubrpc';
import type { PrincipalId } from '@vscode/hubrpc';
import { CapabilityProposalIssuer, durationToExp } from './capabilityProposal';

const REPO_PERMS: Permission[] = [
    {
        target: { serviceId: { exact: 'github' }, interfaceId: { exact: 'github.repos' }, members: [{ prefix: '' }] },
        canInvoke: true,
    },
];

const TARGET: CallTarget = { serviceId: 'github', interfaceId: 'github.repos', member: 'list' };

function callFor(signer: PrincipalId): Call {
    return { target: TARGET, params: undefined, nonce: 'req', signedAtMs: 0, signer, callHash: '' };
}

/** Accept-all root policy pinned to a single trusted issuer. */
function accept(issuer: PrincipalId) {
    return () => [{ principal: issuer, isPublic: true }];
}

describe('CapabilityProposalIssuer', () => {
    it('propose → signProposal → redeemProposal yields a wieldable cap', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await InMemoryManagedIdentity.generate();
        const issuer = new CapabilityProposalIssuer(admin);

        const cap = issuer.propose({ audience: consumer.principal, permissions: REPO_PERMS });
        const proposal = await issuer.signProposal(cap);
        // The UI renders proposal.capability — it equals the cap we proposed.
        expect(proposal.capability).toBe(cap);

        const signed = await issuer.redeemProposal(proposal);
        const res = await permits(callFor(consumer.principal), [signed], accept(admin.principal), 0);
        expect(res).toMatchObject({ ok: true, rootIssuer: admin.principal });
    });

    it('redeem is one-shot — a second redemption of the same proposal fails', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await InMemoryManagedIdentity.generate();
        const issuer = new CapabilityProposalIssuer(admin);

        const proposal = await issuer.signProposal(
            issuer.propose({ audience: consumer.principal, permissions: REPO_PERMS }),
        );
        await issuer.redeemProposal(proposal);
        await expect(issuer.redeemProposal(proposal)).rejects.toThrow(/already redeemed/);
    });

    it('enforces the bind: matching expectedBind redeems, mismatched/missing fails', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await InMemoryManagedIdentity.generate();
        const issuer = new CapabilityProposalIssuer(admin);

        const proposal = await issuer.signProposal(
            issuer.propose({ audience: consumer.principal, permissions: REPO_PERMS }),
            { bind: { requestId: 'r1' } },
        );

        // Wrong bind → reject.
        await expect(
            issuer.redeemProposal(proposal, { expectedBind: { requestId: 'OTHER' } }),
        ).rejects.toThrow(/bind does not match/);

        // Missing expectedBind on a bound proposal → reject.
        await expect(issuer.redeemProposal(proposal)).rejects.toThrow(/no expectedBind/);

        // Correct bind → ok.
        const signed = await issuer.redeemProposal(proposal, { expectedBind: { requestId: 'r1' } });
        expect(signed.audience).toBe(consumer.principal);
    });

    it('rejects a proposal whose capability was tampered after signing', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await InMemoryManagedIdentity.generate();
        const issuer = new CapabilityProposalIssuer(admin);

        const proposal = await issuer.signProposal(
            issuer.propose({ audience: consumer.principal, permissions: REPO_PERMS }),
        );
        const tampered = {
            $hubData: proposal.$hubData,
            capability: {
                ...proposal.capability,
                permissions: [
                    {
                        target: { serviceId: { prefix: '' }, interfaceId: { prefix: '' }, members: [{ prefix: '' }] },
                        canInvoke: true,
                    },
                ],
            },
        };
        await expect(issuer.redeemProposal(tampered)).rejects.toThrow(/does not match the signed preview/);
    });

    it('refuses to sign a capability not produced by propose()', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await InMemoryManagedIdentity.generate();
        const issuer = new CapabilityProposalIssuer(admin);
        const fabricated = {
            issuer: admin.principal,
            audience: consumer.principal,
            permissions: REPO_PERMS,
            nonce: 'x',
        };
        await expect(issuer.signProposal(fabricated as never)).rejects.toThrow(/not produced by propose/);
    });

    it('mint() produces a wieldable cap directly', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await InMemoryManagedIdentity.generate();
        const issuer = new CapabilityProposalIssuer(admin);

        const signed = await issuer.mint({ audience: consumer.principal, permissions: REPO_PERMS });
        const res = await permits(callFor(consumer.principal), [signed], accept(admin.principal), 0);
        expect(res.ok).toBe(true);
    });
});

describe('durationToExp', () => {
    it('returns increasing horizons for once/shortLived < longLived, and undefined for persistent', () => {
        const once = durationToExp('once');
        const shortLived = durationToExp('shortLived');
        const longLived = durationToExp('longLived');
        const persistent = durationToExp('persistent');
        expect(once).toBeDefined();
        expect(shortLived).toBeDefined();
        expect(once!).toBeLessThan(longLived!);
        expect(shortLived!).toBeLessThan(longLived!);
        expect(persistent).toBeUndefined();
    });

    it('defaults to the short TTL when no duration is supplied', () => {
        expect(durationToExp(undefined)).toBeDefined();
    });
});
