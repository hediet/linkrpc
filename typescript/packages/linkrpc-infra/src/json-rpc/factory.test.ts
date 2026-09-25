import { describe, expect, it, vi } from 'vitest';
import { defineInterface, LinkRpcConnection, notificationType, requestType, RpcError, TransportPair, type JsonValue } from '@hediet/linkrpc';
import { number, object, string } from 'zod/mini';
import { createJsonRpcBridgeInterface } from './bridgeInterface';
import { connectManagedJsonRpc, connectRawJsonRpcTransport } from './client';
import { registerJsonRpcConnectionFactory } from './factory';
import { jsonRpcConnectionFactoryInterface, jsonRpcConnectionInterface, jsonRpcManagedConnectionInterface } from './interface';
import { JsonRpcTransportPair, type JsonRpcTransport } from './transport';

const calculator = defineInterface({ id: 'test.jsonRpcCalculator' }, {
    add: requestType(object({ a: number(), b: number() }), object({ sum: number() })),
    log: notificationType(object({ text: string() })),
});

function setup() {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    const transports: JsonRpcTransportPair[] = [];
    const registration = registerJsonRpcConnectionFactory({
        connection: server,
        serviceId: 'test-json-rpc',
        profile: {
            interfaces: [{ source: calculator, bridge: createJsonRpcBridgeInterface(calculator, { acknowledgeNotifications: ['log'] }) }],
            reverseRequestPolicy: 'queue',
            openTransport: async () => {
                const transport = new JsonRpcTransportPair();
                transports.push(transport);
                transport.b.onMessage((frame) => {
                    if (typeof frame !== 'object' || frame === null || Array.isArray(frame) || !('method' in frame)) return;
                    if (frame.method === 'add') {
                        const params = frame.params as { a: number; b: number };
                        void transport.b.send({ jsonrpc: '2.0', id: frame.id, result: { sum: params.a + params.b } } as JsonValue);
                    }
                });
                return transport.a;
            },
        },
    });
    const service = client.service('test-json-rpc');
    return { server, client, service, registration, transports };
}

