/**
 * End-to-end consent flow over the hub-served `hubAccessManifest`.
 *
 * Narrative (the real wiring, no shortcuts on the capability path):
 *
 *  1. A gated hub serves `p2::greeter::hello`. The forwarded-call gate on every
 *     participant leg requires a capability rooted at the hub admin.
 *  2. **P1** (a signing participant) calls `p2::greeter::hello` → rejected, no
 *     capability.
 *  3. P1 calls `hubAccess::requestAccess` — served at its overlay **root**
 *     (never forwarded, never gated). The hub is **keyless**: consent simply
 *     *parks* the request as a desired entry in the hub's `HubAccessManifestHost`
 *     and blocks.
 *  4. **P3** — the CLI approver module ({@link runManifestApprover}) holding the
 *     deterministic **admin** keypair — discovers the parked entry over the
 *     manifest, approves it, mints a cap with the admin key, and writes it back
 *     via `setCurrent`. The hub relays that cap as P1's `requestAccess` result.
 *  5. P1 retries `p2::greeter::hello` with the granted cap → succeeds.
 *
 * This composes the same `runManifestApprover` the `hubrpc-hub` unit tests drive
 * directly: here it runs against the *real* hub manifest, end to end.
 *
 * (P2's greeter is registered as a hub-side service for test simplicity — the
 * capability gate under test sits on P1's participant leg, which is faithful.)
 */
import {
    createSeededMemoryPrincipal,
    createSeededSigningIdentity,
    defineInterface,
    type HubRpcConnection,
    type IMessageTransport,
    requestType,
    TransportPair,
} from '@vscode/hubrpc';
import { z } from 'zod';
import { hubAccessManifestInterface } from '@vscode/hubrpc/hub/common';
import {
    HubAccessManifestHost,
    registerHubAccessManifest,
    runManifestApprover,
} from '@vscode/hubrpc-hub';
import {
    CapabilityProposalIssuer,
    Hub,
    hubRegisterServiceId,
    createHubServiceInterfaces,
    fetchFullDirectory,
    registerHubServices,
    RootOverlay,
    withForwardedCallGate,
    withVerifiedSignature,
} from '@vscode/hubrpc-hub/hub/server';
import { describe, expect, it, onTestFinished } from 'vitest';
import { HubSigningSender } from '@vscode/hubrpc/hub/client';

const greeterInterface = defineInterface(
    { id: 'greeter', description: 'Greets by name.' },
    { hello: requestType(z.object({ name: z.string() }), z.object({ greeting: z.string() })) },
);

/** Permission authorizing exactly `p2::greeter::hello`. */
const GREETER_PERMISSION = {
    target: {
        serviceId: { exact: 'p2' },
        interfaceId: { exact: 'greeter' },
        members: [{ exact: 'hello' }],
    },
    canInvoke: true,
};

