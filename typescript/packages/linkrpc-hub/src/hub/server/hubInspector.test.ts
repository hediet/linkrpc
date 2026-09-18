import { describe, expect, it } from 'vitest';
import {
    directoryInterface,
    ErrorCode,
    LinkRpcConnection,
    isResponse,
    type IMessageTransport,
    type JsonRpcMessage,
    type JsonRpcRequest,
    type JsonRpcResponse,
    TransportPair,
} from '@hediet/linkrpc';
import { TopologyClient, TrafficClient } from '@hediet/linkrpc-infra/inspection';
import { topologyInterface, type TrafficTransitEvent } from '@hediet/linkrpc/inspection';
import { createHubServiceInterfaces } from './hubServices';
import { HubInspector } from './hubInspector';
import { Hub } from './routing/routingHub';

class Endpoint {
    private _nextId = 1000;
    private readonly _pending = new Map<string, (response: JsonRpcResponse) => void>();
    public readonly inbox: JsonRpcMessage[] = [];

    constructor(public readonly transport: IMessageTransport) {
        transport.setListener((message) => {
            if (isResponse(message) && message.id !== null) {
                const resolve = this._pending.get(String(message.id));
                if (resolve !== undefined) {
                    this._pending.delete(String(message.id));
                    resolve(message);
                    return;
                }
            }
            this.inbox.push(message);
        });
    }

    public request(method: string, params: unknown): Promise<JsonRpcResponse> {
        const id = this._nextId++;
        const result = new Promise<JsonRpcResponse>((resolve) => {
            this._pending.set(String(id), resolve);
        });
        void this.transport.send({
            jsonrpc: '2.0',
            id,
            method,
            params,
        } as JsonRpcRequest);
        return result;
    }

    public respond(request: JsonRpcRequest, result: unknown): void {
        void this.transport.send({ jsonrpc: '2.0', id: request.id, result });
    }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

describe('Hub dynamic transit observation', () => {
    it('does not build transit endpoints while observer count is zero', async () => {
        const hub = new Hub();
        (hub as unknown as { _transitEndpoint(): never; })._transitEndpoint = () => {
            throw new Error('transit allocation attempted');
        };
        const callerPair = new TransportPair();
        hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);
        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const response = caller.request('calc::math::add', {});
        await waitFor(() => owner.inbox.length === 1);
        owner.respond(owner.inbox[0] as JsonRpcRequest, 1);

        await expect(response).resolves.toMatchObject({ result: 1 });
        expect(hub.transitObserverCount).toBe(0);
    });

    it('subscribes dynamically and isolates observer failures from routing', async () => {
        const hub = new Hub();
        const seen: string[] = [];
        const failing = hub.observeTransits(() => {
            throw new Error('observer failed');
        });
        const working = hub.observeTransits((transit) => seen.push(transit.kind));
        expect(hub.transitObserverCount).toBe(2);

        const callerPair = new TransportPair();
        hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);
        const ownerPair = new TransportPair();
        hub.claimPrefix(ownerPair.a, 'calc');
        const owner = new Endpoint(ownerPair.b);

        const response = caller.request('calc::math::add', { a: 1 });
        await waitFor(() => owner.inbox.length === 1);
        owner.respond(owner.inbox[0] as JsonRpcRequest, 1);
        await expect(response).resolves.toMatchObject({ result: 1 });
        expect(seen).toEqual(['request', 'response']);

        failing.dispose();
        working.dispose();
        expect(hub.transitObserverCount).toBe(0);
    });

    it('preserves onTransit as an initial observer', () => {
        const hub = new Hub({ onTransit: () => undefined });
        expect(hub.transitObserverCount).toBe(1);
    });
});

