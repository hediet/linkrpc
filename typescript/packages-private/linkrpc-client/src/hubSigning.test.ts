import {
    CapBag,
    createSeededSigningIdentity,
    issueCapability,
    Principal,
} from '@hediet/linkrpc';
import { describe, expect, it, vi } from 'vitest';
import {
    requestReflectionAccess,
    requestTopologyAccess,
    type SigningSession,
} from './hubSigning';

describe('requestReflectionAccess', () => {
    it('reuses a hydrated persistent reflection capability', async () => {
        const identity = await createSeededSigningIdentity({ seed: 1 });
        const capBag = await CapBag.load();
        await capBag.add(await issueCapability(identity, {
            audience: identity.publicSigningIdentity,
            permissions: ['hubrpc.directory', 'hubrpc.schemas', 'hubrpc.defaults'].map(
                (interfaceId) => ({
                    target: {
                        serviceId: { prefix: '' },
                        interfaceId: { exact: interfaceId },
                        members: [{ prefix: '' }],
                    },
                    canInvoke: true,
                }),
            ),
        }));
        const principal = new Principal(identity, capBag);
        const requestAccess = vi.fn<SigningSession['requestAccess']>();
        const session: SigningSession = {
            principal,
            principalSource: { kind: 'user', id: 'test' },
            hubAccessMethod: 'hubAccess::requestAccess',
            listGrants: () => capBag.capabilities,
            requestAccess,
        };

        await expect(requestReflectionAccess(session)).resolves.toBe('granted');
        expect(requestAccess).not.toHaveBeenCalled();
    });

    describe('requestTopologyAccess', () => {
        it('batches wildcard directory and topology access for discovery', async () => {
            const identity = await createSeededSigningIdentity({ seed: 3 });
            const principal = new Principal(identity, await CapBag.load());
            const requestAccess = vi.fn<SigningSession['requestAccess']>()
                .mockResolvedValue({ status: 'granted', capabilities: [], addedDurable: 0 });
            const session: SigningSession = {
                principal,
                principalSource: { kind: 'user', id: 'test' },
                hubAccessMethod: 'hubAccess::requestAccess',
                listGrants: () => principal.capBag.capabilities,
                requestAccess,
            };

            await expect(requestTopologyAccess(session)).resolves.toBe('granted');
            expect(requestAccess).toHaveBeenCalledOnce();
            expect(requestAccess.mock.calls[0][0]).toMatchObject({
                permissions: [
                    {
                        target: {
                            serviceId: { prefix: '' },
                            interfaceId: { exact: 'hubrpc.directory' },
                            members: [{ prefix: '' }],
                        },
                        canInvoke: true,
                    },
                    {
                        target: {
                            serviceId: { prefix: '' },
                            interfaceId: { exact: 'hubrpc.topology' },
                            members: [{ prefix: '' }],
                        },
                        canInvoke: true,
                    },
                ],
            });
        });

        it('batches only the unique explicit topology sources', async () => {
            const identity = await createSeededSigningIdentity({ seed: 4 });
            const principal = new Principal(identity, await CapBag.load());
            const requestAccess = vi.fn<SigningSession['requestAccess']>()
                .mockResolvedValue({ status: 'granted', capabilities: [], addedDurable: 0 });
            const session: SigningSession = {
                principal,
                principalSource: { kind: 'user', id: 'test' },
                hubAccessMethod: 'hubAccess::requestAccess',
                listGrants: () => principal.capBag.capabilities,
                requestAccess,
            };

            await requestTopologyAccess(session, {
                sourceServiceIds: ['two', 'one', 'two'],
            });

            expect(requestAccess.mock.calls[0][0].permissions).toEqual([
                {
                    target: {
                        serviceId: { exact: 'one' },
                        interfaceId: { exact: 'hubrpc.topology' },
                        members: [{ prefix: '' }],
                    },
                    canInvoke: true,
                },
                {
                    target: {
                        serviceId: { exact: 'two' },
                        interfaceId: { exact: 'hubrpc.topology' },
                        members: [{ prefix: '' }],
                    },
                    canInvoke: true,
                },
            ]);
        });
    });

    it('requests access when one reflection interface is not covered', async () => {
        const identity = await createSeededSigningIdentity({ seed: 2 });
        const principal = new Principal(identity, await CapBag.load());
        const requestAccess = vi.fn<SigningSession['requestAccess']>()
            .mockResolvedValue({ status: 'granted', capabilities: [], addedDurable: 0 });
        const session: SigningSession = {
            principal,
            principalSource: { kind: 'user', id: 'test' },
            hubAccessMethod: 'hubAccess::requestAccess',
            listGrants: () => principal.capBag.capabilities,
            requestAccess,
        };

        await expect(requestReflectionAccess(session)).resolves.toBe('granted');
        expect(requestAccess).toHaveBeenCalledOnce();
    });
});
