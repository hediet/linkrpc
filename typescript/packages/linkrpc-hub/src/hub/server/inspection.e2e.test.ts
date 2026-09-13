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
} from '@hediet/linkrpc-infra/inspection';
import type { TopologyIdGenerator, TrafficTransitEvent } from '@hediet/linkrpc/inspection';
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
        const disposableStore = new AsyncDisposableStore();
        try {
            const hubA = new Hub({ generateTopologyId: topologyIds('hub-a'), debugName: 'Hub A' });
            const hubB = new Hub({ generateTopologyId: topologyIds('hub-b'), debugName: 'Hub B' });
            const servicesA = disposableStore.add(createHubServiceInterfaces(hubA, { hubServiceId: 'hub-a' }));
            const servicesB = disposableStore.add(createHubServiceInterfaces(hubB, { hubServiceId: 'hub-b' }));

            const nesting = new TransportPair();
            const aToB = disposableStore.add(hubA.attach(nesting.a));
            const bToA = disposableStore.add(hubB.attach(nesting.b));
            hubB.setUplink(nesting.b);
            aToB.addPrefixRoute('hub-b');
            aToB.addPrefixRoute('beta');

            const alpha = disposableStore.add(attachService(hubA, 'alpha', ({ value }) => ({ value: `alpha:${value}` })));
            const beta = disposableStore.add(attachService(hubB, 'beta', ({ value }) => ({ value: `beta:${value}` })));

            const observer = LinkRpcConnection.fromTransport(disposableStore.add(hubB.attachOut()).transport);
            disposableStore.defer(() => observer.close());

            const network = disposableStore.add(new NetworkInspectionClient(observer));
            const nodeInfo = new NodeInfoClient(observer);
            const traffic: Array<{ source: string; transit: TrafficTransitEvent; }> = [];
            const alphaTraffic: TrafficTransitEvent[] = [];
            const betaTraffic: TrafficTransitEvent[] = [];
            const endpointWatches: TrafficWatch[] = [];
            let latestGraph: NetworkTopologyGraph | undefined;

            await network.addTopologyService('hub-a');
            await network.addTopologyService('hub-b');
            await waitFor(() => {
                const graph = network.getGraph();
                return graph.routes.some((route) => route.serviceId === 'alpha' && route.nodeId === alpha.nodeId)
                    && graph.routes.some((route) => route.serviceId === 'beta' && route.nodeId === beta.nodeId)
                    && graph.links.some((link) => link.sources.length === 2);
            });
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
                  "hubA": "hub-a-node-1",
                  "hubB": "hub-b-node-1",
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
            for (const watch of endpointWatches) {
                disposableStore.defer(async () => {
                    await watch.cancel('test-cleanup');
                    await watch.done;
                });
            }
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
                          "in": {
                            "edgeId": "alpha",
                            "portId": "hub-a-port-4",
                            "requestId": 1,
                          },
                          "kind": "request",
                          "method": "beta::test.echo::echo",
                          "node": "hub-a",
                          "out": {
                            "edgeId": "hub-b",
                            "portId": "hub-a-port-3",
                            "requestId": 12,
                          },
                        },
                        {
                          "disposition": "forwarded",
                          "in": {
                            "edgeId": "hub-b",
                            "portId": "hub-a-port-3",
                            "requestId": 12,
                          },
                          "kind": "response",
                          "method": "beta::test.echo::echo",
                          "node": "hub-a",
                          "out": {
                            "edgeId": "alpha",
                            "portId": "hub-a-port-4",
                            "requestId": 1,
                          },
                        },
                      ],
                      "source": "hub-a",
                    },
                    {
                      "consistent": true,
                      "events": [
                        {
                          "disposition": "forwarded",
                          "in": {
                            "edgeId": "uplink",
                            "portId": "hub-b-port-3",
                            "requestId": 12,
                          },
                          "kind": "request",
                          "method": "beta::test.echo::echo",
                          "node": "hub-b",
                          "out": {
                            "edgeId": "beta",
                            "portId": "hub-b-port-4",
                            "requestId": 22,
                          },
                        },
                        {
                          "disposition": "forwarded",
                          "in": {
                            "edgeId": "beta",
                            "portId": "hub-b-port-4",
                            "requestId": 22,
                          },
                          "kind": "response",
                          "method": "beta::test.echo::echo",
                          "node": "hub-b",
                          "out": {
                            "edgeId": "uplink",
                            "portId": "hub-b-port-3",
                            "requestId": 12,
                          },
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
                      "in": undefined,
                      "kind": "request",
                      "method": "beta::test.echo::echo",
                      "node": "alpha",
                      "out": {
                        "edgeId": "alpha-port-2",
                        "portId": "alpha-port-2",
                        "requestId": 1,
                      },
                      "payload": "<omitted>",
                    },
                    {
                      "direction": "inbound",
                      "disposition": "consumed",
                      "in": {
                        "edgeId": "alpha-port-2",
                        "portId": "alpha-port-2",
                        "requestId": 1,
                      },
                      "kind": "response",
                      "method": "beta::test.echo::echo",
                      "node": "alpha",
                      "out": undefined,
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
                      "in": {
                        "edgeId": "beta-port-2",
                        "portId": "beta-port-2",
                        "requestId": 22,
                      },
                      "kind": "request",
                      "method": "beta::test.echo::echo",
                      "node": "beta",
                      "out": undefined,
                      "payload": "{"value":"he",
                    },
                    {
                      "direction": "outbound",
                      "disposition": "forwarded",
                      "in": undefined,
                      "kind": "response",
                      "method": "beta::test.echo::echo",
                      "node": "beta",
                      "out": {
                        "edgeId": "beta-port-2",
                        "portId": "beta-port-2",
                        "requestId": 22,
                      },
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

            const gamma = disposableStore.add(attachService(
                hubA,
                'gamma',
                ({ value }) => ({ value: `gamma:${value}` }),
            ));
            nodeNames.set(gamma.nodeId, 'gamma');
            await waitFor(() =>
                network.getGraph().routes.some((service) =>
                    service.serviceId === 'gamma' && service.nodeId === gamma.nodeId));
            const topologyAfterAdd = summarizeParticipantTopology(
                network.getGraph(),
                gamma.nodeId,
                nodeNames,
            );

            const gammaNodeId = gamma.nodeId;
            disposableStore.remove(gamma).dispose();
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
            await disposableStore.dispose();
        }
    });

    it('follows an ongoing stream from a farther hub on the closer hub', async () => {
        const disposableStore = new AsyncDisposableStore();
        try {
            const hubA = new Hub({ generateTopologyId: topologyIds('hub-a') });
            const hubB = new Hub({ generateTopologyId: topologyIds('hub-b') });
            const servicesA = disposableStore.add(createHubServiceInterfaces(hubA, { hubServiceId: 'hub-a' }));
            const servicesB = disposableStore.add(createHubServiceInterfaces(hubB, { hubServiceId: 'hub-b' }));

            const nesting = new TransportPair();
            const aToB = disposableStore.add(hubA.attach(nesting.a));
            const bToA = disposableStore.add(hubB.attach(nesting.b));
            hubB.setUplink(nesting.b);
            aToB.addPrefixRoute('hub-b');
            aToB.addPrefixRoute('beta');

            const alphaLink = disposableStore.add(hubA.attachOut());
            alphaLink.addPrefixRoute('alpha');
            const alpha = LinkRpcConnection.fromTransport(alphaLink.transport, {
                generateTopologyId: topologyIds('alpha'),
            });
            disposableStore.defer(() => alpha.close());

            const betaLink = disposableStore.add(hubB.attachOut());
            betaLink.addPrefixRoute('beta');
            const beta = LinkRpcConnection.fromTransport(betaLink.transport, {
                generateTopologyId: topologyIds('beta'),
            });
            disposableStore.defer(() => beta.close());
            let releaseSecondFrame!: () => void;
            const secondFrame = new Promise<void>((resolve) => releaseSecondFrame = resolve);
            disposableStore.defer(() => releaseSecondFrame());
            beta.service('beta').register(streamingInterface, {
                run: async (_params, _ctx, stream) => {
                    await stream.send({ step: 1 });
                    await secondFrame;
                    await stream.send({ step: 2 });
                    return { done: true };
                },
            });

            const observer = LinkRpcConnection.fromTransport(disposableStore.add(hubB.attachOut()).transport);
            disposableStore.defer(() => observer.close());
            const fartherEvents: TrafficTransitEvent[] = [];
            const closerEvents: TrafficTransitEvent[] = [];
            const frames: number[] = [];
            const fartherWatch = new TrafficClient(observer, 'hub-a').watchWithPayloads(
                { maxPayloadBytes: 1_000_000 },
                { onTransit: (transit) => fartherEvents.push(transit) },
            );
            disposableStore.defer(async () => {
                await fartherWatch.cancel('test-cleanup');
                await fartherWatch.done;
            });

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
            const closerWatch = new TrafficClient(observer, 'hub-b').watchWithPayloads(
                {
                    maxPayloadBytes: 1_000_000,
                    focusRequest: {
                        portId: bToA.portId,
                        requestId: fartherRequest.out!.requestId!,
                    },
                },
                { onTransit: (transit) => closerEvents.push(transit) },
            );
            disposableStore.defer(async () => {
                await closerWatch.cancel('test-cleanup');
                await closerWatch.done;
            });
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
            await disposableStore.dispose();
        }
    });
});

