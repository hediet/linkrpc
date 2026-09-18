import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    ErrorCode,
    type IMessageTransport,
    isNotification,
    isRequest,
    isResponse,
    type JsonRpcMessage,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type RequestId,
    TransportPair,
} from '@hediet/linkrpc';
import {
    STREAM_METHOD,
    StreamControlType,
    StreamDir,
    type StreamSendParams,
} from '@hediet/linkrpc';
import { Hub } from './routingHub';
import { GET_NODE_ID_METHOD } from './peerDiscovery';

/** Drives one side of a link: sends requests/notifications, records inbound. */
class Endpoint {
    private readonly _nodeId = randomUUID();
    // Start high so the hub's independent id space (which starts at 1)
    // cannot coincidentally collide with ours.
    private _nextId = 1000;
    private readonly _pending = new Map<string, (r: JsonRpcResponse) => void>();
    /** Inbound requests and notifications (e.g. forwarded calls). */
    public readonly inbox: JsonRpcMessage[] = [];

    constructor(public readonly transport: IMessageTransport) {
        transport.setListener((m) => this._onMessage(m));
    }

    public request(method: string, params?: unknown): Promise<JsonRpcResponse> {
        const id = this._nextId++;
        const promise = new Promise<JsonRpcResponse>((resolve) => {
            this._pending.set(String(id), resolve);
        });
        const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params: params as never };
        void this.transport.send(req);
        return promise;
    }

    public notify(method: string, params?: unknown): void {
        void this.transport.send({ jsonrpc: '2.0', method, params: params as never });
    }

    public respond(req: JsonRpcRequest, result: unknown): void {
        void this.transport.send({ jsonrpc: '2.0', id: req.id, result: result as never });
    }

    private _onMessage(m: JsonRpcMessage): void {
        if (isRequest(m) && m.method === GET_NODE_ID_METHOD) {
            this.respond(m, { nodeId: this._nodeId, portId: 'port' });
            return;
        }
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

function attachEndpoint(hub: Hub): Endpoint {
    const pair = new TransportPair();
    hub.attach(pair.a);
    return new Endpoint(pair.b);
}

async function waitFor(fn: () => boolean, ms = 1000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
        if (Date.now() - start > ms) throw new Error('waitFor: timed out');
        await new Promise((r) => setTimeout(r, 0));
    }
}

const okResult = (r: JsonRpcResponse) => (r as { result: unknown; }).result;
const errOf = (r: JsonRpcResponse) => (r as { error: { code: number; message: string; }; }).error;

/** Stream (`$stream::send`) notifications an endpoint received, oldest first. */
function streamMsgs(e: Endpoint): Array<{ requestId: RequestId; payload: unknown; }> {
    return e.inbox
        .filter((m) => (m as { method?: string; }).method === STREAM_METHOD)
        .map((m) => (m as unknown as { params: { requestId: RequestId; payload: unknown; }; }).params);
}

