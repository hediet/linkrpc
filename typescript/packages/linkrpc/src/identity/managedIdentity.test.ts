import { describe, expect, it } from 'vitest';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';
import type { IRequestSender } from '../connection/channel';
import { TransportPair } from '../transport/messageTransport';
import {
    createManagedIdentity,
    InMemoryManagedIdentity as _InMemoryManagedIdentity,
    InMemoryManagedIdentityStorage,
    registerIdentityOnOverlay,
} from './managedIdentity';
import * as crypto from '../crypto/crypto';

// `InMemoryManagedIdentity.generate` no longer takes a crypto provider (it uses
// the package `crypto` module). This adapter keeps the existing call sites,
// which still pass `crypto`, working unchanged.
const InMemoryManagedIdentity = {
    generate: (_crypto?: unknown) => _InMemoryManagedIdentity.generate(),
};

/**
 * Wire two LinkRpcConnections back-to-back: `executor` plays the role of
 * the per-participant root overlay (registers `identity::*`), and `sender`
 * is the raw unsigned outbound sender a participant hands to
 * {@link createManagedIdentity} to bootstrap a managed identity from that
 * overlay.
 */
function _pair(): { executor: LinkRpcConnection; sender: IRequestSender<unknown> } {
    const pair = new TransportPair();
    const executor = LinkRpcConnection.fromTransport(pair.a);
    const sender = JsonRpcChannel.create(pair.b).sender;
    return { executor, sender };
}

describe('managedIdentity', () => {
    it('getPrincipal + getWrapPublicKey round-trip via the overlay', async () => {
        const identity = await InMemoryManagedIdentity.generate(crypto);
        const { executor, sender } = _pair();
        registerIdentityOnOverlay(executor, identity);

        const handle = await createManagedIdentity(sender);
        expect(handle.principal).toBe(identity.principal);
        expect(Array.from(handle.wrapPublicKey)).toEqual(Array.from(identity.wrapPublicKey));
    });

    it('signs via the executor overlay (no recursion)', async () => {
        const identity = await InMemoryManagedIdentity.generate(crypto);
        const { executor, sender } = _pair();
        registerIdentityOnOverlay(executor, identity);

        const handle = await createManagedIdentity(sender);

        // `createManagedIdentity` makes its `identity::*` calls unsigned, so
        // signing through the overlay can't recurse into itself. Ed25519 is
        // deterministic, so the overlay-backed signature must match the one
        // the in-memory identity produces directly.
        const msg = new TextEncoder().encode('sign-me');
        const viaOverlay = await handle.sign(msg);
        const direct = await identity.sign(msg);
        expect(Array.from(viaOverlay)).toEqual(Array.from(direct));
    });

    it('wrap/unwrap round-trip recovers plaintext', async () => {
        const identity = await InMemoryManagedIdentity.generate(crypto);
        const { executor, sender } = _pair();
        registerIdentityOnOverlay(executor, identity);

        const handle = await createManagedIdentity(sender);
        const pt = new TextEncoder().encode('master-key-bytes');
        const blob = await handle.wrap('vault.master.v1', pt);
        const back = await handle.unwrap('vault.master.v1', blob);
        expect(Array.from(back)).toEqual(Array.from(pt));
    });

    it('unwrap fails when domain differs', async () => {
        const identity = await InMemoryManagedIdentity.generate(crypto);
        const { executor, sender } = _pair();
        registerIdentityOnOverlay(executor, identity);

        const handle = await createManagedIdentity(sender);
        const blob = await handle.wrap('a', new TextEncoder().encode('x'));
        await expect(handle.unwrap('b', blob)).rejects.toThrow();
    });

    it("cross-identity isolation: identity B cannot unwrap A's blob", async () => {
        const idA = await InMemoryManagedIdentity.generate(crypto);
        const idB = await InMemoryManagedIdentity.generate(crypto);

        const a = _pair();
        const b = _pair();
        registerIdentityOnOverlay(a.executor, idA);
        registerIdentityOnOverlay(b.executor, idB);
        const handleA = await createManagedIdentity(a.sender);
        const handleB = await createManagedIdentity(b.sender);

        expect(handleA.principal).not.toBe(handleB.principal);
        const blob = await handleA.wrap('d', new TextEncoder().encode('secret'));
        await expect(handleB.unwrap('d', blob)).rejects.toThrow();
    });

    describe('storage', () => {
        it('get returns undefined when the key is missing', async () => {
            const identity = await InMemoryManagedIdentity.generate(crypto);
            const storage = new InMemoryManagedIdentityStorage();
            const { executor, sender } = _pair();
            registerIdentityOnOverlay(executor, identity, storage);
            const handle = await createManagedIdentity(sender);

            expect(await handle.storage.get('missing')).toBeUndefined();
        });

        it('set / get / delete / list round-trip', async () => {
            const identity = await InMemoryManagedIdentity.generate(crypto);
            const storage = new InMemoryManagedIdentityStorage();
            const { executor, sender } = _pair();
            registerIdentityOnOverlay(executor, identity, storage);
            const handle = await createManagedIdentity(sender);

            await handle.storage.set('caps.v1', [{ a: 1 }, { b: 2 }]);
            await handle.storage.set('prefs/theme', 'dark');

            expect(await handle.storage.get<unknown[]>('caps.v1')).toEqual([{ a: 1 }, { b: 2 }]);
            expect(await handle.storage.get<string>('prefs/theme')).toBe('dark');

            const allKeys = (await handle.storage.list()).sort();
            expect(allKeys).toEqual(['caps.v1', 'prefs/theme']);
            expect(await handle.storage.list('prefs/')).toEqual(['prefs/theme']);

            expect(await handle.storage.delete('caps.v1')).toBe(true);
            expect(await handle.storage.delete('caps.v1')).toBe(false);
            expect(await handle.storage.get('caps.v1')).toBeUndefined();
        });

        it('rejects invalid keys', async () => {
            const identity = await InMemoryManagedIdentity.generate(crypto);
            const storage = new InMemoryManagedIdentityStorage();
            const { executor, sender } = _pair();
            registerIdentityOnOverlay(executor, identity, storage);
            const handle = await createManagedIdentity(sender);

            // contains a space — not in the allowed character class.
            await expect(handle.storage.set('bad key', 1)).rejects.toThrow();
            // empty
            await expect(handle.storage.set('', 1)).rejects.toThrow();
            // too long
            await expect(handle.storage.set('a'.repeat(257), 1)).rejects.toThrow();
        });

        it('storage missing on overlay surfaces as method-not-found', async () => {
            const identity = await InMemoryManagedIdentity.generate(crypto);
            const { executor, sender } = _pair();
            // Note: no storage arg passed.
            registerIdentityOnOverlay(executor, identity);
            const handle = await createManagedIdentity(sender);

            await expect(handle.storage.get('any')).rejects.toThrow();
        });
    });
});
