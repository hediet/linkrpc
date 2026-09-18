import { describe, expect, it } from 'vitest';
import {
    type IMessageTransport,
    isResponse,
    type JsonRpcMessage,
    type JsonRpcRequest,
    type JsonRpcResponse,
    TransportPair,
} from '@hediet/linkrpc';
import type { FlowSummary } from '../nodeTransit';
import { TransitAggregator } from '../nodeTransit';
import { RootOverlay } from './rootOverlay';
import { Hub } from './routingHub';

/** Deterministic clock + timer wheel (mirrors nodeTransit.test.ts). */
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

class Endpoint {
    private _nextId = 1000;
    private readonly _pending = new Map<string, (r: JsonRpcResponse) => void>();
    public readonly inbox: JsonRpcMessage[] = [];
    constructor(public readonly transport: IMessageTransport) {
        transport.setListener((m) => this._onMessage(m));
    }
    public request(method: string, params?: unknown): Promise<JsonRpcResponse> {
        const id = this._nextId++;
        const promise = new Promise<JsonRpcResponse>((resolve) => this._pending.set(String(id), resolve));
        void this.transport.send({ jsonrpc: '2.0', id, method, params: params as never } as JsonRpcRequest);
        return promise;
    }
    public respond(req: JsonRpcRequest, result: unknown): void {
        void this.transport.send({ jsonrpc: '2.0', id: req.id, result: result as never });
    }
    public lastRequest(): JsonRpcRequest {
        return [...this.inbox].reverse().find(
            (m) => (m as { id?: unknown; }).id !== undefined && (m as { method?: string; }).method,
        ) as JsonRpcRequest;
    }
    private _onMessage(m: JsonRpcMessage): void {
        if (isResponse(m)) {
            const p = m.id === null ? undefined : this._pending.get(String(m.id));
            if (p) {
                this._pending.delete(String(m.id));
                p(m);
                return;
            }
        }
        this.inbox.push(m);
    }
}

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
        if (Date.now() - start > ms) throw new Error('waitFor: timed out');
        await new Promise((r) => setTimeout(r, 0));
    }
}

describe('OverlaySplitter transit chaining', () => {
    it('chains splitter + hub transits into one flow with the full path', async () => {
        const clock = new FakeClock();
        const flows: FlowSummary[] = [];
        const agg = new TransitAggregator({
            onFlow: (s) => flows.push(s),
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
        });
        const onTransit = (t: Parameters<typeof agg.add>[0]): void => agg.add(t);

        const hub = new Hub({ debugName: 'hub', nodeId: 'hub', onTransit });

        // Participant attaches via an overlay; share the boundary edge id.
        const partUplink = new TransportPair();
        const upstream = hub.attach(partUplink.b);
        const overlay = new RootOverlay({
            uplink: partUplink.a,
            inspection: {
                nodeId: 'ov',
                onTransit,
                edges: { p: 'app', c: 'root', h: upstream.edgeId },
            },
        });
        const partPair = new TransportPair();
        overlay.connectParticipant(partPair.a);
        const participant = new Endpoint(partPair.b);

        // A prefix owner the participant will call.
        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const pending = participant.request('calc::math::add', { a: 1, b: 2 });
        await waitFor(() => owner.inbox.length > 0);
        owner.respond(owner.lastRequest(), 3);
        const res = await pending;
        expect((res as { result: unknown; }).result).toBe(3);

        clock.advance(60);

        expect(flows).toHaveLength(1);
        const s = flows[0];
        expect(s.status).toBe('completed');
        expect(s.method).toBe('calc::math::add');
        expect(s.result).toBe(3);
        expect(s.path).toEqual(['app', 'ov', upstream.edgeId, 'hub', 'calc']);
    });

    it('keeps a root-addressed (interface-form) call local to the overlay', async () => {
        const clock = new FakeClock();
        const flows: FlowSummary[] = [];
        const agg = new TransitAggregator({
            onFlow: (s) => flows.push(s),
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
        });
        const onTransit = (t: Parameters<typeof agg.add>[0]): void => agg.add(t);

        const hub = new Hub({ debugName: 'hub', nodeId: 'hub', onTransit });
        const partUplink = new TransportPair();
        const upstream = hub.attach(partUplink.b);
        const overlay = new RootOverlay({
            uplink: partUplink.a,
            inspection: { nodeId: 'ov', onTransit, edges: { p: 'app', c: 'root', h: upstream.edgeId } },
        });

        const partPair = new TransportPair();
        overlay.connectParticipant(partPair.a);
        const participant = new Endpoint(partPair.b);

        // Interface-form call: routed P → C (overlay root), never to the hub.
        // No responder is wired; the path is set by the (synchronous) request
        // transit regardless of whether a response ever arrives.
        participant.request('greeter::hello', { who: 'world' });
        clock.advance(60);

        const local = flows.find((f) => f.method === 'greeter::hello');
        expect(local).toBeDefined();
        expect(local!.path).toEqual(['app', 'ov', 'root']);
    });

    it('emits inspection calls like ordinary transits', async () => {
        const transits: Parameters<TransitAggregator['add']>[0][] = [];
        const uplinkPair = new TransportPair();
        const overlay = new RootOverlay({
            uplink: uplinkPair.a,
            inspection: {
                nodeId: 'ov',
                onTransit: (transit) => transits.push(transit),
                edges: { p: 'app', c: 'root', h: 'hub' },
            },
        });
        const uplink = new Endpoint(uplinkPair.b);
        const participantPair = new TransportPair();
        overlay.connectParticipant(participantPair.a);
        const participant = new Endpoint(participantPair.b);

        const inspectionRequest: JsonRpcRequest = {
            jsonrpc: '2.0',
            id: 42,
            method: 'hub::hubrpc.topology::getGraph',
            params: {},
        };
        void participant.transport.send(inspectionRequest);
        await waitFor(() => uplink.inbox.length === 1);
        uplink.respond(uplink.lastRequest(), { nodes: [], links: [], services: [] });
        await waitFor(() => participant.inbox.length === 1);

        expect(transits.map((transit) => transit.kind)).toEqual(['request', 'response']);
        overlay.dispose();
    });
});
