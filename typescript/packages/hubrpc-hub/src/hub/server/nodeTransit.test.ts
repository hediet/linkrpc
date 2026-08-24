import { describe, expect, it, vi } from 'vitest';
import {
    type FlowSummary,
    formatFlowSummary,
    type NodeTransit,
    tapTransport,
    TrafficFlowAggregator,
    TransitAggregator,
} from './nodeTransit';
import type { IMessageTransport } from '@vscode/hubrpc';
import type { JsonRpcMessage } from '@vscode/hubrpc';
import type { TrafficTransitEvent } from '@vscode/hubrpc/hub/common';

/** Deterministic clock + timer wheel for driving the aggregator's debounce. */
class FakeClock {
    public time = 0;
    private readonly _timers = new Map<number, { at: number; cb: () => void; }>();
    private _next = 1;

    public readonly now = (): number => this.time;

    public readonly setTimer = (cb: () => void, ms: number): unknown => {
        const id = this._next++;
        this._timers.set(id, { at: this.time + ms, cb });
        return id;
    };

    public readonly clearTimer = (h: unknown): void => {
        this._timers.delete(h as number);
    };

    /** Advance time, firing due timers in chronological order. */
    public advance(ms: number): void {
        const target = this.time + ms;
        for (; ;) {
            let nextId: number | undefined;
            let next: { at: number; cb: () => void; } | undefined;
            for (const [id, t] of this._timers) {
                if (t.at <= target && (next === undefined || t.at < next.at)) {
                    next = t;
                    nextId = id;
                }
            }
            if (next === undefined || nextId === undefined) break;
            this.time = next.at;
            this._timers.delete(nextId);
            next.cb();
        }
        this.time = target;
    }
}

