import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    defineInterface,
    LinkRpcConnection,
    requestType,
    TransportPair,
} from '@hediet/linkrpc';
import {
    NetworkInspectionClient,
    NodeInfoClient,
    TrafficClient,
    type NetworkTopologyGraph,
    type TrafficWatch,
} from '@hediet/linkrpc/hub/client';
import type { TrafficTransitEvent } from '@hediet/linkrpc/hub/common';
import { createHubServiceInterfaces } from './hubServices';
import { Hub, type AttachedLink } from './routing/routingHub';

const echoInterface = defineInterface(
    { id: 'test.echo' },
    {
        echo: requestType(
            z.object({ value: z.string() }),
            z.object({ value: z.string() }),
        ),
    },
);

const streamingInterface = defineInterface(
    { id: 'test.streaming' },
    {
        run: requestType(
            z.object({}),
            z.object({ done: z.boolean() }),
        ).withStream({
            server: z.object({ step: z.number() }),
        }),
    },
);

interface ServiceParticipant {
    readonly connection: LinkRpcConnection;
    readonly link: AttachedLink;
    readonly nodeId: string;
    dispose(): void;
}

describe('federated Hub inspection', () => {
    it('inspects federated topology and routed participant traffic end to end', async () => {
        const hubA = new Hub({ nodeId: 'hub-a-node', debugName: 'Hub A' });
        const hubB = new Hub({ nodeId: 'hub-b-node', debugName: 'Hub B' });
        const servicesA = createHubServiceInterfaces(hubA, { hubServiceId: 'hub-a' });
        const servicesB = createHubServiceInterfaces(hubB, { hubServiceId: 'hub-b' });

        const nesting = new TransportPair();
        const aToB = hubA.attach(nesting.a);
        const bToA = hubB.attach(nesting.b);
        hubB.setUplink(nesting.b);
        aToB.claimPrefix('hub-b');
        aToB.claimPrefix('beta');

        const alpha = attachService(hubA, 'alpha', ({ value }) => ({ value: `alpha:${value}` }));
        const beta = attachService(hubB, 'beta', ({ value }) => ({ value: `beta:${value}` }));

        const observerLink = hubB.attachOut();
        const observer = LinkRpcConnection.fromTransport(observerLink.transport);

        const network = new NetworkInspectionClient(observer);
        const nodeInfo = new NodeInfoClient(observer);
        const traffic: Array<{ source: string; transit: TrafficTransitEvent; }> = [];
        const alphaTraffic: TrafficTransitEvent[] = [];
        const betaTraffic: TrafficTransitEvent[] = [];
        const endpointWatches: TrafficWatch[] = [];
        let latestGraph: NetworkTopologyGraph | undefined;
        let gamma: ServiceParticipant | undefined;

        try {
            await Promise.all([
                aToB.identifyPeer(),
                bToA.identifyPeer(),
                alpha.link.identifyPeer(),
                beta.link.identifyPeer(),
            ]);

            await network.addTopologyService('hub-a');
            await network.addTopologyService('hub-b');
            latestGraph = network.getGraph();

            const nodeNames = new Map([
                [hubA.nodeId, 'hub-a'],
                [hubB.nodeId, 'hub-b'],
                [alpha.nodeId, 'alpha'],
                [beta.nodeId, 'beta'],
            ]);
            expect({
                serviceNodeIds: {
                    hubA: (await nodeInfo.getForService('hub-a')).nodeId,
                    hubB: (await nodeInfo.getForService('hub-b')).nodeId,
                },
                graph: summarizeGraph(latestGraph, nodeNames),
            }).toMatchInlineSnapshot(`
              {
                "graph": {
                  "links": [
                    {
                      "between": [
                        "alpha",
                        "hub-a",
                      ],
                      "sources": [
                        "hub-a",
                      ],
                    },
                    {
                      "between": [
                        "beta",
                        "hub-b",
                      ],
                      "sources": [
                        "hub-b",
                      ],
                    },
                    {
                      "between": [
                        "hub-a",
                        "hub-b",
                      ],
                      "sources": [
                        "hub-a",
                        "hub-b",
                      ],
                    },
                    {
                      "between": [
                        "hub-b",
                        "unidentified-1",
                      ],
                      "sources": [
                        "hub-b",
                      ],
                    },
                  ],
                  "nodes": [
                    {
                      "kind": "endpoint",
                      "node": "alpha",
                      "sources": [
                        "hub-a",
                      ],
                    },
                    {
                      "kind": "endpoint",
                      "node": "beta",
                      "sources": [
                        "hub-b",
                      ],
                    },
                    {
                      "kind": "hub",
                      "node": "hub-a",
                      "sources": [
                        "hub-a",
                        "hub-b",
                      ],
                    },
                    {
                      "kind": "hub",
                      "node": "hub-b",
                      "sources": [
                        "hub-a",
                        "hub-b",
                      ],
                    },
                    {
                      "kind": "endpoint",
                      "node": "unidentified-1",
                      "sources": [
                        "hub-b",
                      ],
                    },
                  ],
                  "services": [
                    {
                      "node": "alpha",
                      "serviceId": "alpha",
                      "sources": [
                        "hub-a",
                      ],
                    },
                    {
                      "node": "beta",
                      "serviceId": "beta",
                      "sources": [
                        "hub-b",
                      ],
                    },
                    {
                      "node": "hub-b",
                      "serviceId": "beta",
                      "sources": [
                        "hub-a",
                      ],
                    },
                    {
                      "node": "hub-a",
                      "serviceId": "hub-a",
                      "sources": [
                        "hub-a",
                      ],
                    },
                    {
                      "node": "hub-b",
                      "serviceId": "hub-b",
                      "sources": [
                        "hub-a",
                      ],
                    },
                    {
                      "node": "hub-b",
                      "serviceId": "hub-b",
                      "sources": [
                        "hub-b",
                      ],
                    },
                  ],
                },
                "serviceNodeIds": {
                  "hubA": "hub-a-node",
                  "hubB": "hub-b-node",
                },
              }
            `);

            endpointWatches.push(
                new TrafficClient(observer, 'alpha').watch(
                    { methodPrefix: 'beta::test.echo::echo' },
                    { onTransit: (transit) => alphaTraffic.push(transit) },
                ),
                new TrafficClient(observer, 'beta').watchWithPayloads(
                    {
                        methodPrefix: 'beta::test.echo::echo',
                        maxPayloadBytes: 12,
                    },
                    { onTransit: (transit) => betaTraffic.push(transit) },
                ),
            );
            await waitFor(() =>
                alpha.connection.trafficObserverCount === 1
                && beta.connection.trafficObserverCount === 1);
            const trafficWatch = network.watchTraffic(
                {},
                {
                    onTransit: (transit, source) => traffic.push({ source, transit }),
                },
            );
            await waitFor(() =>
                servicesA.inspector.observerCount === 1
                && servicesB.inspector.observerCount === 1);

            const response = await alpha.connection
                .service('beta')
                .get(echoInterface)
                .echo({ value: 'hello' });

            await waitFor(() =>
                traffic.some(({ source, transit }) =>
                    source === 'hub-a'
                    && transit.kind === 'response')
                && traffic.some(({ source, transit }) =>
                    source === 'hub-b'
                    && transit.kind === 'response')
                && alphaTraffic.some((transit) => transit.kind === 'response')
                && betaTraffic.some((transit) => transit.kind === 'response'));
            expect({
                response,
                traffic: summarizeTraffic(traffic, nodeNames),
            }).toMatchInlineSnapshot(`
              {
                "response": {
                  "value": "beta:hello",
                },
                "traffic": {
                  "inspectionTrafficObserved": false,
                  "sources": [
                    {
                      "consistent": true,
                      "events": [
                        {
                          "disposition": "forwarded",
                          "hasIn": true,
                          "hasOut": true,
                          "kind": "request",
                          "method": "beta::test.echo::echo",
                          "node": "hub-a",
                        },
                        {
                          "disposition": "forwarded",
                          "hasIn": true,
                          "hasOut": true,
                          "kind": "response",
                          "method": "beta::test.echo::echo",
                          "node": "hub-a",
                        },
                      ],
                      "source": "hub-a",
                    },
                    {
                      "consistent": true,
                      "events": [
                        {
                          "disposition": "forwarded",
                          "hasIn": true,
                          "hasOut": true,
                          "kind": "request",
                          "method": "beta::test.echo::echo",
                          "node": "hub-b",
                        },
                        {
                          "disposition": "forwarded",
                          "hasIn": true,
                          "hasOut": true,
                          "kind": "response",
                          "method": "beta::test.echo::echo",
                          "node": "hub-b",
                        },
                      ],
                      "source": "hub-b",
                    },
                  ],
                },
              }
            `);
            expect({
                alpha: summarizeEndpointTraffic(alphaTraffic, nodeNames),
                beta: summarizeEndpointTraffic(betaTraffic, nodeNames),
            }).toMatchInlineSnapshot(`
              {
                "alpha": {
                  "consistent": true,
                  "events": [
                    {
                      "direction": "outbound",
                      "disposition": "forwarded",
                      "kind": "request",
                      "method": "beta::test.echo::echo",
                      "node": "alpha",
                      "payload": "<omitted>",
                    },
                    {
                      "direction": "inbound",
                      "disposition": "consumed",
                      "kind": "response",
                      "method": "beta::test.echo::echo",
                      "node": "alpha",
                      "payload": "<omitted>",
                    },
                  ],
                },
                "beta": {
                  "consistent": true,
                  "events": [
                    {
                      "direction": "inbound",
                      "disposition": "consumed",
                      "kind": "request",
                      "method": "beta::test.echo::echo",
                      "node": "beta",
                      "payload": "{"value":"he",
                    },
                    {
                      "direction": "outbound",
                      "disposition": "forwarded",
                      "kind": "response",
                      "method": "beta::test.echo::echo",
                      "node": "beta",
                      "payload": "{"value":"be",
                    },
                  ],
                },
              }
            `);

            await Promise.all(endpointWatches.map((watch) => watch.cancel('test-complete')));
            await Promise.all(endpointWatches.map((watch) => watch.done));
            endpointWatches.length = 0;
            await waitFor(() =>
                alpha.connection.trafficObserverCount === 0
                && beta.connection.trafficObserverCount === 0);

            gamma = attachService(
                hubA,
                'gamma',
                ({ value }) => ({ value: `gamma:${value}` }),
            );
            nodeNames.set(gamma.nodeId, 'gamma');
            await gamma.link.identifyPeer();
            await waitFor(() =>
                network.getGraph().routes.some((service) =>
                    service.serviceId === 'gamma' && service.nodeId === gamma?.nodeId));
            const topologyAfterAdd = summarizeParticipantTopology(
                network.getGraph(),
                gamma.nodeId,
                nodeNames,
            );

            const gammaNodeId = gamma.nodeId;
            gamma.dispose();
            gamma = undefined;
            await waitFor(() =>
                !network.getGraph().routes.some((service) =>
                    service.serviceId === 'gamma'));
            expect({
                afterAdd: topologyAfterAdd,
                afterRemove: summarizeParticipantTopology(
                    network.getGraph(),
                    gammaNodeId,
                    nodeNames,
                ),
            }).toMatchInlineSnapshot(`
              {
                "afterAdd": {
                  "kind": "endpoint",
                  "links": [
                    {
                      "between": [
                        "gamma",
                        "hub-a",
                      ],
                      "sources": [
                        "hub-a",
                      ],
                    },
                  ],
                  "node": "gamma",
                  "services": [
                    {
                      "serviceId": "gamma",
                      "sources": [
                        "hub-a",
                      ],
                    },
                  ],
                  "sources": [
                    "hub-a",
                  ],
                },
                "afterRemove": null,
              }
            `);

            await trafficWatch.cancel('test-complete');
            await trafficWatch.done;
            await waitFor(() =>
                servicesA.inspector.observerCount === 0
                && servicesB.inspector.observerCount === 0);
        } finally {
            await Promise.allSettled(endpointWatches.map(async (watch) => {
                await watch.cancel('test-cleanup');
                await watch.done;
            }));
            gamma?.dispose();
            await network.dispose();
            observer.close();
            observerLink.dispose();
            alpha.dispose();
            beta.dispose();
            servicesA.dispose();
            servicesB.dispose();
            aToB.dispose();
            bToA.dispose();
        }
    });

    it('follows an ongoing stream from a farther hub on the closer hub', async () => {
        const hubA = new Hub({ nodeId: 'hub-a-node' });
        const hubB = new Hub({ nodeId: 'hub-b-node' });
        const servicesA = createHubServiceInterfaces(hubA, { hubServiceId: 'hub-a' });
        const servicesB = createHubServiceInterfaces(hubB, { hubServiceId: 'hub-b' });

        const nesting = new TransportPair();
        const aToB = hubA.attach(nesting.a);
        const bToA = hubB.attach(nesting.b);
        hubB.setUplink(nesting.b);
        aToB.claimPrefix('hub-b');
        aToB.claimPrefix('beta');

        const alphaLink = hubA.attachOut();
        alphaLink.claimPrefix('alpha');
        const alpha = LinkRpcConnection.fromTransport(alphaLink.transport);

        const betaLink = hubB.attachOut();
        betaLink.claimPrefix('beta');
        const beta = LinkRpcConnection.fromTransport(betaLink.transport);
        let releaseSecondFrame!: () => void;
        const secondFrame = new Promise<void>((resolve) => releaseSecondFrame = resolve);
        beta.service('beta').register(streamingInterface, {
            run: async (_params, _ctx, stream) => {
                await stream.send({ step: 1 });
                await secondFrame;
                await stream.send({ step: 2 });
                return { done: true };
            },
        });

        const observerLink = hubB.attachOut();
        const observer = LinkRpcConnection.fromTransport(observerLink.transport);
        const fartherEvents: TrafficTransitEvent[] = [];
        const closerEvents: TrafficTransitEvent[] = [];
        const frames: number[] = [];
        const fartherWatch = new TrafficClient(observer, 'hub-a').watchWithPayloads(
            { maxPayloadBytes: 1_000_000 },
            { onTransit: (transit) => fartherEvents.push(transit) },
        );
        let closerWatch: TrafficWatch | undefined;

        try {
            await waitFor(() => servicesA.inspector.observerCount === 1);
            const call = alpha.service('beta').get(streamingInterface).run({}, {
                onMessage: ({ step }) => frames.push(step),
            });
            await waitFor(() =>
                frames.includes(1)
                && fartherEvents.some((event) =>
                    event.kind === 'request'
                    && event.method === 'beta::test.streaming::run'),
            );

            const fartherRequest = fartherEvents.find((event) =>
                event.kind === 'request'
                && event.method === 'beta::test.streaming::run'
            )!;
            expect(fartherRequest.out?.requestId).toBeDefined();
            closerWatch = new TrafficClient(observer, 'hub-b').watchWithPayloads(
                {
                    maxPayloadBytes: 1_000_000,
                    focusRequest: {
                        portId: bToA.portId,
                        requestId: fartherRequest.out!.requestId!,
                    },
                },
                { onTransit: (transit) => closerEvents.push(transit) },
            );
            await waitFor(() => servicesB.inspector.observerCount === 1);

            releaseSecondFrame();
            await expect(call).resolves.toEqual({ done: true });
            await waitFor(() =>
                closerEvents.some((event) => event.kind === 'stream')
                && closerEvents.some((event) => event.kind === 'response'),
            );

            expect(frames).toEqual([1, 2]);
            expect(closerEvents.map((event) => event.kind)).toEqual([
                'stream',
                'response',
            ]);
            expect(closerEvents[0].params).toMatchObject({
                payload: { step: 2 },
            });
            expect(closerEvents[1].result).toEqual({ done: true });
            expect(closerEvents.some((event) =>
                event.method?.includes('hubrpc.traffic')
            )).toBe(false);
        } finally {
            releaseSecondFrame();
            await closerWatch?.cancel('test-cleanup').catch(() => undefined);
            await fartherWatch.cancel('test-cleanup').catch(() => undefined);
            observer.close();
            observerLink.dispose();
            alpha.close();
            alphaLink.dispose();
            beta.close();
            betaLink.dispose();
            servicesA.dispose();
            servicesB.dispose();
            aToB.dispose();
            bToA.dispose();
        }
    });
});

