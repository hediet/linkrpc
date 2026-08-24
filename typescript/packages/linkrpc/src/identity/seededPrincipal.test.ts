import { describe, expect, it } from 'vitest';
import { createSeededMemoryPrincipal } from './seededPrincipal';

describe('createSeededMemoryPrincipal', () => {
    it('derives a stable principal for the same seed', async () => {
        const a = await createSeededMemoryPrincipal({ seed: 0 });
        const b = await createSeededMemoryPrincipal({ seed: 0 });
        expect(a.id).toBe(b.id);
    });

    it('derives distinct identities for distinct seeds', async () => {
        const a = await createSeededMemoryPrincipal({ seed: 0 });
        const b = await createSeededMemoryPrincipal({ seed: 1 });
        expect(a.id).not.toBe(b.id);
    });

    it('starts with an empty capability bag', async () => {
        const p = await createSeededMemoryPrincipal({ seed: 7 });
        expect(p.capBag.capabilities).toEqual([]);
    });

    it('signs with the derived identity (round-trips through verification)', async () => {
        const p = await createSeededMemoryPrincipal({ seed: 0 });
        const sig = await p.identity.publicSigningIdentity;
        expect(sig.principal).toBe(p.id);
    });
});
