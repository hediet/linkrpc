import { describe, expect, it } from 'vitest';
import {
    type IMessageTransport,
    isResponse,
    type JsonRpcMessage,
    type JsonRpcRequest,
    type JsonRpcResponse,
    STREAM_METHOD,
    StreamDir,
    TransportPair,
} from '@vscode/hubrpc';
import type { NodeTransit } from '../nodeTransit';
import { Hub } from './routingHub';

/** Minimal endpoint: send requests/notifications, capture inbound + respond. */
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

    public notify(method: string, params?: unknown): void {
        void this.transport.send({ jsonrpc: '2.0', method, params: params as never });
    }

    public respond(req: JsonRpcRequest, result: unknown): void {
        void this.transport.send({ jsonrpc: '2.0', id: req.id, result: result as never });
    }

    public lastRequest(): JsonRpcRequest {
        const r = [...this.inbox].reverse().find((m) => (m as { id?: unknown; }).id !== undefined && (m as { method?: string; }).method);
        return r as JsonRpcRequest;
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

describe('Hub transit emission', () => {
    it('emits paired request and response transits with edge labels', async () => {
        const transits: NodeTransit[] = [];
        const hub = new Hub({ onTransit: (t) => transits.push(t) });

        const callerPair = new TransportPair();
        hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);

        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const pending = caller.request('calc::math::add', { a: 1, b: 2 });
        await waitFor(() => owner.inbox.length > 0);
        owner.respond(owner.lastRequest(), 3);
        await pending;

        const request = transits.find((t) => t.kind === 'request');
        const response = transits.find((t) => t.kind === 'response');
        expect(request).toBeDefined();
        expect(response).toBeDefined();

        expect(request!.method).toBe('calc::math::add');
        expect(request!.params).toEqual({ a: 1, b: 2 });
        expect(request!.out?.edgeId).toBe('calc'); // prefix-claimed link labelled
        expect(request!.disposition).toBe('forwarded');

        expect(response!.result).toBe(3);
        // The response's out endpoint mirrors the request's in endpoint.
        expect(response!.out?.edgeId).toBe(request!.in?.edgeId);
        expect(String(response!.out?.requestId)).toBe(String(request!.in?.requestId));
    });

    it('emits an unroutable request transit', async () => {
        const transits: NodeTransit[] = [];
        const hub = new Hub({ onTransit: (t) => transits.push(t) });
        const callerPair = new TransportPair();
        hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);

        const res = await caller.request('nope::missing');
        expect(isResponse(res)).toBe(true);

        const t = transits.find((x) => x.kind === 'request');
        expect(t?.disposition).toBe('unroutable');
        expect(t?.out).toBeUndefined();
        expect(t?.method).toBe('nope::missing');
    });

    it('emits a forwarded notification transit', async () => {
        const transits: NodeTransit[] = [];
        const hub = new Hub({ onTransit: (t) => transits.push(t) });

        const senderPair = new TransportPair();
        hub.attach(senderPair.a);
        const sender = new Endpoint(senderPair.b);

        const sinkPair = new TransportPair();
        hub.claimPrefix(sinkPair.a, 'evt');
        const sink = new Endpoint(sinkPair.b);

        sender.notify('evt::bus::changed', { file: 'a.ts' });
        await waitFor(() => sink.inbox.length > 0);

        const t = transits.find((x) => x.kind === 'notification');
        expect(t?.disposition).toBe('forwarded');
        expect(t?.method).toBe('evt::bus::changed');
        expect(t?.out?.edgeId).toBe('evt');
    });

    it('reports in-flight requests via pendingRequests()', async () => {
        const hub = new Hub();
        const callerPair = new TransportPair();
        hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);

        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const pending = caller.request('calc::math::add', { a: 1 });
        await waitFor(() => owner.inbox.length > 0);

        const inFlight = hub.pendingRequests();
        expect(inFlight).toHaveLength(1);
        expect(inFlight[0].method).toBe('calc::math::add');
        expect(inFlight[0].targetEdgeId).toBe('calc');
        expect(inFlight[0].ageMs).toBeGreaterThanOrEqual(0);

        owner.respond(owner.lastRequest(), 1);
        await pending;
        expect(hub.pendingRequests()).toHaveLength(0);
    });

    it('emits a stream transit (merging into the request flow) when gated on', async () => {
        const transits: NodeTransit[] = [];
        const hub = new Hub({
            onTransit: (t) => transits.push(t),
            emitStreamTransits: () => true,
        });

        const callerPair = new TransportPair();
        hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);

        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const pending = caller.request('calc::math::add', { a: 1, b: 2 });
        await waitFor(() => owner.inbox.length > 0);

        // Callee streams progress back toward the caller on the hub-rewritten id
        // it received, before the final response.
        const received = owner.lastRequest();
        owner.notify(STREAM_METHOD, {
            requestId: received.id,
            dir: StreamDir.toCaller,
            payload: { chunk: 'hi' },
        });
        await waitFor(() => caller.inbox.some((m) => (m as { method?: string; }).method === STREAM_METHOD));

        owner.respond(received, 3);
        await pending;

        const stream = transits.find((t) => t.kind === 'stream');
        expect(stream).toBeDefined();
        expect(stream!.method).toBe(STREAM_METHOD);
        expect(stream!.disposition).toBe('forwarded');
        expect((stream!.params as { payload?: unknown; }).payload).toEqual({ chunk: 'hi' });

        // The stream's endpoints reuse the request's edges/ids so the aggregator
        // folds it into the same flow: stream.in mirrors the request's out, and
        // stream.out mirrors the request's in.
        const request = transits.find((t) => t.kind === 'request')!;
        expect(stream!.in?.edgeId).toBe(request.out?.edgeId);
        expect(String(stream!.in?.requestId)).toBe(String(request.out?.requestId));
        expect(stream!.out?.edgeId).toBe(request.in?.edgeId);
        expect(String(stream!.out?.requestId)).toBe(String(request.in?.requestId));
    });

    it('emits no stream transit when the gate is off (default)', async () => {
        const transits: NodeTransit[] = [];
        const hub = new Hub({ onTransit: (t) => transits.push(t) }); // no emitStreamTransits

        const callerPair = new TransportPair();
        hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);

        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const pending = caller.request('calc::math::add', { a: 1 });
        await waitFor(() => owner.inbox.length > 0);

        const received = owner.lastRequest();
        owner.notify(STREAM_METHOD, {
            requestId: received.id,
            dir: StreamDir.toCaller,
            payload: { chunk: 'hi' },
        });
        // Frame is still forwarded to the caller even though no transit is emitted.
        await waitFor(() => caller.inbox.some((m) => (m as { method?: string; }).method === STREAM_METHOD));

        owner.respond(received, 1);
        await pending;

        expect(transits.some((t) => t.kind === 'stream')).toBe(false);
    });

    it('allocates nothing and stays silent when no observer is attached', async () => {
        const hub = new Hub();
        const callerPair = new TransportPair();
        hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);
        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const pending = caller.request('calc::math::add', {});
        await waitFor(() => owner.inbox.length > 0);
        owner.respond(owner.lastRequest(), 3);
        const res = await pending;
        expect((res as { result: unknown; }).result).toBe(3);
    });
});
