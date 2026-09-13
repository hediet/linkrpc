import { describe, expect, it } from 'vitest';
import {
    defineInterface,
    identityInterface,
    identityStorageInterface,
    type Identity,
    type PrincipalId,
    PublicSigningIdentity,
    PublicWrappingIdentity,
    requestType,
    LinkRpcConnection,
    TransportPair,
} from '@hediet/linkrpc';
import { z } from 'zod';
import {
    hubGrantedServiceIdInterface,
} from '@hediet/linkrpc/hub/common';
import type { TopologyTransportInfo } from '@hediet/linkrpc/inspection';
import { HubConnectionAcceptor } from './hubConnectionAcceptor';
import { type ConnectionHandlerFactory, provisionRoot } from './connectionHandler';
import { createHubServiceInterfaces } from './hubServices';
import { PrincipalIdPrefixPolicy } from './prefixPolicy';
import type { ConnectionProvenance } from './provenance';
import { Hub } from './routing/routingHub';
import type { Transport } from '@hediet/linkrpc/hub/common';
import { createSqliteIdentityKeystore } from './sqliteIdentityKeystore';
import { FakeTransport, FakeTransportServer, flush } from './testUtil';

const mathInterface = defineInterface(
    { id: 'math', description: 'Arithmetic.' },
    { add: requestType(z.object({ a: z.number(), b: z.number() }), z.object({ sum: z.number() })) },
);

type AttestedTransport = Transport & { provenance: ConnectionProvenance | undefined; };

/** A fake identity whose nodeId is derived from the identity key. */
function fakeIdentity(principal: PrincipalId): Identity {
    return {
        principal,
        wrapPublicKey: new Uint8Array(),
        publicSigningIdentity: new PublicSigningIdentity(principal),
        publicWrappingIdentity: new PublicWrappingIdentity(new Uint8Array()),
        sign: async () => new Uint8Array(),
        wrap: async () => new Uint8Array(),
        unwrap: async () => new Uint8Array(),
    };
}

/** Build an attested provider transport and its peer client connection. */
function makeAttested(
    identityKey: string,
    topologyInfo?: TopologyTransportInfo,
): { transport: AttestedTransport; peer: LinkRpcConnection; } {
    const pair = new TransportPair();
    const transport = Object.assign(new FakeTransport(pair.a), {
        provenance: { identityKey, attributes: {} } as ConnectionProvenance,
        ...(topologyInfo !== undefined ? { topologyInfo } : {}),
    });
    return { transport, peer: LinkRpcConnection.fromTransport(pair.b) };
}

/**
 * A handler that claims every connection and provisions a managed identity
 * derived from the accepted transport's attested provenance.
 */
const attestedIdentityHandler: ConnectionHandlerFactory = {
    handle: () => (ctx) =>
        provisionRoot(ctx, {
            resolveIdentity: async () =>
                fakeIdentity(`node:${(ctx.transport as AttestedTransport).provenance?.identityKey ?? 'anon'}`),
        }),
};

function makeAcceptor(hub: Hub, server: FakeTransportServer<AttestedTransport>) {
    return new HubConnectionAcceptor<AttestedTransport>({
        server,
        hub,
        policy: new PrincipalIdPrefixPolicy<AttestedTransport>(),
        handlers: [attestedIdentityHandler],
    });
}

function attachConsumer(hub: Hub): LinkRpcConnection {
    const pair = new TransportPair();
    hub.attach(pair.a);
    return LinkRpcConnection.fromTransport(pair.b);
}

/** Attach an ungated provider for `serviceId` directly on the hub. */
function attachProvider(hub: Hub, serviceId: string): LinkRpcConnection {
    const pair = new TransportPair();
    hub.attach(pair.a);
    hub.claimPrefix(pair.a, serviceId);
    const conn = LinkRpcConnection.fromTransport(pair.b);
    conn.register(mathInterface, { add: ({ a, b }) => ({ sum: a + b }) }, { serviceId });
    return conn;
}

