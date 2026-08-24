import { describe, expect, it } from 'vitest';
import type { TrafficEvent, TrafficTransitEvent } from './inspection.interfaces';
import { BoundedTrafficSubscription } from './boundedTrafficSubscription';

function transit(method: string, params?: TrafficTransitEvent['params']): TrafficTransitEvent {
    return {
        type: 'transit',
        ts: 1,
        nodeId: 'node',
        disposition: 'forwarded',
        kind: 'request',
        method,
        params,
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

describe('BoundedTrafficSubscription', () => {
    it('applies method and payload policy before delivery', async () => {
        const events: TrafficEvent[] = [];
        const subscription = new BoundedTrafficSubscription(
            { methodPrefix: 'calc::' },
            async (event) => {
                events.push(event);
            },
            () => undefined,
        );

        subscription.enqueue(transit('other::run', { secret: true }));
        subscription.enqueue(transit('calc::run', { secret: true }));
        await waitFor(() => events.length === 1);

        expect(events[0]).toMatchObject({ type: 'transit', method: 'calc::run' });
        expect(events[0]).not.toHaveProperty('params');
        subscription.dispose();
        await expect(subscription.closed).resolves.toEqual({ delivered: 1, dropped: 0 });
    });

    it('bounds slow consumers and reports overflow', async () => {
        const events: TrafficEvent[] = [];
        let releaseFirst!: () => void;
        const firstBlocked = new Promise<void>((resolve) => releaseFirst = resolve);
        let first = true;
        const subscription = new BoundedTrafficSubscription(
            { maxPayloadBytes: Number.POSITIVE_INFINITY },
            async (event) => {
                events.push(event);
                if (first) {
                    first = false;
                    await firstBlocked;
                }
            },
            () => undefined,
            2,
        );

        subscription.enqueue(transit('first'));
        await waitFor(() => events.length === 1);
        subscription.enqueue(transit('dropped'));
        subscription.enqueue(transit('third'));
        subscription.enqueue(transit('fourth'));
        releaseFirst();
        await waitFor(() => events.length === 4);

        expect(events.map((event) =>
            event.type === 'overflow' ? `overflow:${event.dropped}` : event.method
        )).toEqual(['first', 'overflow:1', 'third', 'fourth']);
        subscription.dispose();
        await expect(subscription.closed).resolves.toEqual({ delivered: 3, dropped: 1 });
    });
});
