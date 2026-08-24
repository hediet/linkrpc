/**
 * End-to-end: a **capability-gated aggregating manifest**.
 *
 * A single approver approves access requests that were parked across *many*
 * manifests, discovered by scanning the hub — the `manifest* → manifest`
 * combinator ({@link AggregatingHubAccessManifest}) sitting between the sources
 * and one {@link runManifestApprover}:
 *
 *   hubAccess ─(local host, loopback)──→ manifest_local ─┐  preserveOrigin
 *   hubAccess ─(srcA host, on hub)─────→ manifest_srcA  ─┤  discovered, origin stripped
 *   hubAccess ─(srcB host, on hub)─────→ manifest_srcB  ─┘  discovered, origin stripped
 *                                                         └─(aggregator)→ one approver
 *
 * What this proves:
 *  1. **Scan + aggregate.** The aggregator walks `linkrpc.directory`, finds every
 *     `hubAccessManifest` interface, and merges their desired entries.
 *  2. **Capability required.** The aggregator reaches a remote manifest via a
 *     forwarded (gated) call, so its connection must carry an admin-rooted cap
 *     for `*::hubAccessManifest::*` (+ the directory). Without it the scan is
 *     rejected by the gate.
 *  3. **Route-back.** One approver approves all entries; each `setCurrent`
 *     decision is routed home to the source that parked it, unblocking that
 *     consumer with an admin-minted capability.
 *  4. **Origin rule.** The trusted-local source's `origin` (its
 *     `sourceTransportId`) is preserved; discovered sources' origins are
 *     stripped — a remote can never address a local consent UI.
 */
import {
    createSeededMemoryPrincipal,
    createSeededSigningIdentity,
    LinkRpcConnection,
    type IMessageTransport,
    JsonRpcChannel,
    type Permission,
    type Principal,
    SigningSender,
    type SignedCapability,
    TransportPair,
} from '@hediet/linkrpc';
import { hubAccessManifestInterface } from '@hediet/linkrpc/hub/common';
import {
    AggregatingHubAccessManifest,
    type AggregatorSource,
    HubAccessManifestHost,
    registerAggregatingManifest,
    registerHubAccessManifest,
    runManifestApprover,
    watchHubDirectoryTree,
} from '@hediet/linkrpc-hub';
import {
    CapabilityProposalIssuer,
    createHubServiceInterfaces,
    fetchFullDirectory,
    Hub,
    hubRegisterServiceId,
    registerHubServices,
    RootOverlay,
    withForwardedCallGate,
    withVerifiedSignature,
} from '@hediet/linkrpc-hub/hub/server';
import { describe, expect, it, onTestFinished } from 'vitest';
import { HubSigningSender } from '@hediet/linkrpc/hub/client';

const MANIFEST_ID = hubAccessManifestInterface.info.id; // 'hubAccessManifest'

/** A permission the requesting consumer asks for (its exact scope is immaterial here). */
function permissionFor(serviceId: string): Permission {
    return {
        target: {
            serviceId: { exact: serviceId },
            interfaceId: { exact: 'greeter' },
            members: [{ exact: 'hello' }],
        },
        canInvoke: true,
    };
}

