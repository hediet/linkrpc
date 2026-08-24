import { describe, expect, it } from 'vitest';
import {
    ErrorCode,
    HubRpcConnection,
    type IMessageTransport,
    type JsonRpcRequest,
    TransportPair,
} from '@vscode/hubrpc';
import { nodeInterface } from '@vscode/hubrpc/hub/common';
import { Hub } from './routingHub';

describe('Hub topology', () => {
    it('generates node identity independently of debugName and honors an override', () => {
        const first = new Hub({ debugName: 'friendly' });
        const second = new Hub({ debugName: 'friendly' });

        expect(first.nodeId).not.toBe('friendly');
        expect(first.nodeId).not.toBe(second.nodeId);
        expect(new Hub({ nodeId: 'fixed', debugName: 'friendly' }).nodeId).toBe('fixed');
    });

    it('keeps a stable topology port while the friendly edge label changes', () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const pair = new TransportPair();
        const attached = hub.attach(pair.a);
        const portId = attached.portId;

        attached.claimPrefix('calc');
        const graph = hub.getTopologyGraph('observer');

        expect(attached.portId).toBe(portId);
        expect(graph.nodes.find((node) => node.nodeId === hub.nodeId)?.ports)
            .toContainEqual({ portId, label: 'calc' });
        expect(attached.edgeId).toBeTruthy();
    });

    it('publishes transport information for a directly attached link', () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const pair = new TransportPair();
        hub.attach(pair.a, {
            transport: {
                type: 'websocket',
                remote: { address: '203.0.113.8', port: 4242 },
                path: '/rpc',
            },
        });

        expect(hub.getTopologyGraph('observer').links[0]?.transport).toEqual({
            type: 'websocket',
            remote: { address: '203.0.113.8', port: 4242 },
            path: '/rpc',
        });
    });

    it('serves exact root getNodeId on the incoming link instead of loopback', async () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const loopback = new TransportPair();
        const loopbackMessages: unknown[] = [];
        loopback.b.setListener((message) => loopbackMessages.push(message));
        hub.setLoopback(loopback.a);
        const link = hub.attachOut();
        const connection = HubRpcConnection.fromTransport(link.transport);
        await new Promise((resolve) => setTimeout(resolve, 0));
        loopbackMessages.length = 0;

        const result = await connection.get(nodeInterface).getNodeId({});

        expect(result).toEqual({ nodeId: 'hub-a', portId: link.portId });
        expect(loopbackMessages).toHaveLength(0);
        connection.close();
        link.dispose();
    });

    it('identifies two connected hubs and produces reciprocal mergeable endpoints', async () => {
        const first = new Hub({ nodeId: 'hub-a' });
        const second = new Hub({ nodeId: 'hub-b' });
        const pair = new TransportPair();
        const firstLink = first.attach(pair.a);
        const secondLink = second.attach(pair.b);

        await expect(firstLink.identifyPeer()).resolves.toEqual({
            nodeId: second.nodeId,
            portId: secondLink.portId,
        });

        await expect(secondLink.identifyPeer()).resolves.toEqual({
            nodeId: first.nodeId,
            portId: firstLink.portId,
        });
        await expect(firstLink.identifyPeer()).resolves.toEqual({
            nodeId: second.nodeId,
            portId: secondLink.portId,
        });

        const firstEdge = first.getTopologyGraph('a').links[0];
        const secondEdge = second.getTopologyGraph('b').links[0];
        expect(firstEdge).toMatchObject({
            from: { nodeId: first.nodeId, portId: firstLink.portId },
            to: { nodeId: second.nodeId, portId: secondLink.portId },
        });
        expect(secondEdge).toMatchObject({
            from: firstEdge.to,
            to: firstEdge.from,
        });
    });

    it('uses stable unresolved-peer placeholders and exposes route claims', () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const pair = new TransportPair();
        const link = hub.attach(pair.a);
        link.claimPrefix('calc');

        const left = hub.getTopologyGraph('left');
        const right = hub.getTopologyGraph('right');
        const leftPeer = left.links[0].to;
        const rightPeer = right.links[0].to;

        expect(leftPeer.nodeId).toBe(rightPeer.nodeId);
        expect(left.routes).toEqual([{
            serviceId: 'calc',
            nodeId: leftPeer.nodeId,
            portId: leftPeer.portId,
            match: 'prefix',
        }]);
        expect(left.nodes.some((node) => node.nodeId === leftPeer.nodeId)).toBe(true);
    });

    it('places a managed routing node between the hub and its participant', () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const pair = new TransportPair();
        const attached = hub.attach(pair.a, { edgeId: 'webEditor1~uplink' });
        attached.claimPrefix('web-app');
        const registration = hub.registerManagedRoutingTopology(attached, {
            node: {
                nodeId: 'webEditor1~overlay',
                kind: 'hub',
                label: 'webEditor1 overlay',
                ports: [
                    { portId: 'webEditor1~app', label: 'app' },
                    { portId: 'webEditor1~root', label: 'root' },
                    { portId: attached.portId, label: 'uplink' },
                ],
            },
            hubLinks: [
                {
                    hubPortId: attached.portId,
                    nodePortId: attached.portId,
                    label: attached.edgeId,
                },
            ],
            peerPortId: 'webEditor1~app',
            peerLinkLabel: 'webEditor1~app',
            adjacentNodes: [{
                nodeId: 'webEditor1~root-services',
                kind: 'endpoint',
                ports: [{ portId: 'webEditor1~root' }],
            }],
            adjacentLinks: [{
                from: { nodeId: 'webEditor1~overlay', portId: 'webEditor1~root' },
                to: { nodeId: 'webEditor1~root-services', portId: 'webEditor1~root' },
            }],
        });

        const summarize = () => {
            const graph = hub.getTopologyGraph('observer');
            const service = graph.routes[0];
            const normalizeNode = (nodeId: string) =>
                nodeId === service.nodeId ? 'participant' : nodeId;
            const normalizePort = (portId: string) => {
                if (portId === attached.portId) return 'uplink-port';
                if (portId === service.portId) return 'participant-port';
                return portId;
            };
            return {
                nodes: graph.nodes.map((node) => ({
                    id: normalizeNode(node.nodeId),
                    kind: node.kind,
                    ports: node.ports.map((port) => normalizePort(port.portId)),
                })),
                links: graph.links.map((link) => ({
                    from: `${normalizeNode(link.from.nodeId)}:${normalizePort(link.from.portId)}`,
                    to: `${normalizeNode(link.to.nodeId)}:${normalizePort(link.to.portId)}`,
                    label: link.label,
                })),
                services: graph.routes.map((item) => ({
                    id: item.serviceId,
                    node: normalizeNode(item.nodeId),
                })),
            };
        };

        const managed = summarize();
        registration.dispose();
        const direct = summarize();

        expect({ managed, direct }).toMatchInlineSnapshot(`
          {
            "direct": {
              "links": [
                {
                  "from": "hub-a:uplink-port",
                  "label": "webEditor1~uplink",
                  "to": "participant:participant-port",
                },
              ],
              "nodes": [
                {
                  "id": "hub-a",
                  "kind": "hub",
                  "ports": [
                    "uplink-port",
                  ],
                },
                {
                  "id": "participant",
                  "kind": undefined,
                  "ports": [
                    "participant-port",
                  ],
                },
              ],
              "services": [
                {
                  "id": "web-app",
                  "node": "participant",
                },
              ],
            },
            "managed": {
              "links": [
                {
                  "from": "hub-a:uplink-port",
                  "label": "webEditor1~uplink",
                  "to": "webEditor1~overlay:uplink-port",
                },
                {
                  "from": "webEditor1~overlay:webEditor1~app",
                  "label": "webEditor1~app",
                  "to": "participant:participant-port",
                },
                {
                  "from": "webEditor1~overlay:webEditor1~root",
                  "label": undefined,
                  "to": "webEditor1~root-services:webEditor1~root",
                },
              ],
              "nodes": [
                {
                  "id": "hub-a",
                  "kind": "hub",
                  "ports": [
                    "uplink-port",
                  ],
                },
                {
                  "id": "participant",
                  "kind": undefined,
                  "ports": [
                    "participant-port",
                  ],
                },
                {
                  "id": "webEditor1~overlay",
                  "kind": "hub",
                  "ports": [
                    "webEditor1~app",
                    "webEditor1~root",
                    "uplink-port",
                  ],
                },
                {
                  "id": "webEditor1~root-services",
                  "kind": "endpoint",
                  "ports": [
                    "webEditor1~root",
                  ],
                },
              ],
              "services": [
                {
                  "id": "web-app",
                  "node": "participant",
                },
              ],
            },
          }
        `);
    });

    it('includes and removes an in-process endpoint topology fragment', () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const registration = hub.registerManagedTopologyFragment({
            nodes: [{
                nodeId: 'shell-host',
                kind: 'endpoint',
                label: 'Shell Access Host',
                ports: [{ portId: 'shell-port' }],
            }],
        });

        const summarize = () => hub.getTopologyGraph('observer').nodes.map((node) => ({
            id: node.nodeId,
            kind: node.kind,
            label: node.label,
            ports: node.ports.map((port) => port.portId),
        }));
        const registered = summarize();
        registration.dispose();
        const disposed = summarize();

        expect({ registered, disposed }).toMatchInlineSnapshot(`
          {
            "disposed": [
              {
                "id": "hub-a",
                "kind": "hub",
                "label": undefined,
                "ports": [],
              },
            ],
            "registered": [
              {
                "id": "hub-a",
                "kind": "hub",
                "label": undefined,
                "ports": [],
              },
              {
                "id": "shell-host",
                "kind": "endpoint",
                "label": "Shell Access Host",
                "ports": [
                  "shell-port",
                ],
              },
            ],
          }
        `);
    });

    it('rejects invalid peer identity results explicitly', async () => {
        const hub = new Hub();
        const pair = new TransportPair();
        const link = hub.attach(pair.a);
        pair.b.setListener((message) => {
            const request = message as JsonRpcRequest;
            void pair.b.send({ jsonrpc: '2.0', id: request.id, result: { nodeId: '' } });
        });

        await expect(link.identifyPeer()).rejects.toThrow(/invalid result/);
        expect(hub.getTopologyGraph('observer').links[0].to.nodeId)
            .toContain(':unidentified:');
    });

    it('cleans up peer identification when transport send rejects', async () => {
        const hub = new Hub();
        const transport: IMessageTransport = {
            send: () => Promise.reject(new Error('send failed')),
            setListener: () => { },
            dispose: () => { },
        };
        const link = hub.attach(transport);

        await expect(link.identifyPeer()).rejects.toThrow(/send failed/);
        expect(hub.pendingRequests()).toHaveLength(0);
    });

    it('removes the underlying request when peer identification times out', async () => {
        const hub = new Hub({ peerIdentificationTimeoutMs: 10 });
        const pair = new TransportPair();
        const link = hub.attach(pair.a);
        const received: unknown[] = [];
        pair.b.setListener((message) => received.push(message));

        await expect(link.identifyPeer()).rejects.toThrow(/timed out after 10ms/);
        expect(hub.pendingRequests()).toHaveLength(0);
        expect(hub.getTopologyGraph('observer').links[0]?.peerState).toBe('error');
        expect(received).toContainEqual(expect.objectContaining({
            method: '$stream::send',
            params: expect.objectContaining({
                control: expect.objectContaining({ type: 'cancel' }),
            }),
        }));
    });

    it('fails the caller and clears pending state when routed send rejects', async () => {
        const hub = new Hub();
        const caller = hub.attachOut();
        const connection = HubRpcConnection.fromTransport(caller.transport);
        const target: IMessageTransport = {
            send: () => Promise.reject(new Error('route send failed')),
            setListener: () => { },
            dispose: () => { },
        };
        hub.claimPrefix(target, 'broken');

        await expect(connection.service('broken').get(nodeInterface).getNodeId({}))
            .rejects.toMatchObject({ code: ErrorCode.peerDisconnected });
        expect(hub.pendingRequests()).toHaveLength(0);

        connection.close();
        caller.dispose();
    });

    it('notifies topology watchers for attach, identify, claim, release, roles, and detach', async () => {
        const first = new Hub();
        const second = new Hub();
        let changes = 0;
        first.onDidChangeRouting(() => changes++);
        const pair = new TransportPair();
        const link = first.attach(pair.a);
        second.attach(pair.b);
        await link.identifyPeer();
        link.claimPrefix('svc');
        link.releasePrefix('svc');
        first.setUplink(pair.a);
        first.setLoopback(pair.a);
        link.dispose();

        expect(changes).toBeGreaterThanOrEqual(7);
    });
});