function attachService(
    hub: Hub,
    serviceId: string,
    echo: (params: { value: string }) => { value: string },
): ServiceParticipant {
    const link = hub.attachOut();
    link.claimPrefix(serviceId);
    const connection = LinkRpcConnection.fromTransport(link.transport);
    const inspection = connection.enableInspection();
    connection.service(serviceId).register(echoInterface, { echo });
    return {
        connection,
        link,
        nodeId: inspection.nodeId,
        dispose: () => {
            connection.close();
            link.dispose();
        },
    };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('Timed out waiting for inspection state');
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

function summarizeGraph(
    graph: NetworkTopologyGraph,
    nodeNames: Map<string, string>,
) {
    let nextUnidentified = 1;
    const nameOf = (nodeId: string): string => {
        let name = nodeNames.get(nodeId);
        if (name === undefined) {
            name = `unidentified-${nextUnidentified++}`;
            nodeNames.set(nodeId, name);
        }
        return name;
    };
    return {
        nodes: graph.nodes
            .map((node) => ({
                node: nameOf(node.nodeId),
                kind: node.kind ?? 'endpoint',
                sources: node.sources,
            }))
            .sort((a, b) => a.node.localeCompare(b.node)),
        links: graph.links
            .map((link) => ({
                between: [nameOf(link.from.nodeId), nameOf(link.to.nodeId)].sort(),
                sources: link.sources,
            }))
            .sort((a, b) => a.between.join(':').localeCompare(b.between.join(':'))),
        services: graph.routes
            .map((service) => ({
                serviceId: service.serviceId,
                node: nameOf(service.nodeId),
                sources: service.sources,
            }))
            .sort((a, b) =>
                a.serviceId.localeCompare(b.serviceId)
                || a.node.localeCompare(b.node)
                || a.sources.join('\0').localeCompare(b.sources.join('\0'))),
    };
}

function summarizeTraffic(
    traffic: Array<{ source: string; transit: TrafficTransitEvent; }>,
    nodeNames: Map<string, string>,
) {
    return {
        inspectionTrafficObserved: traffic.some(({ transit }) =>
            transit.method?.includes('hubrpc.topology')
            || transit.method?.includes('hubrpc.traffic')),
        sources: ['hub-a', 'hub-b'].map((source) => {
            const transits = traffic
                .filter((entry) => entry.source === source)
                .map((entry) => entry.transit);
            const request = transits.find((transit) => transit.kind === 'request');
            const response = transits.find((transit) => transit.kind === 'response');
            return {
                source,
                consistent: request?.in?.requestId === response?.out?.requestId
                    && request?.out?.requestId === response?.in?.requestId,
                events: transits.map((transit) => ({
                    kind: transit.kind,
                    method: transit.method,
                    disposition: transit.disposition,
                    node: nodeNames.get(transit.nodeId) ?? transit.nodeId,
                    hasIn: transit.in !== undefined,
                    hasOut: transit.out !== undefined,
                })),
            };
        }),
    };
}

function summarizeEndpointTraffic(
    transits: readonly TrafficTransitEvent[],
    nodeNames: Map<string, string>,
) {
    const request = transits.find((transit) => transit.kind === 'request');
    const response = transits.find((transit) => transit.kind === 'response');
    return {
        consistent: request?.in?.requestId === response?.out?.requestId
            || request?.out?.requestId === response?.in?.requestId,
        events: transits.map((transit) => ({
            kind: transit.kind,
            method: transit.method,
            disposition: transit.disposition,
            direction: transit.in !== undefined ? 'inbound' : 'outbound',
            payload: transit.kind === 'request'
                ? ('params' in transit ? transit.params : '<omitted>')
                : ('result' in transit ? transit.result : '<omitted>'),
            node: nodeNames.get(transit.nodeId) ?? transit.nodeId,
        })),
    };
}

function summarizeParticipantTopology(
    graph: NetworkTopologyGraph,
    nodeId: string,
    nodeNames: Map<string, string>,
) {
    const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (node === undefined) return null;
    return {
        node: nodeNames.get(nodeId) ?? nodeId,
        kind: node.kind ?? 'endpoint',
        sources: node.sources,
        links: graph.links
            .filter((link) => link.from.nodeId === nodeId || link.to.nodeId === nodeId)
            .map((link) => ({
                between: [
                    nodeNames.get(link.from.nodeId) ?? link.from.nodeId,
                    nodeNames.get(link.to.nodeId) ?? link.to.nodeId,
                ].sort(),
                sources: link.sources,
            })),
        services: graph.routes
            .filter((service) => service.nodeId === nodeId)
            .map((service) => ({
                serviceId: service.serviceId,
                sources: service.sources,
            })),
    };
}
