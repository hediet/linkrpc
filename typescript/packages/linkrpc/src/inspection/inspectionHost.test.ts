import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import type { InterfaceRegistration } from '../connection/linkRpcConnection';
import { defineInterface } from '../connection/interfaceDefinition';
import { requestType } from '../schema/memberTypes';
import { TransportPair } from '../transport/messageTransport';
import { InspectionHost, type InspectionSource, type TopologyFragment } from './inspectionHost';
import { nodeInterface } from './node.interfaces';
import { topologyInterface, trafficInterface, type TrafficEvent, type TrafficTransitEvent } from './inspection.interfaces';

const echo = defineInterface({ id: 'test.echo' }, {
    echo: requestType(z.object({ value: z.string() }), z.object({ value: z.string() })),
});

const resources: InterfaceRegistration[] = [];
afterEach(() => {
    for (const resource of resources.splice(0).reverse()) resource.dispose();
});

function pair() {
    const transports = new TransportPair();
    const local = LinkRpcConnection.fromTransport(transports.a);
    const remote = LinkRpcConnection.fromTransport(transports.b);
    resources.push({ dispose: () => { local.close(); remote.close(); } });
    return { local, remote };
}

function host() {
    const result = new InspectionHost({ nodeId: 'main', label: 'Main' });
    resources.push(result);
    return result;
}

function event(id = 1): TrafficTransitEvent {
    return {
        type: 'transit', nodeId: 'main', timeMs: id,
        kind: 'request', method: 'test.echo::echo', disposition: 'forwarded',
        out: { portId: 'cdp', edgeId: 'cdp', requestId: id },
        params: { value: 'secret' },
    };
}

