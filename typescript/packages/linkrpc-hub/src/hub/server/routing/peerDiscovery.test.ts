import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ErrorCode, isRequest, LinkRpcConnection, TransportPair,
    type JsonRpcRequest, type JsonValue,
} from '@hediet/linkrpc';
import { nodeInterface } from '@hediet/linkrpc/hub/common';
import { Hub } from './routingHub';
import { GET_NODE_ID_METHOD } from './peerDiscovery';

describe('automatic peer discovery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function peer() {
        const hub = new Hub({ nodeId: 'hub', peerIdentificationTimeoutMs: 100 });
        const pair = new TransportPair();
        const requests: JsonRpcRequest[] = [];
        pair.b.setListener((message) => {
            if (isRequest(message)) requests.push(message);
        });
        const link = hub.attach(pair.a);
        return {
            hub, pair, link, requests,
            graph: () => hub.getTopologyGraph('observer'),
            reply: (request: JsonRpcRequest, result: JsonValue = { nodeId: 'peer', portId: 'port' }) =>
                pair.b.send({ jsonrpc: '2.0', id: request.id, result }),
        };
    }

    it('automatically identifies both ends and publishes stable link updates', async () => {
        const first = new Hub({ nodeId: 'first' });
        const second = new Hub({ nodeId: 'second' });
        const pair = new TransportPair();
        const changes = vi.fn();
        first.onDidChangeTopology(changes);
        const a = first.attach(pair.a);
        const b = second.attach(pair.b);
        const from = first.getTopologyGraph('observer').links[0].from;
        changes.mockClear();
        const routingChanges = vi.fn();
        first.onDidChangeRouting(routingChanges);

        await vi.advanceTimersByTimeAsync(0);

        expect(first.getTopologyGraph('observer').links[0]).toMatchObject({
            from,
            to: { nodeId: 'second', portId: b.portId },
            peerState: 'identified',
        });
        expect(second.getTopologyGraph('observer').links[0].to)
            .toEqual({ nodeId: 'first', portId: a.portId });
        expect(changes).toHaveBeenCalledOnce();
        expect(routingChanges).not.toHaveBeenCalled();
        expect(first.pendingRequests()).toHaveLength(0);
        a.dispose();
        b.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('accepts a delayed response within the deadline without another probe', async () => {
        const p = peer();
        await vi.advanceTimersByTimeAsync(75);
        expect(p.graph().links[0].peerState).toBe('pending');
        await p.reply(p.requests[0]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(p.graph().links[0].peerState).toBe('identified');
        expect(p.requests).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        p.link.dispose();
    });

    it('retries timed-out peers without overlapping requests and ignores late replies', async () => {
        const p = peer();
        await vi.advanceTimersByTimeAsync(100);
        expect(p.hub.pendingRequests()).toHaveLength(0);
        expect(p.graph().links[0].peerState).toBe('error');
        await vi.advanceTimersByTimeAsync(200);
        expect(p.requests).toHaveLength(2);
        expect(p.hub.pendingRequests()).toHaveLength(1);
        await p.reply(p.requests[0], { nodeId: 'stale', portId: 'stale' });
        expect(p.graph().links[0].to.nodeId).toContain(':unidentified:');
        await p.reply(p.requests[1]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(p.graph().links[0].to.nodeId).toBe('peer');
        expect(p.requests).toHaveLength(2);
        expect(p.hub.pendingRequests()).toHaveLength(0);
        p.link.dispose();
    });

    it('keeps routing usable while a peer permanently stalls discovery', async () => {
        const p = peer();
        p.link.addPrefixRoute('service');
        p.pair.b.setListener((message) => {
            if (!isRequest(message)) return;
            if (message.method === GET_NODE_ID_METHOD) p.requests.push(message);
            else void p.reply(message);
        });
        const caller = p.hub.attachOut();
        const connection = LinkRpcConnection.fromTransport(caller.transport);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(p.requests.length).toBeGreaterThan(2);
        expect(p.requests.length).toBeLessThan(10);
        expect(p.hub.pendingRequests().length).toBeLessThanOrEqual(1);
        await expect(connection.service('service').get(nodeInterface).getNodeId({}))
            .resolves.toEqual({ nodeId: 'peer', portId: 'port' });
        expect(p.graph().links.find((link) => link.from.portId === p.link.portId)?.to.nodeId)
            .toContain(':unidentified:');
        connection.close();
        caller.dispose();
        p.link.dispose();
        await vi.advanceTimersByTimeAsync(0);
        expect(p.hub.pendingRequests()).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reprobes unsupported peers slowly and discovers newly installed support', async () => {
        const p = peer();
        await vi.advanceTimersByTimeAsync(0);
        await p.pair.b.send({
            jsonrpc: '2.0', id: p.requests[0].id,
            error: { code: ErrorCode.methodNotFound, message: 'not installed' },
        });
        await vi.advanceTimersByTimeAsync(29_999);
        expect(p.graph().links[0].peerState).toBe('unsupported');
        expect(p.requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(p.requests).toHaveLength(2);
        await p.reply(p.requests[1]);
        await vi.advanceTimersByTimeAsync(0);
        expect(p.graph().links[0].peerState).toBe('identified');
        p.link.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['scheduled', 'probing', 'backoff'] as const)(
        'cleans up when detached while %s',
        async (phase) => {
            const p = peer();
            if (phase === 'probing') await vi.advanceTimersByTimeAsync(0);
            if (phase === 'backoff') await vi.advanceTimersByTimeAsync(100);
            p.link.dispose();
            const changes = vi.fn();
            p.hub.onDidChangeTopology(changes);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(p.hub.pendingRequests()).toHaveLength(0);
            expect(p.graph().links).toHaveLength(0);
            expect(changes).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('does not reuse identity or in-flight results after reattachment', async () => {
        const p = peer();
        await vi.advanceTimersByTimeAsync(0);
        // The response is dispatched, but its promise continuation has not run.
        p.reply(p.requests[0], { nodeId: 'old', portId: 'old-port' });
        p.link.dispose();
        const replacement = p.hub.attach(p.pair.a);
        await vi.advanceTimersByTimeAsync(0);
        expect(p.graph().links[0].to.nodeId).toContain(':unidentified:');
        await p.reply(p.requests[1]);
        await vi.advanceTimersByTimeAsync(0);
        expect(p.graph().links[0].to.nodeId).toBe('peer');
        replacement.dispose();
        const third = p.hub.attach(p.pair.a);
        expect(p.graph().links[0].peerState).toBe('pending');
        third.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('shares a running automatic probe with explicit identification', async () => {
        const p = peer();
        await vi.advanceTimersByTimeAsync(0);
        const first = p.link.identifyPeer();
        const second = p.link.identifyPeer();
        expect(first).toBe(second);
        expect(p.requests).toHaveLength(1);
        await p.reply(p.requests[0]);
        await expect(first).resolves.toEqual({ nodeId: 'peer', portId: 'port' });
        p.link.dispose();
    });
});