describe('HubInspector', () => {
    it('reports every managed routing transit without correlation', async () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const inspector = new HubInspector(hub);
        const events: TrafficTransitEvent[] = [];
        const subscription = inspector.subscribe({}, async (event) => {
            if (event.type === 'transit') events.push(event);
        });

        hub.publishManagedTransit({
            timeMs: 1,
            nodeId: 'overlay-a',
            in: { edgeId: 'app', requestId: 7 },
            out: { edgeId: 'shared', requestId: 7 },
            disposition: 'forwarded',
            kind: 'request',
            method: 'target::service::call',
        });
        hub.publishManagedTransit({
            timeMs: 2,
            nodeId: 'hub-a',
            in: { edgeId: 'shared', requestId: 7 },
            out: { edgeId: 'target', requestId: 12 },
            disposition: 'forwarded',
            kind: 'request',
            method: 'target::service::call',
        });
        hub.publishManagedTransit({
            timeMs: 3,
            nodeId: 'hub-a',
            in: { edgeId: 'target', requestId: 12 },
            out: { edgeId: 'shared', requestId: 7 },
            disposition: 'forwarded',
            kind: 'response',
            result: { ok: true },
        });
        hub.publishManagedTransit({
            timeMs: 4,
            nodeId: 'overlay-a',
            in: { edgeId: 'shared', requestId: 7 },
            out: { edgeId: 'app', requestId: 7 },
            disposition: 'forwarded',
            kind: 'response',
            result: { ok: true },
        });
        await waitFor(() => events.length === 4);

        expect(events).toMatchInlineSnapshot(`
          [
            {
              "disposition": "forwarded",
              "in": {
                "edgeId": "app",
                "portId": "app",
                "requestId": 7,
              },
              "kind": "request",
              "method": "target::service::call",
              "nodeId": "overlay-a",
              "out": {
                "edgeId": "shared",
                "portId": "shared",
                "requestId": 7,
              },
              "timeMs": 1,
              "type": "transit",
            },
            {
              "disposition": "forwarded",
              "in": {
                "edgeId": "shared",
                "portId": "shared",
                "requestId": 7,
              },
              "kind": "request",
              "method": "target::service::call",
              "nodeId": "hub-a",
              "out": {
                "edgeId": "target",
                "portId": "target",
                "requestId": 12,
              },
              "timeMs": 2,
              "type": "transit",
            },
            {
              "disposition": "forwarded",
              "in": {
                "edgeId": "target",
                "portId": "target",
                "requestId": 12,
              },
              "kind": "response",
              "method": undefined,
              "nodeId": "hub-a",
              "out": {
                "edgeId": "shared",
                "portId": "shared",
                "requestId": 7,
              },
              "timeMs": 3,
              "type": "transit",
            },
            {
              "disposition": "forwarded",
              "in": {
                "edgeId": "shared",
                "portId": "shared",
                "requestId": 7,
              },
              "kind": "response",
              "method": undefined,
              "nodeId": "overlay-a",
              "out": {
                "edgeId": "app",
                "portId": "app",
                "requestId": 7,
              },
              "timeMs": 4,
              "type": "transit",
            },
          ]
        `);

        subscription.dispose();
        inspector.dispose();
    });

    it('activates managed endpoint traffic sources only while watched', async () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const inspector = new HubInspector(hub);
        let sourceObserver: ((transit: TrafficTransitEvent) => void) | undefined;
        let sourceActive = false;
        const source = inspector.addTrafficSource({
            observe: (observer) => {
                sourceActive = true;
                sourceObserver = observer;
                return {
                    dispose: () => {
                        sourceActive = false;
                        sourceObserver = undefined;
                    },
                };
            },
        });
        const events: TrafficTransitEvent[] = [];

        expect(sourceActive).toBe(false);
        const subscription = inspector.subscribe({}, async (event) => {
            if (event.type === 'transit') events.push(event);
        });
        expect(sourceActive).toBe(true);
        sourceObserver?.({
            type: 'transit',
            timeMs: 1,
            nodeId: 'shell-node',
            in: {
                edgeId: 'shell',
                portId: 'shell-port',
                requestId: 'shell-message',
            },
            disposition: 'consumed',
            kind: 'notification',
            method: 'shell::ready',
            params: { ready: true },
        });
        await waitFor(() => events.length === 1);
        expect(events[0]).not.toHaveProperty('params');

        subscription.dispose();
        await subscription.closed;
        expect(sourceActive).toBe(false);
        source.dispose();
        inspector.dispose();
    });

    it('observes raw request/response traffic using topology ports', async () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const inspector = new HubInspector(hub);
        const events: TrafficTransitEvent[] = [];
        const subscription = inspector.subscribe(
            { maxPayloadBytes: 1024 },
            async (event) => {
                if (event.type === 'transit') events.push(event);
            },
        );
        expect(hub.transitObserverCount).toBe(1);

        const callerPair = new TransportPair();
        const callerLink = hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);
        const ownerPair = new TransportPair();
        const ownerLink = hub.attach(ownerPair.a);
        ownerLink.addPrefixRoute('calc');
        const owner = new Endpoint(ownerPair.b);

        const response = caller.request('calc::math::add', { a: 1 });
        await waitFor(() => owner.inbox.length === 1);
        owner.respond(owner.inbox[0] as JsonRpcRequest, { sum: 1 });
        await response;
        await waitFor(() => events.length === 2);

        expect(events.map((event) => event.kind)).toEqual(['request', 'response']);
        expect(events[0].params).toEqual({ a: 1 });
        expect(events[1].result).toEqual({ sum: 1 });
        expect([events[0].in?.portId, events[0].out?.portId])
            .toEqual([callerLink.portId, ownerLink.portId]);
        expect([events[1].in?.portId, events[1].out?.portId])
            .toEqual([ownerLink.portId, callerLink.portId]);

        subscription.dispose();
        await expect(subscription.closed).resolves.toEqual({ delivered: 2, dropped: 0 });
        expect(hub.transitObserverCount).toBe(1);
    });

    it('filters methods and removes payloads per subscriber', async () => {
        const hub = new Hub();
        const inspector = new HubInspector(hub);
        const events: TrafficTransitEvent[] = [];
        const subscription = inspector.subscribe(
            { methodPrefix: 'calc::' },
            async (event) => {
                if (event.type === 'transit') events.push(event);
            },
        );
        const callerPair = new TransportPair();
        hub.attach(callerPair.a);
        const caller = new Endpoint(callerPair.b);

        await caller.request('other::iface::call', { secret: true });
        await caller.request('calc::iface::call', { secret: true });
        await waitFor(() => events.length === 1);

        expect(events[0]).not.toHaveProperty('params');
        subscription.dispose();
        inspector.dispose();
    });

    it('reports the raw failed forwarding transit', async () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const inspector = new HubInspector(hub);
        const events: TrafficTransitEvent[] = [];
        const subscription = inspector.subscribe({}, async (event) => {
            if (event.type === 'transit') events.push(event);
        });
        const callerLink = hub.attachOut();
        const connection = LinkRpcConnection.fromTransport(callerLink.transport);
        const target: IMessageTransport = {
            send: () => Promise.reject(new Error('send failed')),
            setListener: () => { },
            dispose: () => { },
        };
        hub.claimPrefix(target, 'broken');

        await expect(connection.service('broken').get(directoryInterface).list({}))
            .rejects.toMatchObject({ code: ErrorCode.peerDisconnected });
        await waitFor(() => events.length >= 2);
        expect(events.map(({ kind, disposition }) => ({ kind, disposition })))
            .toMatchInlineSnapshot(`
              [
                {
                  "disposition": "forwarded",
                  "kind": "request",
                },
                {
                  "disposition": "dropped",
                  "kind": "response",
                },
              ]
            `);
        expect(hub.pendingRequests()).toHaveLength(0);

        subscription.dispose();
        inspector.dispose();
        connection.close();
        callerLink.dispose();
    });
});

