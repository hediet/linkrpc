import { describe, expect, it } from 'vitest';
import { TokenIdentityStore } from './tokenIdentityStore';

describe('TokenIdentityStore', () => {
    it('mints a token that redeems once to its binding', () => {
        const store = new TokenIdentityStore();
        const { token } = store.mint({ identitySlot: 'docker/echo' });
        expect(store.redeem(token)).toEqual({ identitySlot: 'docker/echo' });
        // single-use: a second redeem yields nothing.
        expect(store.redeem(token)).toBeUndefined();
    });

    it('binds identity and serviceId namespace as independent axes', () => {
        const store = new TokenIdentityStore();
        const both = store.mint({ identitySlot: 'docker/echo', grantedServiceIdNamespace: 'svc/echo' });
        expect(store.redeem(both.token)).toEqual({
            identitySlot: 'docker/echo',
            grantedServiceIdNamespace: 'svc/echo',
        });

        const nsOnly = store.mint({ grantedServiceIdNamespace: 'svc/only' });
        expect(store.redeem(nsOnly.token)).toEqual({ grantedServiceIdNamespace: 'svc/only' });

        const idOnly = store.mint({ identitySlot: 'docker/only' });
        expect(store.redeem(idOnly.token)).toEqual({ identitySlot: 'docker/only' });
    });

    it('peek is non-consuming; redeem is consuming', () => {
        const store = new TokenIdentityStore();
        const { token } = store.mint({ identitySlot: 'docker/a' });
        expect(store.peek(token)).toBe(true);
        expect(store.peek(token)).toBe(true);
        expect(store.redeem(token)).toEqual({ identitySlot: 'docker/a' });
        expect(store.peek(token)).toBe(false);
    });

    it('supports identity-less tokens (admitted, no binding)', () => {
        const store = new TokenIdentityStore();
        const { token } = store.mint();
        expect(store.peek(token)).toBe(true);
        expect(store.redeem(token)).toEqual({});
    });

    it('rejects unknown tokens', () => {
        const store = new TokenIdentityStore();
        expect(store.peek('nope')).toBe(false);
        expect(store.redeem('nope')).toBeUndefined();
        expect(store.peek(undefined)).toBe(false);
        expect(store.redeem(undefined)).toBeUndefined();
    });

    it('expires tokens after their TTL', () => {
        let now = 1000;
        const store = new TokenIdentityStore({ now: () => now, defaultTtlMs: 100 });
        const { token, expiresAt } = store.mint({ identitySlot: 'docker/x' });
        expect(expiresAt).toBe(1100);
        now = 1099;
        expect(store.peek(token)).toBe(true);
        now = 1100; // expiry is inclusive (<=)
        expect(store.peek(token)).toBe(false);
        expect(store.redeem(token)).toBeUndefined();
    });

    it('honors a per-mint TTL override', () => {
        let now = 0;
        const store = new TokenIdentityStore({ now: () => now, defaultTtlMs: 100 });
        const { token } = store.mint({ identitySlot: 'docker/x' }, 10);
        now = 10;
        expect(store.peek(token)).toBe(false);
    });

    it('prunes expired entries and tracks live size', () => {
        let now = 0;
        const store = new TokenIdentityStore({ now: () => now, defaultTtlMs: 100 });
        store.mint({ identitySlot: 'a' });
        store.mint({ identitySlot: 'b' });
        expect(store.size).toBe(2);
        now = 100;
        expect(store.size).toBe(0);
    });

    it('mints distinct tokens', () => {
        const store = new TokenIdentityStore();
        const a = store.mint({ identitySlot: 'x' }).token;
        const b = store.mint({ identitySlot: 'x' }).token;
        expect(a).not.toBe(b);
    });
});