function makeAgg(clock: FakeClock, flushDelayMs = 50): { agg: TransitAggregator; flows: FlowSummary[]; } {
    const flows: FlowSummary[] = [];
    const agg = new TransitAggregator({
        onFlow: (s) => flows.push(s),
        flushDelayMs,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    return { agg, flows };
}

const req = (over: Partial<NodeTransit> = {}): NodeTransit => ({
    ts: 0,
    nodeId: 'hub',
    in: { edgeId: 'e1', requestId: 1000 },
    out: { edgeId: 'e2', requestId: 1 },
    disposition: 'forwarded',
    kind: 'request',
    method: 'calc::add',
    params: { a: 1, b: 2 },
    ...over,
});

const res = (over: Partial<NodeTransit> = {}): NodeTransit => ({
    ts: 0,
    nodeId: 'hub',
    in: { edgeId: 'e2', requestId: 1 },
    out: { edgeId: 'e1', requestId: 1000 },
    disposition: 'forwarded',
    kind: 'response',
    method: 'calc::add',
    result: 3,
    ...over,
});

const strm = (over: Partial<NodeTransit> = {}): NodeTransit => ({
    ts: 0,
    nodeId: 'hub',
    in: { edgeId: 'e2', requestId: 1 },
    out: { edgeId: 'e1', requestId: 1000 },
    disposition: 'forwarded',
    kind: 'stream',
    method: '$stream::send',
    params: { requestId: 1, dir: 'toCaller', payload: { chunk: 'hi' } },
    ...over,
});

const trafficTransit = (
    over: Partial<TrafficTransitEvent> & Pick<TrafficTransitEvent, 'kind' | 'nodeId'>,
): TrafficTransitEvent => ({
    type: 'transit',
    ts: 0,
    disposition: 'forwarded',
    method: 'calc::math::add',
    ...over,
});

describe('TransitAggregator', () => {
    it('coalesces a fast request+response into a single completed summary', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        agg.add(req({ ts: 0 }));
        agg.add(res({ ts: 5 }));
        clock.advance(60);

        expect(flows).toHaveLength(1);
        const s = flows[0];
        expect(s.status).toBe('completed');
        expect(s.partial).toBe(false);
        expect(s.method).toBe('calc::add');
        expect(s.params).toEqual({ a: 1, b: 2 });
        expect(s.result).toBe(3);
        expect(s.path).toEqual(['e1', 'hub', 'e2']);
        expect(s.durationMs).toBe(5);
    });

    describe('TrafficFlowAggregator', () => {
        it('coalesces adjacent inspection nodes using shared topology ports', () => {
            const clock = new FakeClock();
            const summaries: FlowSummary[] = [];
            const frontend = new TrafficFlowAggregator({
                onFlow: (summary) => summaries.push(summary),
                now: clock.now,
                setTimer: clock.setTimer,
                clearTimer: clock.clearTimer,
            });
            frontend.setPortLabel('shared', 'uplink');

            frontend.add(trafficTransit({
                nodeId: 'overlay',
                kind: 'request',
                params: { a: 1, b: 2 },
                in: { edgeId: 'app', portId: 'app', requestId: 100 },
                out: { edgeId: 'uplink', portId: 'shared', requestId: 100 },
            }));
            frontend.add(trafficTransit({
                nodeId: 'hub',
                kind: 'request',
                params: { a: 1, b: 2 },
                in: { edgeId: 'overlay', portId: 'shared', requestId: 100 },
                out: { edgeId: 'target', portId: 'target', requestId: 1 },
            }));
            frontend.add(trafficTransit({
                ts: 5,
                nodeId: 'hub',
                kind: 'response',
                result: 3,
                in: { edgeId: 'target', portId: 'target', requestId: 1 },
                out: { edgeId: 'overlay', portId: 'shared', requestId: 100 },
            }));
            clock.advance(60);

            expect(summaries).toHaveLength(1);
            expect(summaries[0]).toMatchObject({
                kind: 'request',
                method: 'calc::math::add',
                params: { a: 1, b: 2 },
                result: 3,
                status: 'completed',
                startTs: 0,
                endTs: 5,
                durationMs: 5,
                path: ['app', 'overlay', 'uplink', 'hub', 'target'],
                partial: false,
            });
            frontend.dispose();
        });
    });

    it('folds stream transits into the owning request flow, in arrival order', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        agg.add(req({ ts: 0 }));
        agg.add(strm({ ts: 2, params: { requestId: 1, dir: 'toCaller', payload: { chunk: 'a' } } }));
        agg.add(strm({
            ts: 4,
            in: { edgeId: 'e1', requestId: 1000 },
            out: { edgeId: 'e2', requestId: 1 },
            params: { requestId: 1, dir: 'toCallee', control: { type: 'cancel' } },
        }));
        agg.add(res({ ts: 6 }));
        clock.advance(60);

        expect(flows).toHaveLength(1);
        const s = flows[0];
        expect(s.status).toBe('completed');
        // Stream transits don't pollute the request/response path.
        expect(s.path).toEqual(['e1', 'hub', 'e2']);
        expect(s.stream).toHaveLength(2);
        expect(s.stream![0]).toMatchObject({ ts: 2, dir: 'toCaller', payload: { chunk: 'a' } });
        expect(s.stream![1]).toMatchObject({ ts: 4, dir: 'toCallee', control: 'cancel' });
    });

    it('omits stream when none were captured (gate off)', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        agg.add(req({ ts: 0 }));
        agg.add(res({ ts: 5 }));
        clock.advance(60);

        expect(flows[0].stream).toBeUndefined();
    });

    it('logs stream frames independently once past the retain window', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock); // streamRetainMs defaults to 1000

        agg.add(req({ ts: 0 }));
        agg.add(strm({ ts: 500, params: { requestId: 1, dir: 'toCaller', payload: { chunk: 'early' } } }));
        // Past the 1s window: emitted immediately as its own summary, not buffered.
        agg.add(strm({ ts: 1500, params: { requestId: 1, dir: 'toCaller', payload: { chunk: 'late' } } }));

        const standalone = flows.filter((f) => f.kind === 'stream');
        expect(standalone).toHaveLength(1);
        expect(standalone[0].method).toBe('calc::add'); // correlated to its request
        expect(standalone[0].stream![0].payload).toEqual({ chunk: 'late' });
        expect(standalone[0].durationMs).toBe(1500); // offset from request start
        expect(standalone[0].path).toEqual(['e2', 'hub', 'e1']);

        agg.add(res({ ts: 1600 }));
        clock.advance(60);

        const settled = flows.find((f) => f.kind !== 'stream');
        expect(settled!.status).toBe('completed');
        // Only the within-window frame folded into the request flow.
        expect(settled!.stream).toHaveLength(1);
        expect(settled!.stream![0].payload).toEqual({ chunk: 'early' });
    });

    it('logs an orphan stream frame independently when no request owns it', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        agg.add(strm({ ts: 100 }));

        expect(flows).toHaveLength(1);
        expect(flows[0].kind).toBe('stream');
        expect(flows[0].method).toBeUndefined();
        expect(flows[0].durationMs).toBe(0);
    });

    it('reports a slow request partial, then again on completion', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        agg.add(req({ ts: 0 }));
        clock.advance(60); // quiet period elapses with no response

        expect(flows).toHaveLength(1);
        expect(flows[0].status).toBe('pending');
        expect(flows[0].partial).toBe(true);

        agg.add(res({ ts: 200 }));
        clock.advance(60);

        expect(flows).toHaveLength(2);
        expect(flows[1].status).toBe('completed');
        expect(flows[1].partial).toBe(false);
        expect(flows[1].result).toBe(3);
    });

    it('maps an error response to a failed flow', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        agg.add(req({ ts: 0 }));
        agg.add(res({ ts: 5, result: undefined, error: { code: -32000, message: 'boom' } }));
        clock.advance(60);

        expect(flows).toHaveLength(1);
        expect(flows[0].status).toBe('failed');
        expect(flows[0].error).toEqual({ code: -32000, message: 'boom' });
    });

    it('reports an unroutable request as unroutable', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        agg.add(req({ ts: 0, out: undefined, disposition: 'unroutable' }));
        clock.advance(60);

        expect(flows).toHaveLength(1);
        expect(flows[0].status).toBe('unroutable');
    });

    it('correlates a notification across nodes by edge+method+params (no request id)', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        // Same logical event seen at two nodes; they share the edge `mid`.
        agg.add({
            ts: 0,
            nodeId: 'split',
            in: { edgeId: 'p' },
            out: { edgeId: 'mid' },
            disposition: 'forwarded',
            kind: 'notification',
            method: 'evt::changed',
            params: { file: 'a.ts' },
        });
        agg.add({
            ts: 1,
            nodeId: 'hub',
            in: { edgeId: 'mid' },
            out: { edgeId: 'target' },
            disposition: 'forwarded',
            kind: 'notification',
            method: 'evt::changed',
            params: { file: 'a.ts' },
        });
        clock.advance(60);

        expect(flows).toHaveLength(1);
        const s = flows[0];
        expect(s.kind).toBe('notification');
        expect(s.status).toBe('completed');
        expect(s.path).toEqual(['p', 'split', 'mid', 'hub', 'target']);
    });

    it('does not merge notifications with different params', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        const base = {
            ts: 0,
            nodeId: 'hub',
            in: { edgeId: 'e1' },
            out: { edgeId: 'e2' },
            disposition: 'forwarded' as const,
            kind: 'notification' as const,
            method: 'evt::changed',
        };
        agg.add({ ...base, params: { file: 'a.ts' } });
        agg.add({ ...base, params: { file: 'b.ts' } });
        clock.advance(60);

        expect(flows).toHaveLength(2);
    });

    it('chains a multi-hop request across nodes by shared (edge, requestId)', () => {
        const clock = new FakeClock();
        const { agg, flows } = makeAgg(clock);

        // node A forwards onto edge `mid` as id 5; node B forwards onto e2 as 9.
        agg.add(req({ ts: 0, nodeId: 'A', in: { edgeId: 'e1', requestId: 1000 }, out: { edgeId: 'mid', requestId: 5 } }));
        agg.add(req({ ts: 1, nodeId: 'B', in: { edgeId: 'mid', requestId: 5 }, out: { edgeId: 'e2', requestId: 9 } }));
        agg.add(res({ ts: 8, nodeId: 'B', in: { edgeId: 'e2', requestId: 9 }, out: { edgeId: 'mid', requestId: 5 } }));
        agg.add(res({ ts: 9, nodeId: 'A', in: { edgeId: 'mid', requestId: 5 }, out: { edgeId: 'e1', requestId: 1000 } }));
        clock.advance(60);

        expect(flows).toHaveLength(1);
        expect(flows[0].status).toBe('completed');
        expect(flows[0].path).toEqual(['e1', 'A', 'mid', 'B', 'e2']);
    });

    it('applies edge labels to the path', () => {
        const clock = new FakeClock();
        const flows: FlowSummary[] = [];
        const agg = new TransitAggregator({
            onFlow: (s) => flows.push(s),
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
            labelOf: (id) => (id === 'e1' ? 'csv-viewer' : id === 'e2' ? 'github' : undefined),
        });

        agg.add(req({ ts: 0 }));
        agg.add(res({ ts: 2 }));
        clock.advance(60);

        expect(flows[0].path).toEqual(['csv-viewer', 'hub', 'github']);
    });

    it('drops an unsettled flow after giveUpMs without re-emitting', () => {
        const clock = new FakeClock();
        const flows: FlowSummary[] = [];
        const agg = new TransitAggregator({
            onFlow: (s) => flows.push(s),
            flushDelayMs: 50,
            giveUpMs: 1000,
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
        });

        agg.add(req({ ts: 0 }));
        clock.advance(60); // partial reported
        expect(flows).toHaveLength(1);

        clock.advance(2000); // give-up fires; no further emissions
        expect(flows).toHaveLength(1);
    });
});