describe('InspectionHost', () => {
    it('observes bare CDP-style methods without sending inspection probes or metadata to the foreign peer', async () => {
        const runtime = defineInterface({ id: 'cdp.Runtime' }, {
            evaluate: requestType(z.object({ expression: z.string() }), z.object({ value: z.number() })),
        });
        const inspection = host();
        const transport = new TransportPair();
        const send = vi.spyOn(transport.a, 'send');
        const cdp = LinkRpcConnection.fromTransport(transport.a);
        const browser = LinkRpcConnection.fromTransport(transport.b);
        resources.push({ dispose: () => { cdp.close(); browser.close(); } });
        browser.register(runtime, { evaluate: () => ({ value: 2 }) });
        browser.bindBare(runtime, { prefix: 'Runtime.' });
        inspection.trackConnection(cdp, { portId: 'cdp' });
        const frontend = pair();
        inspection.expose(frontend.local, { serviceId: 'inspection' });
        const events: TrafficEvent[] = [];
        const watch = frontend.remote.service('inspection').get(trafficInterface).watch({}, {
            onMessage: value => { events.push(value); },
        });
        await frontend.remote.service('inspection').get(topologyInterface).getGraph({});
        expect(send).not.toHaveBeenCalled();
        await expect(cdp.getBare(runtime, { prefix: 'Runtime.' }).evaluate({ expression: '1+1' }))
            .resolves.toEqual({ value: 2 });
        expect(send).toHaveBeenCalledExactlyOnceWith({
            jsonrpc: '2.0', id: 1, method: 'Runtime.evaluate', params: { expression: '1+1' },
        });
        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(events).toMatchObject([
            { kind: 'request', method: 'Runtime.evaluate', out: { portId: 'cdp' } },
            { kind: 'response', method: 'Runtime.evaluate', in: { portId: 'cdp' } },
        ]);
        await watch.cancel();
        await watch;
    });

    it('exposes separate connections through multiple frontends without observing frontend business traffic', async () => {
        const inspection = host();
        const cdp1 = pair();
        const cdp2 = pair();
        cdp1.remote.register(echo, { echo: params => params });
        cdp2.remote.register(echo, { echo: params => params });
        inspection.trackConnection(cdp1.local, {
            portId: 'cdp-1', peer: { nodeId: 'chrome-1', portId: 'browser-1' },
        });
        inspection.trackConnection(cdp2.local, { portId: 'cdp-2' });
        const front1 = pair();
        const front2 = pair();
        inspection.expose(front1.local, { serviceId: 'inspection', portId: 'frontend-1' });
        inspection.expose(front2.local, { serviceId: 'inspection', portId: 'frontend-2' });
        front1.local.register(echo, { echo: params => params });
        const first: TrafficEvent[] = [];
        const second: TrafficEvent[] = [];
        const watch1 = front1.remote.service('inspection').get(trafficInterface).watch({
            trafficIgnoreKey: 'first',
        }, { onMessage: value => { first.push(value); } });
        const watch2 = front2.remote.service('inspection').get(trafficInterface).watchWithPayloads({
            trafficIgnoreKey: 'second', maxPayloadBytes: 1024,
        }, { onMessage: value => { second.push(value); } });
        await cdp1.local.get(echo).echo({ value: 'one' });
        await cdp2.local.get(echo).echo({ value: 'two' });
        await front1.remote.get(echo).echo({ value: 'not-observed' });
        await vi.waitFor(() => expect(first).toHaveLength(4));
        await vi.waitFor(() => expect(second).toHaveLength(4));
        expect(first.filter(value => value.type === 'transit').map(value => ({
            nodeId: value.nodeId, portId: (value.in ?? value.out)?.portId,
            kind: value.kind, method: value.method,
        }))).toEqual([
            { nodeId: 'main', portId: 'cdp-1', kind: 'request', method: 'test.echo::echo' },
            { nodeId: 'main', portId: 'cdp-1', kind: 'response', method: 'test.echo::echo' },
            { nodeId: 'main', portId: 'cdp-2', kind: 'request', method: 'test.echo::echo' },
            { nodeId: 'main', portId: 'cdp-2', kind: 'response', method: 'test.echo::echo' },
        ]);
        expect(first[0]).not.toHaveProperty('params');
        expect(second[0]).toMatchObject({ params: { value: 'one' } });
        const graph = await front1.remote.service('inspection').get(topologyInterface).getGraph({});
        expect(graph).toEqual({
            observerServiceId: 'inspection', entryNodeId: 'main',
            nodes: [
                { nodeId: 'main', kind: 'endpoint', label: 'Main', ports: [
                    { portId: 'cdp-1' }, { portId: 'cdp-2' },
                    { portId: 'frontend-1' }, { portId: 'frontend-2' },
                ] },
                { nodeId: 'chrome-1', kind: 'endpoint', ports: [{ portId: 'browser-1' }] },
            ],
            links: [{
                from: { nodeId: 'main', portId: 'cdp-1' },
                to: { nodeId: 'chrome-1', portId: 'browser-1' }, peerState: 'identified',
            }],
            routes: [{ serviceId: 'inspection', nodeId: 'main', portId: 'frontend-1', match: 'exact' }],
        });
        await watch1.cancel();
        await watch1;
        expect(inspection.observerCount).toBe(1);
        await watch2.cancel();
        await watch2;
        expect(inspection.observerCount).toBe(0);
    });

    it('coalesces graph invalidations and removes closed or untracked connections', async () => {
        const inspection = host();
        const frontend = pair();
        inspection.expose(frontend.local, { serviceId: 'inspection', portId: 'frontend' });
        let ticks = 0;
        const watch = frontend.remote.service('inspection').get(topologyInterface).watchGraph({}, {
            onMessage: () => { ticks++; },
        });
        const first = pair();
        const second = pair();
        const tracked = inspection.trackConnection(first.local, { portId: 'first' });
        inspection.trackConnection(second.local, { portId: 'second' });
        await vi.waitFor(() => expect(ticks).toBe(1));
        tracked.dispose();
        second.local.close();
        await vi.waitFor(() => expect(ticks).toBe(2));
        expect(inspection.getGraph('').nodes[0].ports).toEqual([{ portId: 'frontend' }]);
        await watch.cancel();
        await expect(watch).resolves.toEqual({});
        inspection.trackConnection(pair().local, { portId: 'third' });
        await Promise.resolve();
        expect(ticks).toBe(2);
    });

    it('disposing a binding ends only its watches and leaves the observed connection usable', async () => {
        const inspection = host();
        const cdp = pair();
        cdp.remote.register(echo, { echo: params => params });
        inspection.trackConnection(cdp.local, { portId: 'cdp' });
        const front1 = pair();
        const front2 = pair();
        const binding = inspection.expose(front1.local, { serviceId: 'inspection' });
        inspection.expose(front2.local, { serviceId: 'inspection' });
        const events: TrafficEvent[] = [];
        const one = front1.remote.service('inspection').get(trafficInterface).watch({});
        const graph = front1.remote.service('inspection').get(topologyInterface).watchGraph({});
        const two = front2.remote.service('inspection').get(trafficInterface).watch({}, {
            onMessage: value => { events.push(value); },
        });
        expect(inspection.observerCount).toBe(2);
        binding.dispose();
        binding.dispose();
        await expect(one).resolves.toEqual({ delivered: 0, dropped: 0 });
        await expect(graph).resolves.toEqual({});
        await expect(front1.remote.service('inspection').get(nodeInterface).getNodeId({}))
            .rejects.toMatchObject({ code: -32601 });
        await expect(cdp.local.get(echo).echo({ value: 'still-alive' }))
            .resolves.toEqual({ value: 'still-alive' });
        await vi.waitFor(() => expect(events).toHaveLength(2));
        front2.local.close();
        expect(inspection.observerCount).toBe(0);
        // TransportPair has no remote-close signal; release the local pending call.
        void two.catch(() => {});
        front2.remote.close();
    });

    it('shares a wire connection with existing endpoint inspection', async () => {
        const inspection = host();
        const observed = pair();
        observed.remote.register(echo, { echo: params => params });
        const standalone = observed.local.enableInspection();
        const ownEvents: TrafficTransitEvent[] = [];
        standalone.observeTraffic(value => ownEvents.push(value));
        const track = inspection.trackConnection(observed.local, { portId: 'cdp' });
        const sharedEvents: TrafficTransitEvent[] = [];
        inspection.observeTraffic(value => sharedEvents.push(value));
        await observed.local.get(echo).echo({ value: 'both' });
        expect(ownEvents).toHaveLength(2);
        expect(sharedEvents).toHaveLength(2);
        track.dispose();
        await observed.local.get(echo).echo({ value: 'standalone' });
        expect(ownEvents).toHaveLength(4);
        expect(sharedEvents).toHaveLength(2);
    });

    it('bounds slow subscribers without delaying other subscribers', async () => {
        const inspection = host();
        const slow: TrafficEvent[] = [];
        const fast: TrafficEvent[] = [];
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const a = inspection.subscribe({}, async value => {
            slow.push(value);
            if (slow.length === 1) await blocked;
        });
        const b = inspection.subscribe({}, async value => { fast.push(value); });
        inspection.publishTransit(event());
        await vi.waitFor(() => expect(slow).toHaveLength(1));
        for (let i = 2; i <= 270; i++) {
            inspection.publishTransit(event(i));
            await Promise.resolve();
        }
        await vi.waitFor(() => expect(fast).toHaveLength(270));
        expect(slow).toHaveLength(1);
        release();
        await vi.waitFor(() => expect(slow).toHaveLength(258));
        expect(slow[1]).toEqual({ type: 'overflow', dropped: 13 });
        a.dispose();
        b.dispose();
        await expect(a.closed).resolves.toEqual({ delivered: 257, dropped: 13 });
        await expect(b.closed).resolves.toEqual({ delivered: 270, dropped: 0 });
    });

    it('rolls back failed exposure and rejects duplicate ports and use after disposal', async () => {
        const inspection = host();
        const frontend = pair();
        const existing = frontend.local.register(trafficInterface, {
            watch: () => ({ delivered: 0, dropped: 0 }),
            watchWithPayloads: () => ({ delivered: 0, dropped: 0 }),
        }, { serviceId: 'inspection' });
        expect(() => inspection.expose(frontend.local, { serviceId: 'inspection' })).toThrow('already registered');
        expect(inspection.getGraph('').nodes[0].ports).toEqual([]);
        await expect(frontend.remote.service('inspection').get(topologyInterface).getGraph({}))
            .rejects.toMatchObject({ code: -32601 });
        existing.dispose();
        inspection.expose(frontend.local, { serviceId: 'inspection' });
        inspection.trackConnection(pair().local, { portId: 'cdp' });
        expect(() => inspection.trackConnection(pair().local, { portId: 'cdp' })).toThrow('already registered');
        inspection.dispose();
        inspection.dispose();
        expect(() => inspection.subscribe({}, async () => {})).toThrow('disposed');
        expect(() => inspection.getGraph('')).toThrow('disposed');
    });

    it('subscribes to source topology changes and releases source registrations', async () => {
        const inspection = host();
        let invalidate = () => {};
        const topologyDisposed = vi.fn();
        const trafficDisposed = vi.fn();
        const fragment: TopologyFragment = { nodes: [], links: [], routes: [] };
        const source: InspectionSource = {
            snapshotTopology: () => fragment,
            onTopologyChanged: listener => {
                invalidate = listener;
                return { dispose: topologyDisposed };
            },
            observeTraffic: () => ({ dispose: trafficDisposed }),
        };
        const registration = inspection.addSource(source);
        const frontend = pair();
        inspection.expose(frontend.local, { serviceId: 'inspection' });
        let ticks = 0;
        const graph = frontend.remote.service('inspection').get(topologyInterface).watchGraph({}, {
            onMessage: () => { ticks++; },
        });
        fragment.nodes.push({ nodeId: 'remote', ports: [{ portId: 'remote-port' }] });
        invalidate();
        await vi.waitFor(() => expect(ticks).toBe(1));
        expect(inspection.getGraph('').nodes[1].nodeId).toBe('remote');
        registration.dispose();
        expect(topologyDisposed).toHaveBeenCalledTimes(1);
        expect(trafficDisposed).toHaveBeenCalledTimes(1);
        await graph.cancel();
        await graph;
    });

    it('retires unfinished watch flows when a source removes their port', () => {
        const inspection = host();
        let invalidate = () => {};
        let emit = (_event: TrafficTransitEvent) => {};
        const fragment: TopologyFragment = {
            nodes: [{ nodeId: 'main', ports: [{ portId: 'cdp' }] }],
            links: [], routes: [],
        };
        inspection.addSource({
            snapshotTopology: () => fragment,
            onTopologyChanged: listener => {
                invalidate = listener;
                return { dispose: () => {} };
            },
            observeTraffic: listener => {
                emit = listener;
                return { dispose: () => {} };
            },
        });
        emit({
            ...event(), method: 'svc::hubrpc.traffic::watch',
            params: { trafficIgnoreKey: 'removed' },
        });
        fragment.nodes[0].ports = [];
        invalidate();
        expect(() => inspection.subscribe({ trafficIgnoreKey: 'removed' }, async () => {}))
            .toThrow('not observed');
        const events: TrafficTransitEvent[] = [];
        inspection.observeTraffic(value => events.push(value));
        emit(event());
        expect(events).toHaveLength(1);
    });

    it('keeps replacement source registrations when an old disposer is called again', () => {
        const inspection = host();
        const disposeTraffic = vi.fn();
        const source: InspectionSource = {
            snapshotTopology: () => ({
                nodes: [{ nodeId: 'peer', ports: [{ portId: 'peer-port' }] }],
                links: [], routes: [],
            }),
            onTopologyChanged: () => ({ dispose: () => {} }),
            observeTraffic: () => ({ dispose: disposeTraffic }),
        };
        const first = inspection.addSource(source);
        first.dispose();
        inspection.addSource(source);
        first.dispose();
        expect(inspection.getGraph('').nodes.some(node => node.nodeId === 'peer')).toBe(true);
        expect(disposeTraffic).toHaveBeenCalledTimes(1);
        inspection.dispose();
        expect(disposeTraffic).toHaveBeenCalledTimes(2);
    });
});
