import {
    CapBag,
    createSeededMemoryPrincipal,
    createSeededSigningIdentity,
    issueCapability,
    type IRequestSender,
    Principal,
    type SigningCallCtx,
} from '@hediet/linkrpc';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import type { CliSigning } from './connect';
import * as principalResolution from './principal';
import {
    requestReflectionAccess,
    requestTopologyAccess,
    setupSigning,
    type SigningSession,
} from './hubSigning';

describe('sign-time delegated capability cache', () => {
    it.each([
        { name: 'complete chain', includeParent: true, expired: false, tenant: 'allowed', negotiate: false },
        { name: 'missing parent', includeParent: false, expired: false, tenant: 'allowed', negotiate: true },
        { name: 'expired parent', includeParent: true, expired: true, tenant: 'allowed', negotiate: true },
        { name: 'parent parameter restriction', includeParent: true, expired: false, tenant: 'denied', negotiate: true },
    ])('checks $name before skipping access negotiation', async ({ includeParent, expired, tenant, negotiate }) => {
        const root = await createSeededMemoryPrincipal({ seed: 820 });
        const delegate = await createSeededMemoryPrincipal({ seed: 821 });
        const consumer = await createSeededMemoryPrincipal({ seed: 822 });
        const target = {
            serviceId: { exact: 'calendar' },
            interfaceId: { exact: 'events' },
            members: [{ exact: 'list' }],
        };
        const parent = await issueCapability(root.identity, {
            audience: delegate.identity.publicSigningIdentity,
            permissions: [{ target, canDelegate: true, params: { tenant: { exact: 'allowed' } } }],
            expiresAtMs: Date.now() + (expired ? -1000 : 60_000),
        });
        const child = await issueCapability(delegate.identity, {
            audience: consumer.identity.publicSigningIdentity,
            parent,
            permissions: [{ target, canInvoke: true }],
        });
        await consumer.capBag.add(child, ...(includeParent ? [parent] : []));
        const resolve = vi.spyOn(principalResolution, 'resolvePrincipal').mockResolvedValue({
            principal: consumer,
            source: { kind: 'user', id: 'test' },
        });
        onTestFinished(() => resolve.mockRestore());
        const sendRequest = vi.fn<IRequestSender<SigningCallCtx>['sendRequest']>()
            .mockResolvedValue({ status: 'denied' });
        const channel: IRequestSender<SigningCallCtx> = {
            sendRequest,
            sendNotification: async () => {},
            sendRequestWithStream: () => { throw new Error('unexpected stream'); },
            close: () => {},
        };
        const signing: CliSigning = {};
        await setupSigning(channel, signing, { kind: 'user', id: 'test' }, { negotiateHubCaps: true });
        await signing.capProvider!({
            method: 'calendar::events::list',
            signer: consumer.id,
            params: { tenant },
            nonce: 'test-nonce',
            signedAtMs: Date.now(),
        });
        expect(sendRequest).toHaveBeenCalledTimes(negotiate ? 1 : 0);
    });
});

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
