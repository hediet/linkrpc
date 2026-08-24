import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LinkRpcConnection } from '../../connection/linkRpcConnection';
import { defineInterface } from '../../connection/interfaceDefinition';
import { requestType } from '../../schema/memberTypes';
import { TransportPair } from '../../transport/messageTransport';
import { topologyInterface } from '../common/inspection.interfaces';
import { mergeTopologyGraphs, NetworkInspectionClient } from './networkInspectionClient';
import { NodeInfoClient } from './nodeInfoClient';
import { TopologyClient } from './topologyClient';
import { TrafficClient } from './trafficClient';

const pingInterface = defineInterface(
    { id: 'test.client-ping' },
    { ping: requestType(z.object({}), z.object({ ok: z.boolean() })) },
);

function makePair() {
    const pair = new TransportPair();
    const client = LinkRpcConnection.fromTransport(pair.a);
    const server = LinkRpcConnection.fromTransport(pair.b);
    return {
        client,
        server,
        dispose: () => {
            client.close();
            server.close();
        },
    };
}

describe('inspection clients', () => {
    it('gets root and service node identity', async () => {
        const { client, server, dispose } = makePair();
        server.service('one').register(pingInterface, {
            ping: () => ({ ok: true }),
        });
        server.enableInspection();
        const nodes = new NodeInfoClient(client);

        await expect(nodes.getForService('one')).resolves.toEqual(await nodes.getPeer());
        await expect(nodes.getForService('missing')).rejects.toMatchObject({ code: -32601 });
        dispose();
    });

    it('watches an initial topology snapshot and cancels explicitly', async () => {
        const { client, server, dispose } = makePair();
        server.service('one').register(pingInterface, {
            ping: () => ({ ok: true }),
        });
        server.enableInspection();
        const received: string[] = [];
        const watch = new TopologyClient(client, 'one').watch({
            onGraph: (graph) => received.push(graph.observerServiceId),
        });

        await expect(watch.ready).resolves.toMatchObject({ observerServiceId: 'one' });
        expect(received).toEqual(['one']);
        await watch.cancel();
        await watch.done;
        dispose();
    });

    it('releases a topology watch locally when the provider ignores cancellation', async () => {
        const { client, server, dispose } = makePair();
        const graph = {
            observerServiceId: 'one',
            entryNodeId: 'node',
            nodes: [{ nodeId: 'node', ports: [{ portId: 'port' }] }],
            links: [],
            routes: [],
        };
        server.service('one').register(topologyInterface, {
            getGraph: () => graph,
            watchGraph: () => new Promise(() => {}),
        });
        const watch = new TopologyClient(client, 'one').watch({ onGraph: () => {} });

        await expect(watch.ready).resolves.toEqual(graph);
        await watch.cancel('test complete');
        await expect(watch.done).rejects.toMatchObject({
            code: -32800,
            message: 'test complete',
        });
        dispose();
    });

    it('isolates topology callback failures from watch lifecycle', async () => {
        const { client, server, dispose } = makePair();
        server.service('one').register(pingInterface, {
            ping: () => ({ ok: true }),
        });
        server.enableInspection();
        const errors: unknown[] = [];
        const watch = new TopologyClient(client, 'one').watch({
            onGraph: () => {
                throw new Error('consumer failed');
            },
            onError: (error) => errors.push(error),
        });

        await expect(watch.ready).resolves.toMatchObject({ observerServiceId: 'one' });
        expect(errors).toHaveLength(1);
        await watch.cancel();
        await watch.done;
        dispose();
    });

    it('merges service graphs by shared endpoint node with provenance', async () => {
        const { client, server, dispose } = makePair();
        server.service('one').register(pingInterface, {
            ping: () => ({ ok: true }),
        });
        server.service('two').register(pingInterface, {
            ping: () => ({ ok: true }),
        });
        server.enableInspection();

        const network = new NetworkInspectionClient(client);
        await Promise.all([
            network.addTopologyService('one'),
            network.addTopologyService('two'),
        ]);
        const graph = network.getGraph();

        expect(graph.nodes).toHaveLength(1);
        expect(graph.nodes[0].sources).toEqual(['one', 'two']);
        expect(graph.nodes[0].ports).toHaveLength(1);
        expect(graph.routes).toHaveLength(2);
        expect(graph.sources.map((source) => source.serviceId).sort()).toEqual(['one', 'two']);

        const traffic = network.watchTraffic({}, { onTransit: () => { } });
        await waitFor(() => server.trafficObserverCount === 2);
        await network.removeTopologyService('one');
        expect(server.trafficObserverCount).toBe(1);
        expect(network.getGraph().nodes[0].sources).toEqual(['two']);
        await traffic.cancel();
        await network.dispose();
        dispose();
    });

    it('deterministically merges participant descriptors and port details', () => {
        const inputs = [
            {
                source: 'b',
                graph: {
                    observerServiceId: 'b',
                    entryNodeId: 'shared',
                    nodes: [{
                        nodeId: 'shared',
                        kind: 'hub' as const,
                        label: 'Secondary',
                        descriptors: [{
                            source: 'attacher' as const,
                            descriptor: { label: 'Attached', metadata: { z: 1, a: true } },
                        }],
                        ports: [
                            { portId: 'p', label: 'Primary port' },
                            { portId: 'q' },
                        ],
                    }],
                    links: [],
                    routes: [],
                },
            },
            {
                source: 'a',
                graph: {
                    observerServiceId: 'a',
                    entryNodeId: 'shared',
                    nodes: [{
                        nodeId: 'shared',
                        kind: 'endpoint' as const,
                        label: 'Primary',
                        descriptors: [{
                            source: 'self' as const,
                            descriptor: { label: 'Self' },
                        }],
                        ports: [{ portId: 'p' }],
                    }],
                    links: [],
                    routes: [],
                },
            },
        ];

        const merged = mergeTopologyGraphs(inputs);

        expect(merged).toEqual(mergeTopologyGraphs([...inputs].reverse()));
        expect(merged.nodes[0]).toMatchObject({
            nodeId: 'shared',
            kind: 'hub',
            label: 'Primary',
            ports: [
                { portId: 'p', label: 'Primary port' },
                { portId: 'q' },
            ],
            descriptors: [
                { source: 'attacher', descriptor: { label: 'Attached' } },
                { source: 'self', descriptor: { label: 'Self' } },
            ],
            sources: ['a', 'b'],
        });
    });

    it('preserves and orients transport details while merging duplicate links', () => {
        const nodes = [
            { nodeId: 'a', ports: [{ portId: 'in' }] },
            { nodeId: 'z', ports: [{ portId: 'out' }] },
        ];
        const inputs: { source: string; graph: TopologyGraph; }[] = [
            {
                source: 'a',
                graph: {
                    observerServiceId: 'a',
                    entryNodeId: 'a',
                    nodes,
                    links: [{
                        from: { nodeId: 'a', portId: 'in' },
                        to: { nodeId: 'z', portId: 'out' },
                    }],
                    routes: [],
                },
            },
            {
                source: 'b',
                graph: {
                    observerServiceId: 'b',
                    entryNodeId: 'z',
                    nodes,
                    links: [{
                        from: { nodeId: 'z', portId: 'out' },
                        to: { nodeId: 'a', portId: 'in' },
                        transport: {
                            type: 'websocket',
                            local: { address: 'server-z', port: 443 },
                            remote: { address: 'client-a', port: 12345 },
                            metadata: { forwardedFor: 'client.example' },
                        },
                    }],
                    routes: [],
                },
            },
        ];

        const merged = mergeTopologyGraphs(inputs);

        expect(merged).toEqual(mergeTopologyGraphs([...inputs].reverse()));
        expect(merged.links).toEqual([{
            from: { nodeId: 'a', portId: 'in' },
            to: { nodeId: 'z', portId: 'out' },
            transport: {
                type: 'websocket',
                local: { address: 'client-a', port: 12345 },
                remote: { address: 'server-z', port: 443 },
                metadata: { forwardedFor: 'client.example' },
            },
            sources: ['a', 'b'],
        }]);
    });

    it('omits a missing transport endpoint when reversing a topology link', () => {
        const merged = mergeTopologyGraphs([{
            source: 'observer',
            graph: {
                observerServiceId: 'observer',
                entryNodeId: 'z',
                nodes: [
                    { nodeId: 'a', ports: [{ portId: 'in' }] },
                    { nodeId: 'z', ports: [{ portId: 'out' }] },
                ],
                links: [{
                    from: { nodeId: 'z', portId: 'out' },
                    to: { nodeId: 'a', portId: 'in' },
                    transport: {
                        type: 'websocket',
                        local: { address: 'server-z', port: 443 },
                    },
                }],
                routes: [],
            },
        }]);

        expect(merged.links[0]?.transport).toEqual({
            type: 'websocket',
            remote: { address: 'server-z', port: 443 },
        });
    });

    it('isolates traffic callback failures without terminating the watch', async () => {
        const { client, server, dispose } = makePair();
        server.service('one').register(pingInterface, {
            ping: () => ({ ok: true }),
        });
        server.enableInspection();
        const observed: string[] = [];
        const errors: unknown[] = [];
        const watch = new TrafficClient(client, 'one').watch({}, {
            onTransit: (transit) => {
                observed.push(transit.method ?? '');
                throw new Error('consumer failed');
            },
            onError: (error) => errors.push(error),
        });
        await waitFor(() => server.trafficObserverCount === 1);

        await client.service('one').get(pingInterface).ping({});
        await waitFor(() => observed.length >= 2);
        const firstCount = observed.length;
        await client.service('one').get(pingInterface).ping({});
        await waitFor(() => observed.length > firstCount);

        expect(errors.length).toBe(observed.length);
        await watch.cancel();
        await watch.done;
        dispose();
    });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}
