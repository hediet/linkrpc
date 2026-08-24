import { describe, expect, it, vi } from 'vitest';
import type { ConnectableChannel } from './channelConnector';
import { ChannelConnector } from './channelConnector';

class ClosingChannel {
    private readonly _listeners = new Set<() => void>();

    public onClose(listener: () => void): { dispose(): void; } {
        this._listeners.add(listener);
        return { dispose: () => this._listeners.delete(listener) };
    }

    public close(): void {
        for (const listener of this._listeners) listener();
        this._listeners.clear();
    }
}

describe('ChannelConnector', () => {
    it('backs off when a newly opened channel closes during initialization', async () => {
        const openedAt: number[] = [];
        const connector = ChannelConnector.expBackoff(
            async () => {
                openedAt.push(Date.now());
                return new ClosingChannel() as unknown as ConnectableChannel;
            },
            { initialBackoffMs: 20, maxBackoffMs: 40 },
        );

        const handle = connector.keepConnected(async ({ channel }) => {
            channel.close?.();
            throw new Error('closed during initialization');
        });

        await new Promise((resolve) => setTimeout(resolve, 55));
        handle.stop();
        await handle.done;

        expect(openedAt.length).toBeGreaterThanOrEqual(2);
        expect(openedAt.length).toBeLessThanOrEqual(3);
        expect(openedAt[1]! - openedAt[0]!).toBeGreaterThanOrEqual(15);
    });

    it('caps the default reconnect delay at one minute', async () => {
        vi.useFakeTimers();
        let openCount = 0;
        const connector = ChannelConnector.expBackoff(async () => {
            openCount++;
            return new ClosingChannel() as unknown as ConnectableChannel;
        });
        const handle = connector.keepConnected(async ({ channel }) => {
            channel.close?.();
            throw new Error('closed during initialization');
        });

        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(openCount).toBe(1);
            for (const delayMs of [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
                await vi.advanceTimersByTimeAsync(delayMs);
                expect(openCount).toBeGreaterThanOrEqual(2);
            }
            const beforeCeilingRetry = openCount;
            await vi.advanceTimersByTimeAsync(59_999);
            expect(openCount).toBe(beforeCeilingRetry);
            await vi.advanceTimersByTimeAsync(1);
            expect(openCount).toBe(beforeCeilingRetry + 1);
        } finally {
            handle.stop();
            await vi.runAllTimersAsync();
            await handle.done;
            vi.useRealTimers();
        }
    });
});
