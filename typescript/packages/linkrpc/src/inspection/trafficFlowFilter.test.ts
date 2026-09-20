import { describe, expect, it } from 'vitest';
import type { TrafficTransitEvent } from './inspection.interfaces';
import {
    TrafficFlowFilter,
    TrafficWatchFlowTracker,
} from './trafficFlowFilter';

function transit(
    kind: TrafficTransitEvent['kind'],
    requestId: number,
    method?: string,
    params?: TrafficTransitEvent['params'],
): TrafficTransitEvent {
    return {
        type: 'transit',
        timeMs: 1,
        nodeId: 'node',
        out: { edgeId: 'edge', portId: 'port', requestId },
        disposition: 'forwarded',
        kind,
        method,
        params,
    };
}

describe('TrafficFlowFilter', () => {
    it('forgets closed ports without retaining request IDs or unclaimed watches', () => {
        const tracker = new TrafficWatchFlowTracker();
        tracker.accept(transit('request', 7, 'svc::hubrpc.traffic::watch', {
            trafficIgnoreKey: 'closed-watch',
        }));
        tracker.forgetPort('unrelated');
        expect(tracker.accept(transit('stream', 7, '$stream::send'))).toBe(true);
        tracker.forgetPort('port');
        expect(tracker.claim('closed-watch')).toBe(false);
        expect(tracker.accept(transit('stream', 7, '$stream::send'))).toBe(false);
    });

    it('claims a watch request and excludes its correlated stream lifecycle', () => {
        const tracker = new TrafficWatchFlowTracker();
        expect(tracker.accept(transit(
            'request',
            7,
            'svc::hubrpc.traffic::watch',
            { trafficIgnoreKey: 'watch-key' },
        ))).toBe(true);

        expect(tracker.claim('watch-key')).toBe(true);
        expect(tracker.accept(transit('stream', 7, '$stream::send'))).toBe(true);
        expect(tracker.accept(transit('request', 8, 'svc::work::run'))).toBe(false);
        expect(tracker.accept(transit('response', 7))).toBe(true);
        expect(tracker.accept(transit('stream', 7, '$stream::send'))).toBe(false);
    });

    it('learns rewritten endpoints while following an ongoing request', () => {
        const filter = new TrafficFlowFilter({
            focus: { portId: 'far', requestId: 4 },
        });
        const bridge: TrafficTransitEvent = {
            ...transit('stream', 9, '$stream::send'),
            in: { edgeId: 'near', portId: 'near', requestId: 9 },
            out: { edgeId: 'far', portId: 'far', requestId: 4 },
        };

        expect(filter.shouldInclude(bridge)).toBe(true);
        expect(filter.shouldInclude({
            ...transit('response', 9),
            in: { edgeId: 'provider', portId: 'provider', requestId: 10 },
            out: { edgeId: 'near', portId: 'near', requestId: 9 },
        })).toBe(true);
        expect(filter.shouldInclude({
            ...transit('response', 4),
            in: { edgeId: 'near', portId: 'near', requestId: 9 },
            out: { edgeId: 'far', portId: 'far', requestId: 4 },
        })).toBe(true);
        expect(filter.shouldInclude(transit('stream', 9, '$stream::send'))).toBe(false);
    });

    it('merges multi-hop watch transits and retires the flow at its origin', () => {
        const tracker = new TrafficWatchFlowTracker();
        const request = (
            inPort: string,
            inId: number,
            outPort: string,
            outId: number,
        ): TrafficTransitEvent => ({
            ...transit(
                'request',
                outId,
                'svc::hubrpc.traffic::watch',
                { trafficIgnoreKey: 'watch-key' },
            ),
            in: { edgeId: inPort, portId: inPort, requestId: inId },
            out: { edgeId: outPort, portId: outPort, requestId: outId },
        });
        const response = (
            inPort: string,
            inId: number,
            outPort: string,
            outId: number,
        ): TrafficTransitEvent => ({
            ...transit('response', outId),
            in: { edgeId: inPort, portId: inPort, requestId: inId },
            out: { edgeId: outPort, portId: outPort, requestId: outId },
        });

        expect(tracker.accept(request('a', 1, 'b', 2))).toBe(true);
        expect(tracker.accept(request('b', 2, 'c', 3))).toBe(true);
        expect(tracker.accept(request('c', 3, 'd', 4))).toBe(true);
        expect(tracker.accept(response('d', 4, 'c', 3))).toBe(true);
        expect(tracker.accept(response('c', 3, 'b', 2))).toBe(true);
        expect(tracker.accept(response('b', 2, 'a', 1))).toBe(true);
        expect(tracker.accept(transit('stream', 4, '$stream::send'))).toBe(false);
    });

    it('does not retain terminal traffic watch requests', () => {
        const tracker = new TrafficWatchFlowTracker();
        expect(tracker.accept({
            ...transit(
                'request',
                7,
                'missing::hubrpc.traffic::watch',
                { trafficIgnoreKey: 'watch-key' },
            ),
            disposition: 'unroutable',
        })).toBe(true);
        expect(tracker.claim('watch-key')).toBe(false);
        expect(tracker.accept(transit('stream', 7, '$stream::send'))).toBe(false);
    });
});