describe('Hub routing', () => {
    it('expires silent requests after the default idle timeout', async () => {
        vi.useFakeTimers();
        try {
            const hub = new Hub();
            const transits: Parameters<Parameters<typeof hub.observeTransits>[0]>[0][] = [];
            hub.observeTransits((transit) => transits.push(transit));
            const caller = attachEndpoint(hub);
            const ownerPair = new TransportPair();
            hub.claimPrefix(ownerPair.a, 'calc');
            const owner = new Endpoint(ownerPair.b);

            const response = caller.request('calc::math::slow', {});
            await vi.waitFor(() => expect(owner.inbox).toHaveLength(1));
            expect(hub.pendingRequests()).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(30 * 60_000);

            await expect(response).resolves.toMatchObject({
                error: {
                    code: ErrorCode.requestTimeout,
                    message: 'request idle-timed-out',
                },
            });
            expect(hub.pendingRequests()).toHaveLength(0);
            expect(transits.filter((transit) => transit.method === 'calc::math::slow')
                .map(({ kind, disposition, error }) => ({
                    kind,
                    disposition,
                    errorCode: error?.code,
                }))).toEqual([
                { kind: 'request', disposition: 'forwarded', errorCode: undefined },
                {
                    kind: 'response',
                    disposition: 'forwarded',
                    errorCode: ErrorCode.requestTimeout,
                },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('forwards a prefixed request to the prefix owner and routes the response back', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);

        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const respP = caller.request('calc::math::add', { a: 1, b: 2 });
        await waitFor(() => owner.inbox.length > 0);

        const forwarded = owner.inbox[0] as JsonRpcRequest;
        // Full method name is preserved verbatim across the hub.
        expect(forwarded.method).toBe('calc::math::add');
        // The id was rewritten into the hub's own id space.
        expect(forwarded.id).toBe(1);

        owner.respond(forwarded, { sum: 3 });
        const resp = await respP;
        // Original caller id is restored on the way back.
        expect(resp.id).toBe(1000);
        expect(okResult(resp)).toEqual({ sum: 3 });
    });

    it('routes root-addressed (interface-form) calls to loopback, never to a prefix owner', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);

        const loopback = hub.attachOut();
        loopback.setAsLoopback();
        const loop = new Endpoint(loopback.transport);

        // A prefix owner that should be ignored for root-addressed calls.
        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'math');
        const owner = new Endpoint(ownerPair.b);

        const respP = caller.request('math::add', { a: 1 });
        await waitFor(() => loop.inbox.length > 0);

        expect(owner.inbox).toHaveLength(0);
        const forwarded = loop.inbox[0] as JsonRpcRequest;
        expect(forwarded.method).toBe('math::add');

        loop.respond(forwarded, { ok: true });
        expect(okResult(await respP)).toEqual({ ok: true });
        loopback.dispose();
    });

    it('rejects a second root handler until the current owner detaches', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);
        const first = hub.attachOut();
        const second = hub.attachOut();
        const loop = new Endpoint(second.transport);
        first.setAsLoopback();
        expect(() => second.setAsLoopback()).toThrow('already the hub-root handler');
        const changed = vi.fn();
        const unsubscribe = hub.onDidChangeRouting(changed);
        first.setAsLoopback();
        expect(changed).not.toHaveBeenCalled();
        first.dispose();
        expect(() => first.setAsLoopback()).toThrow('link is detached');
        second.setAsLoopback();
        first.dispose();

        const response = caller.request('math::add', {});
        const forwarded = loop.inbox[0] as JsonRpcRequest;
        loop.respond(forwarded, { ok: true });
        expect(okResult(await response)).toEqual({ ok: true });

        second.dispose();
        expect(() => second.setAsLoopback()).toThrow('link is detached');
        expect(errOf(await caller.request('math::add', {})).code).toBe(ErrorCode.methodNotFound);
        unsubscribe();
    });

    it.each([false, true])('rejects a conflicting root attachment atomically (already attached: %s)', (alreadyAttached) => {
        const hub = new Hub();
        const original = hub.attachOut({ exclusiveHubRootHandler: true });
        const pair = new TransportPair();
        const existing = alreadyAttached ? hub.attach(pair.a) : undefined;
        const before = hub.getTopologyGraph('observer');
        const setListener = vi.spyOn(pair.a, 'setListener');
        const changed = vi.fn();
        const unsubscribe = hub.onDidChangeRouting(changed);
        try {
            expect(() => hub.attach(pair.a, {
                exclusiveHubRootHandler: true,
                routePrefixes: ['new-route'],
                edgeId: 'rejected',
                transport: { type: 'test' },
            })).toThrow('already the hub-root handler');
            expect(setListener).not.toHaveBeenCalled();
            expect(changed).not.toHaveBeenCalled();
            expect(hub.claimedPrefixes()).toEqual([]);
            expect(hub.getTopologyGraph('observer')).toEqual(before);
        } finally {
            unsubscribe();
            existing?.dispose();
            original.dispose();
        }
    });

    it('rejects a conflicting attachOut and allows a new handler after explicit clearing', () => {
        const hub = new Hub();
        const original = hub.attachOut({ exclusiveHubRootHandler: true });
        const before = hub.getTopologyGraph('observer');
        expect(() => hub.attachOut({
            exclusiveHubRootHandler: true,
            routePrefixes: ['new-route'],
        })).toThrow('already the hub-root handler');
        expect(hub.getTopologyGraph('observer')).toEqual(before);
        hub.setLoopback(undefined);
        const replacement = hub.attachOut({ exclusiveHubRootHandler: true });
        original.dispose();
        expect(() => replacement.setAsLoopback()).not.toThrow();
        replacement.dispose();
    });

    it('does not let a disposed handle change or detach a reattached transport', () => {
        const hub = new Hub();
        const pair = new TransportPair();
        const old = hub.attach(pair.a);
        old.dispose();
        const current = hub.attach(pair.a);
        expect(() => old.setAsLoopback()).toThrow('link is detached');
        old.dispose();
        expect(() => current.setAsLoopback()).not.toThrow();
        current.dispose();
    });

    it('configures loopback and prefix routes before delivering buffered messages', async () => {
        const hub = new Hub();
        const pair = new TransportPair();
        const endpoint = new Endpoint(pair.b);
        const rootResponse = endpoint.request('math::add', {});
        const prefixResponse = endpoint.request('calc::math::add', {});
        const link = hub.attach(pair.a, { exclusiveHubRootHandler: true, routePrefixes: ['calc', 'other'] });
        try {
            expect(endpoint.inbox).toHaveLength(2);
            const [root, prefixed] = endpoint.inbox as JsonRpcRequest[];
            expect(root.method).toBe('math::add');
            expect(prefixed.method).toBe('calc::math::add');
            endpoint.respond(root, 'root');
            endpoint.respond(prefixed, 'prefix');
            expect(okResult(await rootResponse)).toBe('root');
            expect(okResult(await prefixResponse)).toBe('prefix');
            expect(hub.claimedPrefixes()).toEqual(['calc', 'other']);
        } finally {
            link.dispose();
        }
        expect(hub.claimedPrefixes()).toEqual([]);
    });

    it.each([
        ['new', ''],
        ['new', 'taken'],
        ['new', 'new'],
    ])('rejects initial routes %j without changing attachment or loopback state', async (...routePrefixes) => {
        const hub = new Hub();
        const original = hub.attachOut({ exclusiveHubRootHandler: true, routePrefixes: ['taken'] });
        const endpoint = new Endpoint(original.transport);
        const pair = new TransportPair();
        const setListener = vi.spyOn(pair.a, 'setListener');
        const changes = vi.fn();
        const unsubscribe = hub.onDidChangeRouting(changes);
        const before = hub.getTopologyGraph('observer');
        try {
            expect(() => hub.attach(pair.a, {
                exclusiveHubRootHandler: true,
                routePrefixes,
                edgeId: 'rejected',
            })).toThrow(/claimPrefix/);
            expect(setListener).not.toHaveBeenCalled();
            expect(changes).not.toHaveBeenCalled();
            expect(hub.getTopologyGraph('observer')).toEqual(before);
            expect(hub.claimedPrefixes()).toEqual(['taken']);
            const response = endpoint.request('math::add', {});
            endpoint.respond(endpoint.inbox[0] as JsonRpcRequest, 'original');
            expect(okResult(await response)).toBe('original');
        } finally {
            unsubscribe();
            original.dispose();
        }
    });

    it('applies initial options to an already attached link without reinstalling its listener', () => {
        const hub = new Hub();
        const pair = new TransportPair();
        const link = hub.attach(pair.a);
        const setListener = vi.spyOn(pair.a, 'setListener');
        const changes = vi.fn();
        const unsubscribe = hub.onDidChangeRouting(changes);
        try {
            hub.attach(pair.a, { exclusiveHubRootHandler: true, routePrefixes: ['calc'] });
            expect(setListener).not.toHaveBeenCalled();
            expect(changes).toHaveBeenCalledOnce();
            const graph = hub.getTopologyGraph('observer');
            expect(() => hub.attach(pair.a, { routePrefixes: ['other', 'calc'] })).toThrow(/already claimed/);
            expect(hub.getTopologyGraph('observer')).toEqual(graph);
            expect(hub.claimedPrefixes()).toEqual(['calc']);
        } finally {
            unsubscribe();
            link.dispose();
        }
    });

    it('replies methodNotFound for root-addressed calls when there is no loopback', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);
        const resp = await caller.request('math::add', {});
        expect(errOf(resp).code).toBe(ErrorCode.methodNotFound);
    });

    it('replies methodNotFound for an unknown prefix with no uplink', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);
        const resp = await caller.request('nope::iface::m', {});
        expect(errOf(resp).code).toBe(ErrorCode.methodNotFound);
    });

    it('forwards an unknown prefix to the uplink (default route)', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);

        const uplink = new TransportPair();
        hub.setUplink(uplink.a);
        const up = new Endpoint(uplink.b);

        const respP = caller.request('far::iface::m', { x: 1 });
        await waitFor(() => up.inbox.length > 0);

        const forwarded = up.inbox[0] as JsonRpcRequest;
        expect(forwarded.method).toBe('far::iface::m');
        up.respond(forwarded, { reached: 'uplink' });
        expect(okResult(await respP)).toEqual({ reached: 'uplink' });
    });

    it('does not loop a request back to the uplink it arrived on', async () => {
        const hub = new Hub();
        const uplink = new TransportPair();
        hub.setUplink(uplink.a);
        const up = new Endpoint(uplink.b);

        // The uplink asks for an unknown prefix; the hub must not bounce it
        // back upstream — it answers with no-route instead.
        const resp = await up.request('unknown::iface::m', {});
        expect(errOf(resp).code).toBe(ErrorCode.methodNotFound);
    });

    it('routes a prefix owner calling its own prefix back to itself', async () => {
        const hub = new Hub();
        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'self');
        const owner = new Endpoint(ownerPair.b);

        const respP = owner.request('self::iface::ping', {});
        await waitFor(() => owner.inbox.length > 0);
        const forwarded = owner.inbox[0] as JsonRpcRequest;
        owner.respond(forwarded, { pong: true });
        expect(okResult(await respP)).toEqual({ pong: true });
    });

    it('forwards notifications without tracking a response', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);
        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'svc');
        const owner = new Endpoint(ownerPair.b);

        caller.notify('svc::iface::event', { n: 1 });
        await waitFor(() => owner.inbox.length > 0);

        const note = owner.inbox[0] as JsonRpcRequest;
        expect(note.method).toBe('svc::iface::event');
        expect('id' in note).toBe(false);
    });

    it('drops unroutable notifications silently (no error reply)', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);
        caller.notify('nowhere::iface::event', {});
        // Give the hub a few ticks; nothing should come back.
        await new Promise((r) => setTimeout(r, 10));
        expect(caller.inbox).toHaveLength(0);
    });

    it('disposing the attach handle removes the owner; subsequent calls are unroutable', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);
        const ownerPair = new TransportPair();
        const handle = hub.attach(ownerPair.a);
        hub.claimPrefix(ownerPair.a, 'gone');
        handle.dispose();

        const resp = await caller.request('gone::iface::m', {});
        expect(errOf(resp).code).toBe(ErrorCode.methodNotFound);
    });

    it('fails a pending request when its target detaches before responding', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);

        const ownerPair = new TransportPair();
        const handle = hub.attach(ownerPair.a);
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const respP = caller.request('calc::math::add', { a: 1 });
        await waitFor(() => owner.inbox.length > 0);

        // Target vanishes mid-flight without ever responding.
        handle.dispose();
        const resp = await respP;
        expect(errOf(resp).code).toBe(ErrorCode.peerDisconnected);
    });

    it('ignores a response from a link other than the one the request was forwarded to', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);

        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        // A second, unrelated link that will try to forge a reply.
        const attacker = attachEndpoint(hub);

        const respP = caller.request('calc::math::add', { a: 1 });
        await waitFor(() => owner.inbox.length > 0);
        const forwarded = owner.inbox[0] as JsonRpcRequest;

        // Attacker guesses the hub-local id and forges a response.
        void attacker.transport.send({ jsonrpc: '2.0', id: forwarded.id, result: { forged: true } });
        // Give the hub a few ticks; the forged reply must be dropped.
        await new Promise((r) => setTimeout(r, 10));

        // The legitimate target responds and the real result is delivered.
        owner.respond(forwarded, { sum: 3 });
        expect(okResult(await respP)).toEqual({ sum: 3 });
    });

    it('routes a server→client stream back to the origin, restoring its request id', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);

        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const respP = caller.request('calc::math::add', { a: 1 });
        await waitFor(() => owner.inbox.length > 0);
        const forwarded = owner.inbox[0] as JsonRpcRequest;
        // The target sees the hub-rewritten id (id space starts at 1).
        expect(forwarded.id).toBe(1);

        // While the request is in flight, the target streams progress using the
        // id it received (the hub id).
        owner.notify(STREAM_METHOD, { requestId: forwarded.id, dir: StreamDir.toCaller, payload: 'progress' });
        await waitFor(() => streamMsgs(caller).length > 0);

        const got = streamMsgs(caller)[0];
        // requestId is restored to the caller's original id (Endpoint starts at 1000).
        expect(got.requestId).toBe(1000);
        expect(got.payload).toBe('progress');

        owner.respond(forwarded, { sum: 1 });
        expect(okResult(await respP)).toEqual({ sum: 1 });
    });

    it('routes a client→server stream to the target, rewriting requestId to the hub id', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);

        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const respP = caller.request('calc::math::add', { a: 1 });
        await waitFor(() => owner.inbox.length > 0);
        const forwarded = owner.inbox[0] as JsonRpcRequest;

        // The caller streams toward the server using the id it sent (1000).
        caller.notify(STREAM_METHOD, { requestId: 1000, dir: StreamDir.toCallee, payload: 'cancel' });
        await waitFor(() => streamMsgs(owner).length > 0);

        const got = streamMsgs(owner)[0];
        // Rewritten to the hub-local id the target knows.
        expect(got.requestId).toBe(forwarded.id);
        expect(got.payload).toBe('cancel');

        owner.respond(forwarded, { sum: 1 });
        expect(okResult(await respP)).toEqual({ sum: 1 });
    });

    it('drops a stream notification that matches no in-flight request', async () => {
        const hub = new Hub();
        const caller = attachEndpoint(hub);
        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        caller.notify(STREAM_METHOD, { requestId: 9999, dir: StreamDir.toCallee, payload: 'orphan' });
        await new Promise((r) => setTimeout(r, 10));

        expect(streamMsgs(owner)).toHaveLength(0);
        expect(streamMsgs(caller)).toHaveLength(0);
    });
});