describe('hubAccessManifest consent flow (P1 → P2, approved by P3 over the manifest)', () => {
    it('rejects an uncapped call, parks the request in the manifest, and unblocks once P3 approves', async () => {
        // --- the deterministic admin keypair (P3's identity, the hub's root) ---
        const admin = await createSeededSigningIdentity({ seed: 1 });
        const adminPrincipal = admin.publicSigningIdentity.principal;

        // --- the hub + its global services ---
        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        onTestFinished(() => services.dispose());

        // The hub-served manifest, advertising the admin as the only acceptable
        // minting root. `hubAccess` parks each request here (keyless: no issuer).
        const manifest = new HubAccessManifestHost({ acceptableRootIds: [adminPrincipal] });
        registerHubAccessManifest(services.connection, manifest, { serviceId: 'hub' });

        // --- P2: serves greeter under `p2` ---
        const p2 = hubRegisterServiceId(hub, 'p2');
        p2.connection.register(greeterInterface, { hello: ({ name }) => ({ greeting: `Hello, ${name}!` }) }, { serviceId: 'p2' });
        onTestFinished(() => p2.dispose());

        // --- a gated participant leg (P1's wiring) ---
        const attachParticipant = (): IMessageTransport => {
            const hubPair = new TransportPair();
            const hubFacing = withForwardedCallGate(hubPair.b, {
                requireCapability: true,
                acceptedRootIssuers: () => [{ principal: adminPrincipal, isPublic: true }],
            });
            const upstream = hub.attach(hubFacing);
            const overlay = new RootOverlay({ uplink: hubPair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
            manifest.registerHubAccessAtRoot(overlay.root);
            const appPair = new TransportPair();
            overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));
            return appPair.b;
        };

        // --- P3: the CLI approver module, holding the admin keypair, consuming
        // the hub manifest over the (ungated, in-process) services connection ---
        const approver = runManifestApprover({
            manifest: services.connection.service('hub').get(hubAccessManifestInterface),
            issuer: new CapabilityProposalIssuer(admin),
            prompt: async () => ({ grant: true }),  // P3 approves
            log: () => { /* quiet */ },
        });
        onTestFinished(() => approver.dispose());

        // --- P1: a signing participant ---
        const p1 = HubSigningSender.create(attachParticipant(), await createSeededMemoryPrincipal({ seed: 0 }));

        // 1. Uncapped forwarded call → rejected by the gate.
        await expect(p1.sendRequest('p2::greeter::hello', { name: 'World' })).rejects.toThrow();

        // 2. requestAccess parks in the manifest and blocks until P3 approves.
        const access = await p1.requestAccess({
            consumer: { name: 'P1' },
            permissions: [GREETER_PERMISSION],
            duration: 'persistent',
        });
        expect(access.status).toBe('granted');

        // The cap P1 received was minted by P3 with the admin key.
        expect(p1.listGrants()).toHaveLength(1);
        expect(p1.listGrants()[0]?.issuer).toBe(adminPrincipal);

        // 3. The same forwarded call now carries the cap → succeeds.
        const res = await p1.sendRequest('p2::greeter::hello', { name: 'World' });
        expect(res).toEqual({ greeting: 'Hello, World!' });
    });

    it('relays a denial from P3 back to P1', async () => {
        const admin = await createSeededSigningIdentity({ seed: 1 });
        const adminPrincipal = admin.publicSigningIdentity.principal;
        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        const servicesConn = services.connection as unknown as HubRpcConnection;
        onTestFinished(() => services.dispose());

        const manifest = new HubAccessManifestHost({ acceptableRootIds: [adminPrincipal] });
        registerHubAccessManifest(servicesConn, manifest, { serviceId: 'hub' });

        const attachParticipant = (): IMessageTransport => {
            const hubPair = new TransportPair();
            const hubFacing = withForwardedCallGate(hubPair.b, {
                requireCapability: true,
                acceptedRootIssuers: () => [{ principal: adminPrincipal, isPublic: true }],
            });
            const upstream = hub.attach(hubFacing);
            const overlay = new RootOverlay({ uplink: hubPair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
            manifest.registerHubAccessAtRoot(overlay.root);
            const appPair = new TransportPair();
            overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));
            return appPair.b;
        };

        const approver = runManifestApprover({
            manifest: servicesConn.service('hub').get(hubAccessManifestInterface),
            issuer: new CapabilityProposalIssuer(admin),
            prompt: async () => ({ grant: false, reason: 'P3 says no' }),
            log: () => { /* quiet */ },
        });
        onTestFinished(() => approver.dispose());

        const p1 = HubSigningSender.create(attachParticipant(), await createSeededMemoryPrincipal({ seed: 0 }));
        const access = await p1.requestAccess({
            consumer: { name: 'P1' },
            permissions: [GREETER_PERMISSION],
            duration: 'persistent',
        });
        expect(access.status).toBe('denied');
        expect(p1.listGrants()).toHaveLength(0);
    });

    it('resolves a discover request: P1 asks for an interface, P3 picks the service via the directory', async () => {
        const admin = await createSeededSigningIdentity({ seed: 1 });
        const adminPrincipal = admin.publicSigningIdentity.principal;
        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        const servicesConn = services.connection as unknown as HubRpcConnection;
        onTestFinished(() => services.dispose());

        const manifest = new HubAccessManifestHost({ acceptableRootIds: [adminPrincipal] });
        registerHubAccessManifest(servicesConn, manifest, { serviceId: 'hub' });

        // P2 serves greeter under `p2` AND reflects it, so the directory walk
        // the approver performs can discover it.
        const p2 = hubRegisterServiceId(hub, 'p2');
        p2.connection.register(greeterInterface, { hello: ({ name }) => ({ greeting: `Hi, ${name}!` }) }, { serviceId: 'p2' });
        p2.connection.enableReflection({ serviceId: 'p2' });
        onTestFinished(() => p2.dispose());

        const attachParticipant = (): IMessageTransport => {
            const hubPair = new TransportPair();
            const hubFacing = withForwardedCallGate(hubPair.b, {
                requireCapability: true,
                acceptedRootIssuers: () => [{ principal: adminPrincipal, isPublic: true }],
            });
            const upstream = hub.attach(hubFacing);
            const overlay = new RootOverlay({ uplink: hubPair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
            manifest.registerHubAccessAtRoot(overlay.root);
            const appPair = new TransportPair();
            overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));
            return appPair.b;
        };

        // P3 approves; it resolves discover candidates against the hub directory.
        const approver = runManifestApprover({
            manifest: servicesConn.service('hub').get(hubAccessManifestInterface),
            fetchDirectory: () => fetchFullDirectory(servicesConn, 'hub'),
            issuer: new CapabilityProposalIssuer(admin),
            prompt: async () => ({ grant: true }),
            log: () => { /* quiet */ },
        });
        onTestFinished(() => approver.dispose());

        const p1 = HubSigningSender.create(attachParticipant(), await createSeededMemoryPrincipal({ seed: 0 }));

        // P1 asks (discover) for SOME service implementing `greeter`.
        const res = await p1.sendRequest('hubAccess::request', {
            consumer: { name: 'P1', principal: p1.id },
            dependencies: { dep1: { interfaces: [{ id: 'greeter' }] } },
            duration: 'persistent',
        }) as { status: string; slots: Record<string, { serviceId: string; satisfiedInterfaces: string[] }>; capabilities: unknown[] };

        expect(res.status).toBe('granted');
        // P3 resolved the slot to p2 via the directory (not P1, not the hub).
        expect(res.slots.dep1?.serviceId).toBe('p2');
        expect(res.slots.dep1?.satisfiedInterfaces).toContain('greeter');
        expect(res.capabilities).toHaveLength(1);
    });
});
