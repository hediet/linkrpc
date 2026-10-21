import { InspectionHost, type TrafficTransitEvent } from '@hediet/linkrpc/inspection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CallLogConfig, CallLogConfigSchema } from './callLogConfig';
import type { CallRecord } from './callRecord';
import { CallRecorder } from './callRecorder';

const METHOD = 'hub/a::test.echo::echo';

function transit(timeMs: number, over: Partial<TrafficTransitEvent>): TrafficTransitEvent {
    return { type: 'transit', timeMs, nodeId: 'hub', disposition: 'forwarded', kind: 'request', method: METHOD, ...over };
}

const request = (timeMs: number, id: number, params: unknown = { text: 'hi' }) => transit(timeMs, {
    params,
    in: { edgeId: 'hediet/devbox', portId: 'p-in', requestId: id },
    out: { edgeId: 'hub/a', portId: 'p-out', requestId: 100 + id },
});
const response = (timeMs: number, id: number, over: Partial<TrafficTransitEvent>) => transit(timeMs, {
    kind: 'response', method: undefined,
    in: { edgeId: 'hub/a', portId: 'p-out', requestId: 100 + id },
    out: { edgeId: 'hediet/devbox', portId: 'p-in', requestId: id },
    ...over,
});

describe('CallRecorder', () => {
    let host: InspectionHost;
    let config: CallLogConfig;
    let records: CallRecord[];
    let recorder: CallRecorder;

    beforeEach(() => {
        vi.useFakeTimers();
        host = new InspectionHost({ nodeId: 'hub', kind: 'hub' });
        config = CallLogConfigSchema.parse({ level: 'info' });
        records = [];
        recorder = new CallRecorder({ inspection: host, config: () => config, onRecord: r => records.push(r), ownMethodPrefix: 'hub/daemon::linkrpc.logging::' });
    });

    afterEach(() => {
        recorder.dispose();
        host.dispose();
        vi.useRealTimers();
    });

    const summary = () => records.map(({ id, status, level, from, to, principal, params, error }) => ({
        id: id.replace(/^[0-9a-f]+-/, ''), status, level, from: from.label, to: to?.label, principal, params, error,
    }));

    it('writes a pending record for a slow call and the final one under the same id', () => {
        host.publishTransit(request(Date.now(), 1, { text: 'hi', $hubrpc: { method: METHOD, nonce: 'n', signedAtMs: 0, principal: 'id:key:devbox' }, $hubrpcSignature: {} }));
        vi.advanceTimersByTime(100);
        host.publishTransit(response(Date.now(), 1, { result: 'ok' }));
        vi.advanceTimersByTime(100);
        expect(summary()).toMatchInlineSnapshot(`
          [
            {
              "error": undefined,
              "from": "hediet/devbox",
              "id": "flow1",
              "level": "info",
              "params": {
                "text": "hi",
              },
              "principal": "id:key:devbox",
              "status": "pending",
              "to": "hub/a",
            },
            {
              "error": undefined,
              "from": "hediet/devbox",
              "id": "flow1",
              "level": "info",
              "params": {
                "text": "hi",
              },
              "principal": "id:key:devbox",
              "status": "completed",
              "to": "hub/a",
            },
          ]
        `);
    });

    it('records only failures at the error level and skips calls the hub originates', () => {
        config = CallLogConfigSchema.parse({ level: 'error' });
        host.publishTransit(request(Date.now(), 1));
        host.publishTransit(response(Date.now(), 1, { result: 'ok' }));
        host.publishTransit(request(Date.now(), 2));
        host.publishTransit(response(Date.now(), 2, { error: { code: -32601, message: 'no such method' } }));
        host.publishTransit(transit(Date.now(), { kind: 'notification', out: { edgeId: 'hub/a', portId: 'p-out' } }));
        vi.advanceTimersByTime(100);
        expect(summary().map(({ id, status, level }) => `${id}:${status}:${level}`)).toEqual(['flow2:failed:error']);
    });

    it('never records the call log content it serves: no results of its own calls, no stream frames', () => {
        config = CallLogConfigSchema.parse({ level: 'trace', payloads: { mode: 'full' } });
        host.publishTransit(transit(Date.now(), {
            method: 'hub/daemon::linkrpc.logging::getLogSnapshot',
            params: {},
            in: { edgeId: 'e1', portId: 'p-in', requestId: 2 },
            out: { edgeId: 'hub/daemon', portId: 'p-daemon', requestId: 8 },
        }));
        host.publishTransit(transit(Date.now(), {
            kind: 'response', method: undefined, result: { document: { entries: ['earlier records'] } },
            in: { edgeId: 'hub/daemon', portId: 'p-daemon', requestId: 8 },
            out: { edgeId: 'e1', portId: 'p-in', requestId: 2 },
        }));
        vi.advanceTimersByTime(100);
        expect(records.map(({ status, result, resultBytes }) => ({ status, result, resultBytes })))
            .toEqual([{ status: 'completed', result: undefined, resultBytes: 44 }]);
        records.length = 0;

        const watch = 'hub/daemon::linkrpc.logging::watchLog';
        host.publishTransit(transit(Date.now(), {
            method: watch,
            in: { edgeId: 'e1', portId: 'p-in', requestId: 1 },
            out: { edgeId: 'hub/daemon', portId: 'p-daemon', requestId: 7 },
        }));
        vi.advanceTimersByTime(2_000);
        host.publishTransit(transit(Date.now(), {
            kind: 'stream', method: '$stream::send', params: { requestId: 7, dir: 'toCaller', payload: { type: 'patch' } },
            in: { edgeId: 'hub/daemon', portId: 'p-daemon', requestId: 7 },
            out: { edgeId: 'e1', portId: 'p-in', requestId: 1 },
        }));
        vi.advanceTimersByTime(100);
        expect(records.map(r => `${r.kind}:${r.status}`)).toEqual(['request:pending']);
    });
});
