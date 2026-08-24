import {
    createSeededMemoryPrincipal,
    defineInterface,
    type IMessageTransport,
    KeypairSigningIdentity,
    requestType,
    type SigningIdentity,
    TransportPair,
} from '@vscode/hubrpc';
import { z } from 'zod';
import {
    Hub,
    hubRegisterServiceId,
    createHubServiceInterfaces,
    registerHubAccessService,
    registerHubServices,
    RootOverlay,
    withForwardedCallGate,
    withVerifiedSignature,
} from '@vscode/hubrpc-hub/hub/server';
import { createHubAccessConfig, HubAccessGrantSigner } from '@vscode/hubrpc-hub';
import { describe, expect, it } from 'vitest';
import { HubSigningSender } from '@vscode/hubrpc/hub/client';

const greeterInterface = defineInterface(
    { id: 'greeter', description: 'Greets by name.' },
    { hello: requestType(z.object({ name: z.string() }), z.object({ greeting: z.string() })) },
);

/**
 * Stand up a hub serving `hello::greeter::hello` + reflection, then return a
 * fresh **capability-mode gated** client transport — the same wiring the socket
 * acceptor / extension `attachParticipant` install: a forwarded-call gate that
 * requires an admin-rooted capability, plus the consent front door
 * (`hubAccess::*`) served at the connection root (never forwarded → never
 * gated). No prefix is exempt, so even `hub::*` is gated; only the root-served
 * `hubAccess` is reachable without a capability.
 */
function makeHub(issuer: SigningIdentity): { hub: Hub; attachClient: () => IMessageTransport; } {
    const hub = new Hub();
    createHubServiceInterfaces(hub);
    const svc = hubRegisterServiceId(hub, 'hello');
    svc.connection.register(greeterInterface, { hello: ({ name }) => ({ greeting: `Hello, ${name}!` }) }, { serviceId: 'hello' });
    svc.connection.enableReflection({ serviceId: 'hello' });

    // Allow-all in-process signer: mints an admin-rooted cap (audience =
    // consumer.nodeId) for exactly the permissions requested.
    const hubAccess = createHubAccessConfig(
        new HubAccessGrantSigner(issuer, () => ({ result: 'permitted' })).decide,
    );

    const attachClient = (): IMessageTransport => {
        const hubPair = new TransportPair();
        const hubFacing = withForwardedCallGate(hubPair.b, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: issuer.publicSigningIdentity.principal, isPublic: true }],
        });
        const upstream = hub.attach(hubFacing);
        const overlay = new RootOverlay({ uplink: hubPair.a });
        registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
        registerHubAccessService(overlay.root, hubAccess);
        const appPair = new TransportPair();
        overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));
        return appPair.b;
    };

    return { hub, attachClient };
}

describe('gated hub with root-served hubAccess', () => {
    it('reaches hubAccess at the root (ungated) to mint a cap that authorizes a forwarded call', async () => {
        const issuer = await KeypairSigningIdentity.generateNew();
        const { attachClient } = makeHub(issuer);
        const principal = await createSeededMemoryPrincipal({ seed: 1 });
        const sender = HubSigningSender.create(attachClient(), principal);

        // No exemption: a signed-but-uncapped forwarded call is rejected by the gate.
        await expect(
            sender.sendRequest('hello::greeter::hello', { name: 'World' }),
        ).rejects.toThrow();

        // `hubAccess::requestAccess` is served at the connection root (never
        // forwarded, never gated) — reachable without any capability. It mints a
        // cap bound to the consumer's nodeId for the greeter call.
        const access = await sender.requestAccess({
            consumer: { name: 'hubrpc-cli' },
            permissions: [
                {
                    target: {
                        serviceId: { exact: 'hello' },
                        interfaceId: { exact: 'greeter' },
                        members: [{ exact: 'hello' }],
                    },
                    canInvoke: true,
                },
            ],
            duration: 'persistent',
        });
        expect(access.status).toBe('granted');

        // The minted cap is now absorbed into the bag and rides every signed
        // call, so the previously-gated forwarded call now succeeds.
        expect(principal.capBag.capabilities).toHaveLength(1);
        const res = await sender.sendRequest('hello::greeter::hello', { name: 'World' });
        expect(res).toEqual({ greeting: 'Hello, World!' });
    });
});