describe('formatFlowSummary', () => {
    it('renders a completed flow on one line', () => {
        const line = formatFlowSummary({
            id: 'flow1',
            kind: 'request',
            method: 'calc::add',
            params: { a: 1 },
            status: 'completed',
            result: 3,
            startTs: 0,
            endTs: 12,
            durationMs: 12,
            path: ['csv-viewer', 'hub', 'github'],
            partial: false,
        });
        expect(line).toContain('✓');
        expect(line).toContain('csv-viewer → hub → github');
        expect(line).toContain('calc::add');
        expect(line).toContain('12ms');
    });

    it('truncates oversized payloads', () => {
        const big = { blob: 'x'.repeat(500) };
        const line = formatFlowSummary(
            {
                id: 'flow1',
                kind: 'request',
                method: 'm',
                params: big,
                status: 'pending',
                startTs: 0,
                endTs: undefined,
                durationMs: 100,
                path: ['a', 'hub', 'b'],
                partial: true,
            },
            50,
        );
        expect(line).toContain('…');
        expect(line.length).toBeLessThan(200);
    });

    it('renders the complete structured error without error-shape-specific formatting', () => {
        const line = formatFlowSummary({
            id: 'flow1',
            kind: 'request',
            method: 'home-assistant::listEntities',
            params: { options: { limit: 2 } },
            status: 'failed',
            error: {
                code: -32602,
                message: 'Invalid params',
                data: {
                    issues: [{
                        code: 'unrecognized_keys',
                        keys: ['$hubrpc'],
                        path: [],
                        message: 'Unrecognized key',
                    }],
                },
            },
            startTs: 0,
            endTs: 27,
            durationMs: 27,
            path: ['app', 'hub', 'home-assistant'],
            partial: false,
        }, 500);

        expect(line).toContain(
            'error {"code":-32602,"message":"Invalid params","data":{"issues":',
        );
        expect(line).toContain('"keys":["$hubrpc"]');
    });

    it('appends indented stream lines when stream frames are present', () => {
        const line = formatFlowSummary({
            id: 'flow1',
            kind: 'request',
            method: 'scriptRunner::runCode',
            params: {},
            status: 'completed',
            result: { ok: true },
            startTs: 0,
            endTs: 30,
            durationMs: 30,
            path: ['app', 'hub', 'script'],
            partial: false,
            stream: [
                { ts: 2, dir: 'toCaller', payload: { type: 'stdout', data: 'hello\n' } },
                { ts: 4, dir: 'toCallee', control: 'cancel' },
            ],
        });
        const rows = line.split('\n');
        expect(rows).toHaveLength(3);
        expect(rows[0]).toContain('scriptRunner::runCode');
        expect(rows[1]).toContain('← stream');
        expect(rows[1]).toContain('stdout');
        expect(rows[2]).toContain('→ stream');
        expect(rows[2]).toContain('ctrl:cancel');
    });

    it('renders a standalone stream frame as one compact line', () => {
        const line = formatFlowSummary({
            id: 'f',
            kind: 'stream',
            method: 'scriptRunner::runCode',
            params: undefined,
            status: 'completed',
            startTs: 0,
            endTs: 1500,
            durationMs: 1500,
            path: ['app', 'hub', 'script'],
            partial: false,
            stream: [{ ts: 1500, dir: 'toCaller', payload: { type: 'stdout', data: 'hi' } }],
        });
        expect(line).not.toContain('\n');
        expect(line).toContain('scriptRunner::runCode');
        expect(line).toContain('← stream');
        expect(line).toContain('stdout');
        expect(line).toContain('+1500ms');
    });
});