describe('HubConnectionAcceptor (end-to-end)', () => {
    it('attests a provider, authorizes its claim, and routes a call to it', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const server = new FakeTransportServer<AttestedTransport>();
        makeAcceptor(hub, server);

        const { transport, peer } = makeAttested('docker/echo');
        peer.register(mathInterface, { add: ({ a, b }) => ({ sum: a + b }) }, { serviceId: 'docker/echo' });
        peer.enableReflection({ serviceId: 'docker/echo' });
        server.emit(transport);

        await peer.get(hubGrantedServiceIdInterface).register({ serviceId: 'docker/echo' });

        const consumer = attachConsumer(hub);
        const result = await consumer.service('docker/echo').get(mathInterface).add({ a: 4, b: 5 });
        expect(result).toEqual({ sum: 9 });
    });

    it('serves identity::* on the participant overlay', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const server = new FakeTransportServer<AttestedTransport>();
        makeAcceptor(hub, server);

        const { transport, peer } = makeAttested('docker/echo');
        server.emit(transport);
        await flush();

        const { principal: nodeId } = await peer.get(identityInterface).getPrincipal({});
        expect(nodeId).toBe('node:docker/echo');
    });

    it('places accepted transport information on the physical participant link', async () => {
        const hub = new Hub({ nodeId: 'hub-a' });
        const server = new FakeTransportServer<AttestedTransport>();
        makeAcceptor(hub, server);
        const { transport } = makeAttested('docker/echo', {
            type: 'websocket',
            remote: { address: '203.0.113.8' },
            metadata: { forwardedFor: '198.51.100.4' },
        });

        server.emit(transport);
        await flush();

        expect(hub.getTopologyGraph('observer').links.filter((link) => link.transport))
            .toEqual([expect.objectContaining({
                transport: {
                    type: 'websocket',
                    remote: { address: '203.0.113.8' },
                    metadata: { forwardedFor: '198.51.100.4' },
                },
            })]);
    });

    it('serves identity.storage::* from a SQLite-backed slot', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const server = new FakeTransportServer<AttestedTransport>();

        // Provision each connection with a SQLite keystore slot's identity +
        // storage, exactly as runHub's IdentityProvisioner does.
        const keystore = createSqliteIdentityKeystore({ dbPath: ':memory:' });
        const storageHandler: ConnectionHandlerFactory = {
            handle: () => (ctx) => {
                const slot = keystore.slotById(
                    (ctx.transport as AttestedTransport).provenance?.identityKey ?? 'anon',
                );
                provisionRoot(ctx, {
                    resolveIdentity: () => slot.getOrCreateIdentity(),
                    storage: slot.storage,
                });
            },
        };
        new HubConnectionAcceptor<AttestedTransport>({
            server,
            hub,
            policy: new PrincipalIdPrefixPolicy<AttestedTransport>(),
            handlers: [storageHandler],
        });

        // First connection writes a value.
        const first = makeAttested('docker/echo');
        server.emit(first.transport);
        await flush();
        await first.peer.get(identityStorageInterface).set({ key: 'greeting', value: { text: 'hi' } });
        expect(await first.peer.get(identityStorageInterface).get({ key: 'greeting' })).toEqual({
            value: { text: 'hi' },
        });
        expect(await first.peer.get(identityStorageInterface).list({})).toEqual({ keys: ['greeting'] });

        // A later connection to the SAME slot sees the persisted value.
        const second = makeAttested('docker/echo');
        server.emit(second.transport);
        await flush();
        expect(await second.peer.get(identityStorageInterface).get({ key: 'greeting' })).toEqual({
            value: { text: 'hi' },
        });

        // A different slot is isolated.
        const other = makeAttested('docker/other');
        server.emit(other.transport);
        await flush();
        expect(await other.peer.get(identityStorageInterface).get({ key: 'greeting' })).toEqual({});
    });

    it('denies a claim that the policy rejects', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const server = new FakeTransportServer<AttestedTransport>();
        makeAcceptor(hub, server);

        const { transport, peer } = makeAttested('docker/echo');
        server.emit(transport);

        await expect(
            peer.get(hubGrantedServiceIdInterface).register({ serviceId: 'not-echo' }),
        ).rejects.toThrow();
    });

    it('releases the prefix when the transport closes', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const server = new FakeTransportServer<AttestedTransport>();
        makeAcceptor(hub, server);

        const first = makeAttested('docker/echo');
        server.emit(first.transport);
        await first.peer.get(hubGrantedServiceIdInterface).register({ serviceId: 'docker/echo' });

        // Close → overlay disposed → prefix released on the hub.
        first.transport.dispose();
        await flush();

        const second = makeAttested('docker/echo');
        server.emit(second.transport);
        await second.peer.get(hubGrantedServiceIdInterface).register({ serviceId: 'docker/echo' });
    });

    it('dispose tears down all overlays and the server', () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const server = new FakeTransportServer<AttestedTransport>();
        const acceptor = makeAcceptor(hub, server);
        server.emit(makeAttested('docker/echo').transport);
        acceptor.dispose();
        expect(server.disposed).toBe(true);
    });
});

describe('HubConnectionAcceptor (forwarded-call gating)', () => {
    it('capability mode rejects an accepted participant\'s forwarded call carrying no capability', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        attachProvider(hub, 'svc');
        const server = new FakeTransportServer<AttestedTransport>();
        new HubConnectionAcceptor<AttestedTransport>({
            server,
            hub,
            policy: new PrincipalIdPrefixPolicy<AttestedTransport>(),
            handlers: [attestedIdentityHandler],
            verifyForwardedCalls: true,
            requireForwardedCapability: true,
            adminIds: ['node:admin' as PrincipalId],
        });

        const { transport, peer } = makeAttested('worker');
        server.emit(transport);
        await flush();

        // The forwarded (cross-service) call is unsigned and uncapped, so the
        // gate the acceptor installed rejects it before it reaches `svc`.
        await expect(
            peer.service('svc').get(mathInterface).add({ a: 1, b: 2 }),
        ).rejects.toThrow();
    });

    it('without gating, the same accepted participant can make the forwarded call', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        attachProvider(hub, 'svc');
        const server = new FakeTransportServer<AttestedTransport>();
        makeAcceptor(hub, server);

        const { transport, peer } = makeAttested('worker');
        server.emit(transport);
        await flush();

        const result = await peer.service('svc').get(mathInterface).add({ a: 1, b: 2 });
        expect(result).toEqual({ sum: 3 });
    });
});