describe('typed JSON-RPC connection factory', () => {
    it('preserves the raw interface and exposes managed operations separately', () => {
        expect(jsonRpcConnectionInterface.info.id).toBe('jsonRpcConnection');
        expect(Object.keys(jsonRpcConnectionInterface.members)).toEqual(['connectRaw']);
        expect(jsonRpcManagedConnectionInterface.info.id).toBe('jsonRpcManagedConnection');
        expect(jsonRpcConnectionFactoryInterface).toBe(jsonRpcManagedConnectionInterface);
        expect(jsonRpcConnectionFactoryInterface.info.id).not.toBe(jsonRpcConnectionInterface.info.id);
    });

    it('routes typed calls over persistent and ephemeral peers and acknowledges notifications', async () => {
        const hub = setup();
        try {
            const control = hub.service.get(jsonRpcManagedConnectionInterface);
            const bridge = hub.service.get(createJsonRpcBridgeInterface(calculator, { acknowledgeNotifications: ['log'] }));
            const { connectionId } = await control.open({});
            expect(hub.registration.activeConnectionCount).toBe(1);
            await expect(bridge.add({ a: 2, b: 3, jsonRpcConnectionId: connectionId })).resolves.toEqual({ sum: 5 });
            await expect(bridge.log({ text: 'test', jsonRpcConnectionId: connectionId })).resolves.toEqual({ sent: true });
            await expect(bridge.add({ a: 4, b: 7 })).resolves.toEqual({ sum: 11 });
            expect(hub.transports).toHaveLength(2);
            await expect(control.status({ connectionId })).resolves.toMatchObject({ state: 'open', reverseRequestPolicy: 'queue' });
            await control.close({ connectionId });
            expect(hub.registration.activeConnectionCount).toBe(0);
            await expect(bridge.add({ a: 1, b: 1, jsonRpcConnectionId: connectionId }))
                .rejects.toMatchObject({ code: -32001, name: 'RpcError' } satisfies Partial<RpcError>);
        } finally {
            await hub.registration.dispose();
            hub.client.close();
            hub.server.close();
        }
    });

    it('queues reverse requests and accepts responses', async () => {
        const hub = setup();
        try {
            const control = hub.service.get(jsonRpcManagedConnectionInterface);
            const { connectionId } = await control.open({});
            const reply = new Promise<JsonValue>((resolve) => hub.transports[0]!.b.onMessage(resolve));
            await hub.transports[0]!.b.send({ jsonrpc: '2.0', id: 30, method: 'server/callback', params: { value: 1 } });
            const batch = await control.readEvents({ connectionId, after: 0 });
            expect(batch.events).toMatchObject([{ type: 'request', method: 'server/callback' }]);
            const event = batch.events[0]!;
            if (event.type !== 'request') throw new Error('Expected reverse request');
            await control.respond({ kind: 'result', connectionId, requestToken: event.requestToken, result: true });
            await expect(reply).resolves.toMatchObject({ id: 30, result: true });
        } finally {
            await hub.registration.dispose();
            hub.client.close();
            hub.server.close();
        }
    });

    it('disposes managed and raw transports', async () => {
        const hub = setup();
        const control = hub.service.get(jsonRpcManagedConnectionInterface);
        const managed = connectManagedJsonRpc(control, {});
        await managed.opened;
        const raw = await connectRawJsonRpcTransport(hub.service.get(jsonRpcConnectionInterface));
        expect(hub.transports).toHaveLength(2);
        await hub.registration.dispose();
        await vi.waitFor(() => expect(hub.transports.every((t) => t.a.closed)).toBe(true));
        expect(hub.registration.activeConnectionCount).toBe(0);
        raw.close();
        await managed.closed;
        hub.client.close();
        hub.server.close();
    });

    it('expires idle managed connections without affecting the raw service', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        const transports: JsonRpcTransportPair[] = [];
        const registration = registerJsonRpcConnectionFactory({
            connection: server,
            serviceId: 'expiry',
            defaultIdleTimeoutMs: 15,
            profile: {
                openTransport: async () => {
                    const transport = new JsonRpcTransportPair();
                    transports.push(transport);
                    return transport.a;
                },
            },
        });
        try {
            const control = client.service('expiry').get(jsonRpcManagedConnectionInterface);
            await control.open({});
            expect(registration.activeConnectionCount).toBe(1);
            await vi.waitFor(() => expect(registration.activeConnectionCount).toBe(0));
            expect(transports[0]!.a.closed).toBe(true);
            const raw = await connectRawJsonRpcTransport(client.service('expiry').get(jsonRpcConnectionInterface));
            expect(raw.closed).toBe(false);
            raw.close();
        } finally {
            await registration.dispose();
            client.close();
            server.close();
        }
    });

    it('settles opening and closes the startup peer when initialization never answers', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        const transport = new JsonRpcTransportPair();
        let started = false;
        const registration = registerJsonRpcConnectionFactory({
            connection: server,
            serviceId: 'pending-init',
            profile: {
                openTransport: async () => transport.a,
                initialize: (peer, _params, signal) => {
                    started = true;
                    return peer.request('initialize', undefined, signal);
                },
            },
        });
        try {
            const opening = client.service('pending-init').get(jsonRpcManagedConnectionInterface).open({});
            const rejected = expect(opening).rejects.toThrow('disposed');
            await vi.waitFor(() => expect(started).toBe(true));
            await registration.dispose();
            await rejected;
            expect(transport.a.closed).toBe(true);
        } finally {
            await registration.dispose();
            client.close();
            server.close();
        }
    });

    it('aborts a pending transport opening and closes transports that arrive after disposal', async () => {
        const pair = new TransportPair();
        const server = LinkRpcConnection.fromTransport(pair.a);
        const client = LinkRpcConnection.fromTransport(pair.b);
        const controller = new AbortController();
        let resolveTransport!: (transport: JsonRpcTransport) => void;
        const pendingTransport = new Promise<JsonRpcTransport>((resolve) => { resolveTransport = resolve; });
        let startupSignal: AbortSignal | undefined;
        const registration = registerJsonRpcConnectionFactory({
            connection: server,
            serviceId: 'pending-transport',
            signal: controller.signal,
            profile: {
                openTransport: (_params, signal) => {
                    startupSignal = signal;
                    return pendingTransport;
                },
            },
        });
        try {
            const opening = client.service('pending-transport').get(jsonRpcManagedConnectionInterface).open({});
            const rejected = expect(opening).rejects.toThrow('disposed');
            await vi.waitFor(() => expect(startupSignal).toBeDefined());
            controller.abort();
            await registration.dispose();
            await rejected;
            expect(startupSignal?.aborted).toBe(true);
            const lateTransport = new JsonRpcTransportPair();
            resolveTransport(lateTransport.a);
            await vi.waitFor(() => expect(lateTransport.a.closed).toBe(true));
        } finally {
            await registration.dispose();
            client.close();
            server.close();
        }
    });
});