/** A broad cap letting the holder read/write any manifest + walk the directory. */
function aggregatorPermissions(): Permission[] {
    return [
        { target: { serviceId: { prefix: '' }, interfaceId: { exact: MANIFEST_ID }, members: [{ prefix: '' }] }, canInvoke: true },
        { target: { serviceId: { prefix: '' }, interfaceId: { exact: 'linkrpc.directory' }, members: [{ prefix: '' }] }, canInvoke: true },
    ];
}

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for: ${label}`);
}

describe('aggregating hubAccessManifest (scan the hub, merge, one approver, capability-gated)', () => {
    it('discovers manifests, merges them, approves via one approver, and routes decisions home', async () => {
        const admin = await createSeededSigningIdentity({ seed: 1 });
        const adminPrincipal = admin.publicSigningIdentity.principal;
        const issuer = new CapabilityProposalIssuer(admin);

        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        onTestFinished(() => services.dispose());

        // A gated participant leg. `host` (if given) parks this leg's hubAccess
        // requests; `origin` is the host-authored provenance stamped on them.
        const attachGatedLeg = (opts?: { host?: HubAccessManifestHost; origin?: Record<string, unknown>; }): IMessageTransport => {
            const hubPair = new TransportPair();
            const hubFacing = withForwardedCallGate(hubPair.b, {
                requireCapability: true,
                acceptedRootIssuers: () => [{ principal: adminPrincipal, isPublic: true }],
            });
            const upstream = hub.attach(hubFacing);
            const overlay = new RootOverlay({ uplink: hubPair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
            if (opts?.host) {
                opts.host.registerHubAccessAtRoot(overlay.root, opts.origin ? { origin: opts.origin } : undefined);
            }
            const appPair = new TransportPair();
            overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));
            return appPair.b;
        };

        // --- two REMOTE sources: a host served + reflected on the hub, fed by a
        // gated consumer that parks a real requestAccess into it ---
        const makeRemoteSource = async (serviceId: string, seed: number): Promise<{ host: HubAccessManifestHost; access: Promise<{ status: string; capabilities?: readonly SignedCapability[]; }>; }> => {
            const host = new HubAccessManifestHost({ acceptableRootIds: [adminPrincipal] });
            const svc = hubRegisterServiceId(hub, serviceId);
            registerHubAccessManifest(svc.connection, host, { serviceId });
            svc.connection.enableReflection({ serviceId });
            onTestFinished(() => svc.dispose());

            const consumer = HubSigningSender.create(
                attachGatedLeg({ host, origin: { sourceTransportId: `ts-${serviceId}` } }),
                await createSeededMemoryPrincipal({ seed }),
            );
            // Fire (parks + blocks until the aggregated approver decides).
            const access = consumer.requestAccess({
                consumer: { name: serviceId },
                permissions: [permissionFor(serviceId)],
                duration: 'persistent',
            });
            return { host, access };
        };

        const srcA = await makeRemoteSource('srcA', 10);
        const srcB = await makeRemoteSource('srcB', 11);

        // --- the LOCAL source: a host reached over an in-memory loopback (NOT on
        // the hub, so not discovered), passed to the aggregator as trusted-local ---
        const hostLocal = new HubAccessManifestHost({ acceptableRootIds: [adminPrincipal] });
        const localPair = new TransportPair();
        const localServer = LinkRpcConnection.fromTransport(localPair.a);
        const localClientConn = LinkRpcConnection.fromTransport(localPair.b);
        registerHubAccessManifest(localServer, hostLocal, { serviceId: 'local' });
        onTestFinished(() => { localServer.close(); localClientConn.close(); });
        const localClient = localClientConn.service('local').get(hubAccessManifestInterface);

        const localConsumer = HubSigningSender.create(
            attachGatedLeg({ host: hostLocal, origin: { sourceTransportId: 'ts-local' } }),
            await createSeededMemoryPrincipal({ seed: 12 }),
        );
        const localAccess = localConsumer.requestAccess({
            consumer: { name: 'local' },
            permissions: [permissionFor('localSvc')],
            duration: 'persistent',
        });

        // All three requests are parked before we scan.
        await waitUntil(() => srcA.host.getDesired().entries.length === 1, 'srcA parked');
        await waitUntil(() => srcB.host.getDesired().entries.length === 1, 'srcB parked');
        await waitUntil(() => hostLocal.getDesired().entries.length === 1, 'local parked');

        // --- the aggregator's connection: a gated participant holding the cap ---
        const aggPrincipal = await createSeededMemoryPrincipal({ seed: 99 });
        const aggCap = await issuer.mint({
            audience: aggPrincipal.id,
            permissions: aggregatorPermissions(),
            expiresAtMs: Date.now() + 3_600_000,
        });
        await aggPrincipal.capBag.add(aggCap);
        const aggConn = signedConnection(attachGatedLeg(), aggPrincipal);

        // Scan the hub for manifests; local (trusted) + discovered (stripped).
        const resolveSources = async (): Promise<AggregatorSource[]> => {
            const dir = await fetchFullDirectory(aggConn, 'hub');
            const remoteTags = [...new Set(dir.filter((e) => e.interfaceId === MANIFEST_ID).map((e) => e.serviceId))];
            return [
                { tag: 'local', manifest: localClient, preserveOrigin: true },
                ...remoteTags.map((tag) => ({
                    tag,
                    manifest: aggConn.service(tag).get(hubAccessManifestInterface),
                    preserveOrigin: false,
                })),
            ];
        };
        const aggregator = new AggregatingHubAccessManifest({ resolveSources });
        onTestFinished(() => aggregator.dispose());

        // Serve the aggregate as one ordinary manifest over a loopback.
        const aggMgrPair = new TransportPair();
        const aggMgrServer = LinkRpcConnection.fromTransport(aggMgrPair.a);
        const aggMgrClient = LinkRpcConnection.fromTransport(aggMgrPair.b);
        registerAggregatingManifest(aggMgrServer, aggregator, { serviceId: 'agg' });
        onTestFinished(() => { aggMgrServer.close(); aggMgrClient.close(); });
        const aggManifest = aggMgrClient.service('agg').get(hubAccessManifestInterface);

        // Before approving: the merged document shows all 3 entries, and the
        // origin rule holds (local preserved, discovered stripped).
        const merged = await aggManifest.getDesired({});
        const keys = Object.keys(merged.requested);
        expect(keys.filter((k) => k.startsWith('local\u0000'))).toHaveLength(1);
        expect(keys.filter((k) => k.startsWith('srcA\u0000'))).toHaveLength(1);
        expect(keys.filter((k) => k.startsWith('srcB\u0000'))).toHaveLength(1);
        for (const [k, entry] of Object.entries(merged.requested)) {
            const origin = (entry as { origin?: Record<string, unknown>; }).origin;
            if (k.startsWith('local\u0000')) {
                expect(origin?.['sourceTransportId']).toBe('ts-local'); // preserved
            } else {
                expect(origin).toBeUndefined();                        // stripped
            }
        }

        // --- one approver over the aggregate approves everything ---
        const approver = runManifestApprover({
            manifest: aggManifest,
            issuer,
            ownPrincipalId: adminPrincipal,
            prompt: async () => ({ grant: true }),
            log: () => { /* quiet */ },
        });
        onTestFinished(() => approver.dispose());

        // All three consumers unblock, each with a cap the ADMIN minted.
        const [rA, rB, rL] = await Promise.all([srcA.access, srcB.access, localAccess]);
        for (const r of [rA, rB, rL]) {
            expect(r.status).toBe('granted');
            expect(r.capabilities?.[0]?.issuer).toBe(adminPrincipal);
        }

        // Every source's parked entry has been resolved.
        expect(srcA.host.getDesired().entries).toHaveLength(0);
        expect(srcB.host.getDesired().entries).toHaveLength(0);
        expect(hostLocal.getDesired().entries).toHaveLength(0);
    });

    it('reactively discovers a manifest that appears AFTER the approver is running (directory watch)', async () => {
        const admin = await createSeededSigningIdentity({ seed: 3 });
        const adminPrincipal = admin.publicSigningIdentity.principal;
        const issuer = new CapabilityProposalIssuer(admin);

        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        onTestFinished(() => services.dispose());

        const attachGatedLeg = (host?: HubAccessManifestHost): IMessageTransport => {
            const hubPair = new TransportPair();
            const hubFacing = withForwardedCallGate(hubPair.b, {
                requireCapability: true,
                acceptedRootIssuers: () => [{ principal: adminPrincipal, isPublic: true }],
            });
            const upstream = hub.attach(hubFacing);
            const overlay = new RootOverlay({ uplink: hubPair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
            if (host) host.registerHubAccessAtRoot(overlay.root);
            const appPair = new TransportPair();
            overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));
            return appPair.b;
        };

        // The aggregator's gated, cap-holding connection.
        const aggPrincipal = await createSeededMemoryPrincipal({ seed: 99 });
        await aggPrincipal.capBag.add(await issuer.mint({
            audience: aggPrincipal.id,
            permissions: aggregatorPermissions(),
            expiresAtMs: Date.now() + 3_600_000,
        }));
        const aggConn = signedConnection(attachGatedLeg(), aggPrincipal);

        const resolveSources = async (): Promise<AggregatorSource[]> => {
            const dir = await fetchFullDirectory(aggConn, 'hub');
            const tags = [...new Set(dir.filter((e) => e.interfaceId === MANIFEST_ID).map((e) => e.serviceId))];
            return tags.map((tag) => ({ tag, manifest: aggConn.service(tag).get(hubAccessManifestInterface), preserveOrigin: false }));
        };
        const aggregator = new AggregatingHubAccessManifest({
            resolveSources,
            // The whole point of this test: watch the directory tree so a
            // manifest appearing later is noticed with no other activity.
            watchSources: (onChange) => watchHubDirectoryTree(aggConn, 'hub', onChange),
        });
        onTestFinished(() => aggregator.dispose());

        const aggMgrPair = new TransportPair();
        const aggMgrServer = LinkRpcConnection.fromTransport(aggMgrPair.a);
        const aggMgrClient = LinkRpcConnection.fromTransport(aggMgrPair.b);
        registerAggregatingManifest(aggMgrServer, aggregator, { serviceId: 'agg' });
        onTestFinished(() => { aggMgrServer.close(); aggMgrClient.close(); });

        // Start the approver — it subscribes to the aggregate's watch. Nothing
        // is served yet, so it has nothing to do.
        const approver = runManifestApprover({
            manifest: aggMgrClient.service('agg').get(hubAccessManifestInterface),
            issuer,
            ownPrincipalId: adminPrincipal,
            prompt: async () => ({ grant: true }),
            log: () => { /* quiet */ },
        });
        onTestFinished(() => approver.dispose());
        // Let the approver's watchDesired subscription (and the directory watch) settle.
        await new Promise((r) => setTimeout(r, 30));

        // NOW a new manifest appears on the hub, and a consumer parks into it.
        const host = new HubAccessManifestHost({ acceptableRootIds: [adminPrincipal] });
        const svc = hubRegisterServiceId(hub, 'srcLate');
        registerHubAccessManifest(svc.connection, host, { serviceId: 'srcLate' });
        svc.connection.enableReflection({ serviceId: 'srcLate' });
        onTestFinished(() => svc.dispose());

        const consumer = HubSigningSender.create(attachGatedLeg(host), await createSeededMemoryPrincipal({ seed: 20 }));
        const access = await consumer.requestAccess({
            consumer: { name: 'srcLate' },
            permissions: [permissionFor('srcLate')],
            duration: 'persistent',
        });

        // The directory watch drove re-discovery of srcLate → the one approver
        // approved it with the admin key. No pre-existing source ticked.
        expect(access.status).toBe('granted');
        expect(access.capabilities?.[0]?.issuer).toBe(adminPrincipal);
        expect(host.getDesired().entries).toHaveLength(0);
    });

    it('rejects the scan without a capability (the aggregator MUST hold one)', async () => {
        const admin = await createSeededSigningIdentity({ seed: 2 });
        const adminPrincipal = admin.publicSigningIdentity.principal;

        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        onTestFinished(() => services.dispose());

        // A source manifest served on the hub.
        const host = new HubAccessManifestHost({ acceptableRootIds: [adminPrincipal] });
        const svc = hubRegisterServiceId(hub, 'srcA');
        registerHubAccessManifest(svc.connection, host, { serviceId: 'srcA' });
        svc.connection.enableReflection({ serviceId: 'srcA' });
        onTestFinished(() => svc.dispose());

        // A gated participant with NO capability in its bag.
        const hubPair = new TransportPair();
        const hubFacing = withForwardedCallGate(hubPair.b, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: adminPrincipal, isPublic: true }],
        });
        const upstream = hub.attach(hubFacing);
        const overlay = new RootOverlay({ uplink: hubPair.a });
        registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
        const appPair = new TransportPair();
        overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));

        const capless = signedConnection(appPair.b, await createSeededMemoryPrincipal({ seed: 42 }));

        // The forwarded read of the remote manifest is rejected by the gate.
        await expect(
            capless.service('srcA').get(hubAccessManifestInterface).getDesired({}),
        ).rejects.toThrow();
    });
});

/** Build a typed connection whose calls are signed by `principal` (attaching its cap bag). */
function signedConnection(transport: IMessageTransport, principal: Principal): LinkRpcConnection {
    const signed = SigningSender.wrapChannel(JsonRpcChannel.create(transport), { principal });
    return new LinkRpcConnection(signed.sender);
}
