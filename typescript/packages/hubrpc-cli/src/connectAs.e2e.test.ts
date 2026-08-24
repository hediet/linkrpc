import { describe, expect, it } from 'vitest';
import {
    defineInterface,
    type Identity,
    identityInterface,
    type PrincipalId,
    PublicSigningIdentity,
    PublicWrappingIdentity,
    requestType,
    HubRpcConnection,
    TransportPair,
} from '@vscode/hubrpc';
import { hubGrantedServiceIdInterface } from '@vscode/hubrpc/hub/common';
import { z } from 'zod';
import {
    boundTokenHandler,
    connectionTokenBinderInterface,
    createHubServiceInterfaces,
    Hub,
    HubConnectionAcceptor,
    registerConnectionTokenBinderService,
    TokenIdentityStore,
    type HubServices,
} from '@vscode/hubrpc-hub/hub/server';
import { InMemoryManagedIdentityStorage } from '@vscode/hubrpc';
import { SocketServer, type NodeSocketTransport } from '@vscode/hubrpc-hub/hub/server/node';
import { connectAs } from './commands/connectAs';
import { openDialTransport, type DialEndpoint } from './commands/connectAsTransports';

const echoInterface = defineInterface(
    { id: 'echo', description: 'Echoes a message.' },
    { echo: requestType(z.object({ message: z.string() }), z.object({ reply: z.string() })) },
);

/** A fake managed identity whose principal encodes the slot it was provisioned for. */
function fakeIdentity(slot: string): Identity {
    const principal = `fake:${slot}` as PrincipalId;
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

/**
 * Stand up a real hub with:
 * - `hub::connectionTokenBinder` (routable mint front door, scoped to `svc/`),
 * - a real socket `{ token: "bound" }` listener (the redeem side), backed by a
 *   fake per-slot identity resolver.
 * Returns the bound-listener socket spec plus an in-process broker connection
 * (to mint) and consumer attach helper (to call a target's service).
 */
async function makeHub(): Promise<{
    services: HubServices;
    store: TokenIdentityStore;
    boundEndpoint: DialEndpoint;
    brokerConn: HubRpcConnection;
    attachConsumer(): HubRpcConnection;
    dispose(): Promise<void>;
}> {
    const hub = new Hub();
    const services = createHubServiceInterfaces(hub, { hubServiceId: 'hub' });
    const store = new TokenIdentityStore();

    // Mint door: routable `hub::connectionTokenBinder`, scoped to `svc/`.
    registerConnectionTokenBinderService(services.connection as unknown as HubRpcConnection, {
        store,
        identitySlotPrefixes: ['svc/'],
        serviceIdPrefixes: ['svc/'],
        serviceId: 'hub',
    });

    // Redeem door: a real socket listener admitting bound tokens.
    const boundServer = await SocketServer.start({
        isTokenAccepted: (token) => Promise.resolve(store.peek(token)),
    });
    const acceptor = new HubConnectionAcceptor<NodeSocketTransport>({
        server: boundServer,
        hub,
        handlers: [
            boundTokenHandler(store, (slot) => ({
                resolveIdentity: () => Promise.resolve(fakeIdentity(slot)),
                storage: new InMemoryManagedIdentityStorage(),
            })),
        ],
    });

    // Broker connection (in-process): mints via the routable binder.
    const brokerPair = new TransportPair();
    hub.attach(brokerPair.a);
    const brokerConn = HubRpcConnection.fromTransport(brokerPair.b);

    return {
        services,
        store,
        boundEndpoint: { kind: 'socket', path: boundServer.endpoint },
        brokerConn,
        attachConsumer: () => {
            const pair = new TransportPair();
            hub.attach(pair.a);
            return HubRpcConnection.fromTransport(pair.b);
        },
        dispose: async () => {
            brokerConn.close();
            acceptor.dispose();
            boundServer.dispose();
            services.dispose();
        },
    };
}

describe('connect-as e2e (mint → bound redeem → splice → provisioned participant)', () => {
    it('splices an in-memory target onto the hub as its minted slot identity + namespace', async () => {
        const h = await makeHub();

        // The "target": a plain hub participant on one side of a pair; the other
        // side is what `connect-as` splices onto the hub's bound listener.
        const targetPair = new TransportPair();
        const targetConn = HubRpcConnection.fromTransport(targetPair.b);

        let stopConnectAs: (() => void) | undefined;
        const stop = new Promise<void>((r) => { stopConnectAs = r; });

        const binder = h.brokerConn.service('hub').get(connectionTokenBinderInterface);

        const run = connectAs({
            mintToken: async () => {
                const { token } = await binder.bindConnectionToken({
                    identitySlot: 'svc/echo',
                    serviceIdNamespace: 'svc/echo',
                });
                return token;
            },
            openHubTransport: (token) => openDialTransport(h.boundEndpoint, token),
            openTargetTransport: async () => ({
                transport: targetPair.a,
                onClose: () => { /* driven by the test */ },
                dispose: () => targetPair.a.dispose(),
            }),
            stop,
        });

        // The spliced target now behaves as a bound participant: it sees its
        // granted namespace, claims it, and serves + reports its identity.
        const grant = await targetConn.get(hubGrantedServiceIdInterface).get({});
        expect(grant.grantedServiceIdNamespace).toBe('svc/echo');

        const { principal } = await targetConn.get(identityInterface).getPrincipal({});
        expect(principal).toBe('fake:svc/echo');

        await targetConn.get(hubGrantedServiceIdInterface).register({ serviceId: 'svc/echo' });
        targetConn.register(
            echoInterface,
            { echo: ({ message }) => ({ reply: `echo:${message}` }) },
            { serviceId: 'svc/echo' },
        );

        // A consumer on the hub reaches the target's service through the splice.
        const consumer = h.attachConsumer();
        const res = await consumer.service('svc/echo').get(echoInterface).echo({ message: 'ping' });
        expect(res).toEqual({ reply: 'echo:ping' });

        consumer.close();
        targetConn.close();
        stopConnectAs?.();
        await run;
        await h.dispose();
    });

    it('rejects minting a slot outside the binder prefix', async () => {
        const h = await makeHub();
        const binder = h.brokerConn.service('hub').get(connectionTokenBinderInterface);
        await expect(
            binder.bindConnectionToken({ identitySlot: 'other/nope' }),
        ).rejects.toThrow(/identitySlotPrefix/);
        await h.dispose();
    });
});