describe('hub traffic services', () => {
    it('runs demand handlers before serving the global directory', async () => {
        const hub = new Hub();
        let directoryQueried = false;
        const services = createHubServiceInterfaces(hub, {
            beforeDirectoryQuery: () => {
                directoryQueried = true;
            },
        });

        await services.connection.service(services.hubServiceId)
            .get(directoryInterface)
            .list({});

        expect(directoryQueried).toBe(true);
        services.dispose();
    });

    it('observes inspection calls, excludes only its own lifecycle, and cancels cleanly', async () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const services = createHubServiceInterfaces(hub);
        const callerLink = hub.attachOut();
        const connection = LinkRpcConnection.fromTransport(callerLink.transport);
        const events: TrafficTransitEvent[] = [];
        const traffic = new TrafficClient(connection, services.hubServiceId);
        const watch = traffic.watch({}, {
            onTransit: (event) => events.push(event),
        });
        await waitFor(() => services.inspector.observerCount === 1);
        expect(hub.transitObserverCount).toBe(1);

        await connection.service(services.hubServiceId)
            .get(topologyInterface)
            .getGraph({});
        await waitFor(() => events.length === 2);
        expect(events.map((event) => event.method)).toEqual([
            `${services.hubServiceId}::hubrpc.topology::getGraph`,
            `${services.hubServiceId}::hubrpc.topology::getGraph`,
        ]);

        await connection.service(services.hubServiceId)
            .get(directoryInterface)
            .list({});
        await waitFor(() =>
            events.filter((event) =>
                event.method === `${services.hubServiceId}::hubrpc.directory::list`
            ).length === 2,
        );
        expect(events.some((event) =>
            event.method?.includes('hubrpc.traffic')
        )).toBe(false);

        await watch.cancel();
        await watch.done;
        expect(services.inspector.observerCount).toBe(0);
        expect(hub.transitObserverCount).toBe(1);

        connection.close();
        callerLink.dispose();
        services.dispose();
    });

    it('prevents concurrent traffic watches from observing each other', async () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const services = createHubServiceInterfaces(hub);
        const callerLink = hub.attachOut();
        const connection = LinkRpcConnection.fromTransport(callerLink.transport);
        const firstEvents: TrafficTransitEvent[] = [];
        const secondEvents: TrafficTransitEvent[] = [];
        const traffic = new TrafficClient(connection, services.hubServiceId);
        const first = traffic.watch({}, {
            onTransit: (event) => firstEvents.push(event),
        });
        const second = traffic.watch({}, {
            onTransit: (event) => secondEvents.push(event),
        });

        await waitFor(() => services.inspector.observerCount === 2);
        await connection.service(services.hubServiceId)
            .get(directoryInterface)
            .list({});
        await waitFor(() =>
            firstEvents.some((event) => event.kind === 'response')
            && secondEvents.some((event) => event.kind === 'response'),
        );

        expect(firstEvents.every((event) =>
            !event.method?.includes('hubrpc.traffic')
        )).toBe(true);
        expect(secondEvents.every((event) =>
            !event.method?.includes('hubrpc.traffic')
        )).toBe(true);
        await Promise.all([
            first.cancel('test-complete'),
            second.cancel('test-complete'),
        ]);

        connection.close();
        callerLink.dispose();
        services.dispose();
    });

    it('advertises topology and traffic interfaces through reflection', async () => {
        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        const listing = await services.connection.service(services.hubServiceId)
            .get(directoryInterface)
            .list({});
        const ids = listing.items.map((item) => item.interfaceId);

        expect(ids).toContain('hubrpc.topology');
        expect(ids).toContain('hubrpc.traffic');
        services.dispose();
    });

    it('releases topology watchers when Hub services are disposed', async () => {
        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        const callerLink = hub.attachOut();
        const connection = LinkRpcConnection.fromTransport(callerLink.transport);
        const watch = new TopologyClient(connection, services.hubServiceId).watch({
            onGraph: () => { },
        });
        await watch.ready;
        await waitFor(() => hub.topologyObserverCount === 1);

        services.dispose();
        await waitFor(() => hub.topologyObserverCount === 0);
        await watch.done.catch(() => undefined);

        connection.close();
        callerLink.dispose();
    });
});
