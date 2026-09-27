import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSeededMemoryPrincipal, LinkRpcConnection } from '@hediet/linkrpc';
import { createApprovalClient, decodeApprovalRequestId, encodeApprovalRequestId } from './approval';

afterEach(() => vi.unstubAllGlobals());

describe('portable approval request IDs', () => {
    it('round-trips namespaced Unicode IDs without Node globals', () => {
        vi.stubGlobal('Buffer', undefined);
        const id = 'source\u0000request-\u00e9';
        expect(decodeApprovalRequestId(encodeApprovalRequestId(id))).toBe(id);
    });

    it('reports inaccessible root discovery instead of a healthy empty inbox', async () => {
        const connection = new LinkRpcConnection({
            sendRequest: async () => { throw new Error('directory access denied'); },
            sendNotification: async () => {},
            sendRequestWithStream: () => { throw new Error('directory access denied'); },
            close: () => {},
        });
        const principal = await createSeededMemoryPrincipal({ seed: 840 });
        const client = await createApprovalClient({ connection, principal });
        try {
            await expect.poll(() => client.snapshot.get().state).toBe('stale');
            expect(client.snapshot.get().error).toContain('directory access denied');
            expect(client.snapshot.get().requests).toEqual([]);
            await expect(client.refresh()).rejects.toThrow('directory access denied');
        } finally {
            client.dispose();
            connection.close();
        }
    });

    it.each(['', 'ar1_', 'ar1_!', 'ar1_YR'])('rejects a noncanonical ID: %s', (id) => {
        expect(() => decodeApprovalRequestId(id)).toThrow();
    });
});