function attachService(
    hub: Hub,
    serviceId: string,
    echo: (params: { value: string }) => { value: string },
): ServiceParticipant {
    const link = hub.attachOut();
    link.addPrefixRoute(serviceId);
    const connection = LinkRpcConnection.fromTransport(link.transport, {
        generateTopologyId: topologyIds(serviceId),
    });
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
                    in: transit.in,
                    out: transit.out,
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
            in: transit.in,
            out: transit.out,
            payload: transit.kind === 'request'
                ? ('params' in transit ? transit.params : '<omitted>')
                : ('result' in transit ? transit.result : '<omitted>'),
            node: nodeNames.get(transit.nodeId) ?? transit.nodeId,
        })),
    };
}

function topologyIds(participant: string): TopologyIdGenerator {
    let nextId = 0;
    return (kind) => `${participant}-${kind}-${++nextId}`;
}

interface AsyncDisposable {
    dispose(): void | Promise<void>;
}

/** Test cleanup in reverse acquisition order, awaiting each resource before its dependencies. */
class AsyncDisposableStore {
    private readonly _items: AsyncDisposable[] = [];
    private _disposal: Promise<void> | undefined;

    public add<T extends AsyncDisposable>(item: T): T {
        if (this._disposal !== undefined) throw new Error('Disposable store is already disposed');
        this._items.push(item);
        return item;
    }

    public defer(dispose: () => void | Promise<void>): void {
        this.add({ dispose });
    }

    public remove<T extends AsyncDisposable>(item: T): T {
        const index = this._items.indexOf(item);
        if (index !== -1) this._items.splice(index, 1);
        return item;
    }

    public dispose(): Promise<void> {
        return this._disposal ??= Promise.resolve().then(async () => {
            const errors: unknown[] = [];
            for (const item of this._items.splice(0).reverse()) {
                try {
                    await item.dispose();
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length !== 0) throw new AggregateError(errors, 'Test cleanup failed');
        });
    }
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
