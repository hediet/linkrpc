import { describe, expect, it, vi } from 'vitest';
import type { JsonRpcMessage } from '../protocol/jsonRpc';
import { TransportPair } from '../transport/messageTransport';
import { JsonRpcChannel } from './jsonRpcChannel';

describe('JsonRpcChannel streaming call lifecycle', () => {
    it('can cancel remotely and dispose local bookkeeping independently', async () => {
        vi.useFakeTimers();
        const pair = new TransportPair();
        const sent: JsonRpcMessage[] = [];
        pair.b.setListener((message) => sent.push(message));
        const { channel, close } = JsonRpcChannel.createWithClose(pair.a);

        try {
            const call = channel.sender.sendRequestWithStream('jobs::run', {});
            expect(sent).toHaveLength(1);

            call.cancel('task cancelled');
            expect(sent).toHaveLength(2);

            call.dispose?.('task cancelled');
            await expect(call.result).rejects.toThrow('task cancelled');

            const sentAfterDispose = sent.length;
            await vi.advanceTimersByTimeAsync(10 * 60_000);
            expect(sent).toHaveLength(sentAfterDispose);
        } finally {
            close();
            pair.b.dispose();
            vi.useRealTimers();
        }
    });
});
