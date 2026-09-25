import { describe, expect, it } from 'vitest';
import { JsonRpcPeer } from './jsonRpcPeer';
import { JsonRpcTransportPair } from './transport';
import type { JsonRpcConnectionCloseReason } from './interface';

describe('JsonRpcPeer cancellation and closing', () => {
    it('rejects an already-aborted request without sending a frame', async () => {
        const transport = new JsonRpcTransportPair();
        const peer = new JsonRpcPeer(transport.a);
        const received: unknown[] = [];
        transport.b.onMessage((frame) => received.push(frame));
        const controller = new AbortController();
        controller.abort();

        await expect(peer.request('never', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(received).toEqual([]);
        await peer.close();
    });

    it.each(['ttl', 'disposed', 'cancelled', 'closed'] as const)(
        'preserves local %s reason when closing a synchronously notifying transport',
        async (reason: JsonRpcConnectionCloseReason) => {
            const transport = new JsonRpcTransportPair();
            const peer = new JsonRpcPeer(transport.a);
            await peer.close(reason);
            await expect(peer.closed).resolves.toBe(reason);
            expect(transport.a.closed).toBe(true);
        },
    );
});