describe('tapTransport', () => {
    /** A stub transport that records sends and lets a test drive inbound. */
    function stub(): {
        transport: IMessageTransport;
        sent: JsonRpcMessage[];
        deliver: (m: JsonRpcMessage) => void;
    } {
        let listener: ((m: JsonRpcMessage) => void) | undefined;
        const sent: JsonRpcMessage[] = [];
        return {
            transport: {
                send: (m) => void sent.push(m),
                setListener: (l) => { listener = l ?? undefined; },
                dispose: () => { /* no-op */ },
            },
            sent,
            deliver: (m) => listener?.(m),
        };
    }

    it('renders a request + response wire exchange as one completed flow', () => {
        vi.useFakeTimers();
        try {
            const lines: string[] = [];
            const inner = stub();
            const tapped = tapTransport(inner.transport, {
                log: (l) => lines.push(l),
                localLabel: 'cli',
                remoteLabel: 'hub',
            });
            tapped.setListener(() => { /* consume */ });

            tapped.send({ jsonrpc: '2.0', id: 7, method: 'calc::add', params: { a: 1, b: 2 } });
            inner.deliver({ jsonrpc: '2.0', id: 7, result: 3 });
            vi.advanceTimersByTime(60);

            expect(inner.sent).toHaveLength(1); // message still forwarded
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain('✓');
            expect(lines[0]).toContain('cli → hub');
            expect(lines[0]).toContain('calc::add');
        } finally {
            vi.useRealTimers();
        }
    });

    it('forwards messages untouched in both directions', () => {
        const inner = stub();
        const received: JsonRpcMessage[] = [];
        const tapped = tapTransport(inner.transport, { log: () => { /* ignore */ } });
        tapped.setListener((m) => void received.push(m));

        const out: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'm' };
        tapped.send(out);
        expect(inner.sent[0]).toBe(out);

        const back: JsonRpcMessage = { jsonrpc: '2.0', id: 1, result: 42 };
        inner.deliver(back);
        expect(received[0]).toBe(back);
    });
});