describe('Hub.queryParticipantRoots', () => {
    /**
     * Attach a participant link that answers a root-form `hubrpc.directory::list`
     * with `items` (or replies with an error when `items === 'throw'`). Claims
     * every prefix in `prefixes` on the *same* link.
     */
    function attachRootDir(
        hub: Hub,
        prefixes: string[],
        items: Array<{ serviceId: string; interfaceId: string; }> | 'throw',
    ): void {
        const pair = new TransportPair();
        for (const p of prefixes) hub.claimPrefix(pair.a, p);
        pair.b.setListener((m) => {
            const req = m as JsonRpcRequest;
            if (req.method !== 'hubrpc.directory::list' || !('id' in req)) return;
            if (items === 'throw') {
                void pair.b.send({
                    jsonrpc: '2.0', id: req.id,
                    error: { code: ErrorCode.methodNotFound, message: 'no root dir' },
                } as JsonRpcResponse);
            } else {
                void pair.b.send({ jsonrpc: '2.0', id: req.id, result: { items } } as JsonRpcResponse);
            }
        });
    }

    it('fans a root-form request to each participant, excluding a prefix and the uplink', async () => {
        const hub = new Hub();
        // The hub's own services prefix — excluded from the fan-out.
        attachRootDir(hub, ['hub'], [{ serviceId: 'hub', interfaceId: 'hubrpc.directory' }]);
        attachRootDir(hub, ['calc'], [{ serviceId: 'calc', interfaceId: 'hubrpc.directory' }]);
        attachRootDir(hub, ['fs'], [{ serviceId: 'fs', interfaceId: 'hubrpc.directory' }]);

        const results = await hub.queryParticipantRoots('hubrpc.directory::list', {}, 'hub');
        const sids = results
            .flatMap((r) => (r as { items: { serviceId: string; }[]; }).items)
            .map((i) => i.serviceId)
            .sort();
        // 'hub' is excluded; 'calc' and 'fs' answered from their roots.
        expect(sids).toEqual(['calc', 'fs']);
    });

    it('queries a multi-prefix participant once and tolerates a failing participant', async () => {
        const hub = new Hub();
        attachRootDir(hub, ['a', 'a/b'], [{ serviceId: 'a', interfaceId: 'hubrpc.directory' }]);
        attachRootDir(hub, ['boom'], 'throw');

        const results = await hub.queryParticipantRoots('hubrpc.directory::list', {});
        // The failing participant is dropped; the multi-prefix one answers once.
        expect(results).toHaveLength(1);
        expect((results[0] as { items: { serviceId: string; }[]; }).items[0].serviceId).toBe('a');
    });

    it('retries a participant watch that settles before root reflection is installed', async () => {
        const hub = new Hub({ idleTimeoutMs: 1_000 });
        const pair = new TransportPair();
        hub.claimPrefix(pair.a, 'late');
        let watchAttempts = 0;
        let liveWatchId: RequestId | undefined;
        pair.b.setListener((message) => {
            const request = message as JsonRpcRequest;
            if (request.method !== 'hubrpc.directory::watch' || !('id' in request)) return;
            watchAttempts++;
            if (watchAttempts === 1) {
                void pair.b.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: { code: ErrorCode.methodNotFound, message: 'not installed yet' },
                });
            } else {
                liveWatchId = request.id;
            }
        });
        let ticks = 0;
        const watch = hub.watchParticipantRoots(
            'hubrpc.directory::watch',
            {},
            () => ticks++,
        );

        await until(() => liveWatchId !== undefined);
        const beforePayload = ticks;
        await pair.b.send({
            jsonrpc: '2.0',
            method: STREAM_METHOD,
            params: {
                requestId: liveWatchId!,
                dir: StreamDir.toCaller,
                payload: {},
            },
        });
        await until(() => ticks === beforePayload + 1);

        expect(watchAttempts).toBeGreaterThanOrEqual(2);
        watch.dispose();
    });

    it('does not treat participant watch keepalive controls as directory changes', async () => {
        const hub = new Hub({ idleTimeoutMs: 100 });
        const pair = new TransportPair();
        hub.claimPrefix(pair.a, 'stable');
        let watchId: RequestId | undefined;
        let callerPongs = 0;
        const controls: StreamSendParams[] = [];
        pair.b.setListener((message) => {
            if (isRequest(message) && message.method === 'hubrpc.directory::watch') {
                watchId = message.id;
                return;
            }
            if (!isNotification(message) || message.method !== STREAM_METHOD) return;
            const stream = message.params as unknown as StreamSendParams;
            controls.push(stream);
            if (
                stream.dir === StreamDir.toCallee
                && stream.control?.type === StreamControlType.ping
            ) {
                void pair.b.send({
                    jsonrpc: '2.0',
                    method: STREAM_METHOD,
                    params: {
                        requestId: stream.requestId,
                        dir: StreamDir.toCaller,
                        control: {
                            type: StreamControlType.pong,
                            nonce: stream.control.nonce,
                        },
                    },
                });
            } else if (
                stream.dir === StreamDir.toCallee
                && stream.control?.type === StreamControlType.pong
            ) {
                callerPongs++;
            }
        });
        let ticks = 0;
        const watch = hub.watchParticipantRoots(
            'hubrpc.directory::watch',
            {},
            () => ticks++,
        );
        await until(() => watchId !== undefined && ticks === 1);
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(ticks).toBe(1);

        await pair.b.send({
            jsonrpc: '2.0',
            method: STREAM_METHOD,
            params: {
                requestId: watchId!,
                dir: StreamDir.toCaller,
                control: {
                    type: StreamControlType.ping,
                    nonce: 'callee-ping',
                },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(controls).toContainEqual(expect.objectContaining({
            dir: StreamDir.toCallee,
            control: expect.objectContaining({
                type: StreamControlType.pong,
                nonce: 'callee-ping',
            }),
        }));
        expect(callerPongs).toBe(1);
        expect(ticks).toBe(1);
        watch.dispose();
    });

    it('cleans up and retries when a participant watch control send fails', async () => {
        const hub = new Hub({ idleTimeoutMs: 60 });
        let watchAttempts = 0;
        const transport: IMessageTransport = {
            send: async (message) => {
                if (isRequest(message) && message.method === 'hubrpc.directory::watch') {
                    watchAttempts++;
                    return;
                }
                if (isNotification(message) && message.method === STREAM_METHOD) {
                    throw new Error('control send failed');
                }
            },
            setListener: () => {},
            dispose: () => {},
        };
        hub.claimPrefix(transport, 'unstable');
        const watch = hub.watchParticipantRoots(
            'hubrpc.directory::watch',
            {},
            () => {},
        );

        await until(() => watchAttempts >= 2);
        watch.dispose();
    });
});

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
