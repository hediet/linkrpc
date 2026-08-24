import { describe, expect, it } from 'vitest';
import {
    type Identity,
    identityInterface,
    InMemoryManagedIdentityStorage,
    type PrincipalId,
    PublicSigningIdentity,
    PublicWrappingIdentity,
    LinkRpcConnection,
    TransportPair,
} from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import type { Transport } from '@hediet/linkrpc/hub/common';
import { HubConnectionAcceptor } from './hubConnectionAcceptor';
import { anonymousHandler, boundTokenHandler } from './connectionHandler';
import { connectionTokenBinderInterface } from './connectionTokenBinder.interfaces';
import { createHubServiceInterfaces } from './hubServices';
import { Hub } from './routing/routingHub';
import { TokenIdentityStore } from './tokenIdentityStore';
import { FakeTransport, FakeTransportServer, flush } from './testUtil';

/** A transport carrying an `linkrpc::initialize` token, like NodeSocketTransport. */
type TokenTransport = Transport & { initializeToken: string | undefined };

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

function makeTokenPeer(token: string | undefined): { transport: TokenTransport; peer: LinkRpcConnection } {
    const pair = new TransportPair();
    const transport = Object.assign(new FakeTransport(pair.a), { initializeToken: token });
    return { transport, peer: LinkRpcConnection.fromTransport(pair.b) };
}

/** A minter-side acceptor: any connection gets the connectionTokenBinder front door. */
function minterAcceptor(hub: Hub, store: TokenIdentityStore, server: FakeTransportServer<TokenTransport>): void {
    new HubConnectionAcceptor<TokenTransport>({
        server,
        hub,
        handlers: [
            anonymousHandler({
                connectionTokenBinder: {
                    store,
                    identitySlotPrefixes: ['docker/'],
                    serviceIdPrefixes: ['docker/'],
                },
            }),
        ],
    });
}

/**
 * The redeem-side acceptor: a single `bound` handler redeems the presented token
 * (single-use) and provisions identity + namespace from its binding. Mirrors
 * `runHub`'s listener wiring for `{ token: "bound" }`.
 */
function fromTokenAcceptor(
    hub: Hub,
    store: TokenIdentityStore,
    server: FakeTransportServer<TokenTransport>,
    onError?: (e: Error) => void,
): void {
    new HubConnectionAcceptor<TokenTransport>({
        server,
        hub,
        ...(onError ? { onError } : {}),
        handlers: [
            boundTokenHandler(store, (slot) => ({
                resolveIdentity: () => Promise.resolve(fakeIdentity(`fake-id:${slot}`)),
                storage: new InMemoryManagedIdentityStorage(),
            })),
        ],
    });
}

describe('connectionTokenBinder + fromToken end-to-end', () => {
    it('mints a token and redeems it into a bound identity + namespace', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const store = new TokenIdentityStore();

        // Minter side: a trusted endpoint with the connectionTokenBinder front door.
        const minterServer = new FakeTransportServer<TokenTransport>();
        minterAcceptor(hub, store, minterServer);
        const minter = makeTokenPeer(undefined);
        minterServer.emit(minter.transport);
        await flush();

        const { token } = await minter.peer
            .get(connectionTokenBinderInterface)
            .bindConnectionToken({ identitySlot: 'docker/echo-provider', serviceIdNamespace: 'docker/echo-provider' });

        // Redeem side: a bound-token listener.
        const redeemServer = new FakeTransportServer<TokenTransport>();
        fromTokenAcceptor(hub, store, redeemServer);

        const redeemer = makeTokenPeer(token);
        redeemServer.emit(redeemer.transport);
        await flush();

        const grant = await redeemer.peer.get(hubGrantedServiceIdInterface).get({});
        expect(grant.grantedServiceIdNamespace).toBe('docker/echo-provider');

        const { principal } = await redeemer.peer.get(identityInterface).getPrincipal({});
        expect(principal).toBe('fake-id:docker/echo-provider');
    });

    it('rejects a second connection presenting the same (single-use) token', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const store = new TokenIdentityStore();

        const minterServer = new FakeTransportServer<TokenTransport>();
        minterAcceptor(hub, store, minterServer);
        const minter = makeTokenPeer(undefined);
        minterServer.emit(minter.transport);
        await flush();
        const { token } = await minter.peer
            .get(connectionTokenBinderInterface)
            .bindConnectionToken({ identitySlot: 'docker/echo-provider', serviceIdNamespace: 'docker/echo-provider' });

        const redeemServer = new FakeTransportServer<TokenTransport>();
        const errors: Error[] = [];
        fromTokenAcceptor(hub, store, redeemServer, (e) => errors.push(e));

        // First redemption succeeds.
        const first = makeTokenPeer(token);
        redeemServer.emit(first.transport);
        await first.peer.get(hubGrantedServiceIdInterface).get({});

        // Second connection with the same token is dropped at wiring time (the
        // token was consumed → no handler claims it), surfaced via onError.
        const second = makeTokenPeer(token);
        redeemServer.emit(second.transport);
        await flush();
        expect(errors.length).toBe(1);
        expect(errors[0].message).toMatch(/no connection handler accepted/);
    });

    it('rejects minting a slot outside the granted prefix', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);
        const store = new TokenIdentityStore();

        const minterServer = new FakeTransportServer<TokenTransport>();
        minterAcceptor(hub, store, minterServer);
        const minter = makeTokenPeer(undefined);
        minterServer.emit(minter.transport);
        await flush();

        await expect(
            minter.peer.get(connectionTokenBinderInterface).bindConnectionToken({ identitySlot: 'k8s/pod' }),
        ).rejects.toThrow(/identitySlotPrefix/);
    });
});
