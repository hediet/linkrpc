import { describe, expect, it } from 'vitest';
import { InMemoryManagedIdentity } from '@hediet/linkrpc';
import { permits, type Call, type CallTarget } from '@hediet/linkrpc';
import type { PrincipalId } from '@hediet/linkrpc';
import { mintCapability } from './mintCapability';

function makeCall(target: CallTarget, signer: PrincipalId): Call {
    return { target, params: undefined, nonce: 'req', signedAtMs: 0, signer, callHash: '' };
}

/** Accept-all root policy pinned to a single trusted issuer. */
function accept(issuer: PrincipalId) {
    return () => [{ principal: issuer, isPublic: true }];
}

describe('mintCapability', () => {
    it('mints a capability the consumer can wield for a matching call', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await InMemoryManagedIdentity.generate();

        const signed = await mintCapability({
            issuer: admin,
            audience: consumer.principal,
            permissions: [
                {
                    target: {
                        serviceId: { exact: 'github' },
                        interfaceId: { exact: 'github.repos' },
                        members: [{ prefix: '' }],
                    },
                    canInvoke: true,
                },
            ],
        });

        expect(signed.issuer).toBe(admin.principal);
        expect(signed.audience).toBe(consumer.principal);
        expect(signed.nonce).toBeTruthy();

        const target: CallTarget = { serviceId: 'github', interfaceId: 'github.repos', member: 'list' };
        const res = await permits(makeCall(target, consumer.principal), [signed], accept(admin.principal), 0);
        expect(res).toMatchObject({ ok: true, rootIssuer: admin.principal });
    });

    it('rejects a call outside the granted permission', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await InMemoryManagedIdentity.generate();

        const signed = await mintCapability({
            issuer: admin,
            audience: consumer.principal,
            permissions: [
                {
                    target: {
                        serviceId: { exact: 'github' },
                        interfaceId: { exact: 'github.repos' },
                        members: [{ exact: 'list' }],
                    },
                    canInvoke: true,
                },
            ],
        });

        const target: CallTarget = { serviceId: 'github', interfaceId: 'github.repos', member: 'delete' };
        const res = await permits(makeCall(target, consumer.principal), [signed], accept(admin.principal), 0);
        expect(res.ok).toBe(false);
    });

    it('honours an explicit nonce and expiry', async () => {
        const admin = await InMemoryManagedIdentity.generate();
        const consumer = await InMemoryManagedIdentity.generate();

        const signed = await mintCapability({
            issuer: admin,
            audience: consumer.principal,
            permissions: [
                { target: { serviceId: { exact: 'svc' }, interfaceId: { exact: 'x' }, members: [{ prefix: '' }] }, canInvoke: true },
            ],
            nonce: 'fixed-nonce',
            expiresAtMs: 9999999999,
        });

        expect(signed.nonce).toBe('fixed-nonce');
        expect(signed.expiresAtMs).toBe(9999999999);
    });
});
