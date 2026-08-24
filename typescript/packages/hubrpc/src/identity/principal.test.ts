import { describe, expect, it } from 'vitest';
import { issueCapability, type Permission } from './capability';
import { KeypairSigningIdentity } from './identity';
import { Principal } from './principal';

describe('Principal', () => {
    it('creates a principal from a signing identity and capabilities', async () => {
        const issuer = await KeypairSigningIdentity.generateNew();
        const identity = await KeypairSigningIdentity.generateNew();
        const permission: Permission = {
            target: {
                serviceId: { prefix: 'notes' },
                interfaceId: { prefix: '' },
                members: [{ prefix: 'read' }],
            },
            canInvoke: true,
        };
        const capability = await issueCapability(issuer, {
            audience: identity.publicSigningIdentity,
            permissions: [permission],
        });

        const principal = await Principal.create(identity, [capability]);

        expect(principal.id).toBe(identity.publicSigningIdentity.principal);
        expect(principal.capBag.capabilities).toEqual([capability]);
    });
});
