import {
    createSeededMemoryPrincipal,
    directoryInterface,
    directoryWatchNever,
    LinkRpcConnection,
    type IMessageTransport,
    JsonRpcChannel,
    type Permission,
    type Principal,
    SigningSender,
    TransportPair,
} from '@hediet/linkrpc';
import {
    HubAccessManifestHost,
    registerHubAccessManifest,
} from '@hediet/linkrpc-hub';
import { hubAccessInterface, hubAccessManifestInterface } from '@hediet/linkrpc/hub/common';
import { HubSigningSender } from '@hediet/linkrpc/hub/client';
import {
    createHubServiceInterfaces,
    Hub,
    hubRegisterServiceId,
    registerHubServices,
    RootOverlay,
    withForwardedCallGate,
    withVerifiedSignature,
} from '@hediet/linkrpc-hub/hub/server';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
    bootstrapApprovalCommandCapability,
    createHubApprovalCommandClient,
} from './approval';

const requestedPermission: Permission = {
    target: {
        serviceId: { exact: 'calendar' },
        interfaceId: { exact: 'events' },
        members: [{ exact: 'list' }],
    },
    canInvoke: true,
};

describe('approval commands across a capability-gated Hub', () => {
    it('uses the trusted root self-cap to list, approve, and deny another consumer', async () => {
        const root = await createSeededMemoryPrincipal({ seed: 110 });
        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        onTestFinished(() => services.dispose());

        const attachGatedLeg = (accessHost?: HubAccessManifestHost): IMessageTransport => {
            const hubPair = new TransportPair();
            const hubFacing = withForwardedCallGate(hubPair.b, {
                requireCapability: true,
                acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
            });
            const upstream = hub.attach(hubFacing);
            const overlay = new RootOverlay({ uplink: hubPair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
            accessHost?.registerHubAccessAtRoot(overlay.root);
            const appPair = new TransportPair();
            overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));
            return appPair.b;
        };

        const requestHost = new HubAccessManifestHost({
            acceptableRootIds: [root.id],
            log: () => { /* quiet */ },
        });
        const source = hubRegisterServiceId(hub, 'approval-source');
        registerHubAccessManifest(source.connection, requestHost, { serviceId: 'approval-source' });
        source.connection.enableReflection({ serviceId: 'approval-source' });
        onTestFinished(() => source.dispose());

        const consumerPrincipal = await createSeededMemoryPrincipal({ seed: 111 });
        const consumer = HubSigningSender.create(attachGatedLeg(requestHost), consumerPrincipal);
        const inspectionHost = new HubAccessManifestHost({ log: () => { /* quiet */ } });

        await bootstrapApprovalCommandCapability(root);
        const rootConnection = signedConnection(attachGatedLeg(inspectionHost), root);
        const logs: string[] = [];
        const client = createHubApprovalCommandClient(rootConnection, root.identity, (line) => logs.push(line));
        onTestFinished(() => {
            client.dispose();
            rootConnection.close();
        });

        const approvedAccess = consumer.requestAccess({
            consumer: { name: 'Auth' },
            permissions: [requestedPermission],
            duration: 'persistent',
        });
        await waitUntil(() => requestHost.getDesired().entries.length === 1);

        const [approval] = await waitForRequests(client, 1);
        expect(approval.request.consumer.principal).toBe(consumerPrincipal.id);
        await client.approve(approval.id);

        const approved = await approvedAccess;
        expect(approved.status).toBe('granted');
        expect(approved.capabilities?.[0]).toMatchObject({
            issuer: root.id,
            audience: consumerPrincipal.id,
        });
        expect(logs.some((line) => line.includes('did not acknowledge decision'))).toBe(false);

        const deniedAccess = consumer.requestAccess({
            consumer: { name: 'Auth retry' },
            permissions: [requestedPermission],
            duration: 'persistent',
        });
        await waitUntil(() => requestHost.getDesired().entries.length === 1);

        const [denial] = await waitForRequests(client, 1);
        await client.deny(denial.id, 'operator denied');
        await expect(deniedAccess).resolves.toEqual({
            status: 'denied',
            reason: 'operator denied',
        });

        expect(inspectionHost.getDesired().entries).toEqual([]);
    });

    it('is rejected by the Hub when the self-cap issuer is not a trusted root', async () => {
        const trustedRoot = await createSeededMemoryPrincipal({ seed: 120 });
        const untrustedRoot = await createSeededMemoryPrincipal({ seed: 121 });
        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        onTestFinished(() => services.dispose());

        const host = new HubAccessManifestHost({
            acceptableRootIds: [trustedRoot.id],
            log: () => { /* quiet */ },
        });
        const source = hubRegisterServiceId(hub, 'approval-source');
        registerHubAccessManifest(source.connection, host, { serviceId: 'approval-source' });
        source.connection.enableReflection({ serviceId: 'approval-source' });
        onTestFinished(() => source.dispose());

        const hubPair = new TransportPair();
        const hubFacing = withForwardedCallGate(hubPair.b, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: trustedRoot.id, isPublic: true }],
        });
        const upstream = hub.attach(hubFacing);
        const overlay = new RootOverlay({ uplink: hubPair.a });
        registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
        const appPair = new TransportPair();
        overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));

        await bootstrapApprovalCommandCapability(untrustedRoot);
        const connection = signedConnection(appPair.b, untrustedRoot);
        onTestFinished(() => connection.close());

        await expect(
            connection.service('approval-source').get(hubAccessManifestInterface).getDesired({}),
        ).rejects.toThrow();
    });

    it('discovers a nested manifest through nonempty global and cloud Hub service IDs', async () => {
        const root = await createSeededMemoryPrincipal({ seed: 130 });
        const authHost = new HubAccessManifestHost({
            acceptableRootIds: [root.id],
            log: () => { /* quiet */ },
        });
        const consumerPair = new TransportPair();
        const consumerRoot = LinkRpcConnection.fromTransport(consumerPair.a);
        authHost.registerHubAccessAtRoot(consumerRoot);
        const authPrincipal = await createSeededMemoryPrincipal({ seed: 131 });
        const consumer = HubSigningSender.create(consumerPair.b, authPrincipal);
        const consumerConnection = new LinkRpcConnection(consumer);

        const publicPair = new TransportPair();
        const publicServer = LinkRpcConnection.fromTransport(withForwardedCallGate(publicPair.b, {
            requireCapability: true,
            acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
        }));
        registerReferralDirectory(publicServer, '', 'de.hediet');
        registerReferralDirectory(publicServer, 'de.hediet', 'de.hediet/cloud');
        registerReferralDirectory(
            publicServer,
            'de.hediet/cloud',
            'de.hediet/cloud/ext/auth',
        );
        publicServer.register(directoryInterface, {
            list: () => ({
                items: [{
                    serviceId: 'de.hediet/cloud/ext/auth',
                    interfaceId: hubAccessManifestInterface.info.id,
                    interfaceHash: hubAccessManifestInterface.schemaHash,
                }],
            }),
            watch: directoryWatchNever,
        }, { serviceId: 'de.hediet/cloud/ext/auth' });
        registerHubAccessManifest(publicServer, authHost, {
            serviceId: 'de.hediet/cloud/ext/auth',
        });

        await bootstrapApprovalCommandCapability(root);
        const rootConnection = signedConnection(publicPair.a, root);
        const logs: string[] = [];
        const client = createHubApprovalCommandClient(rootConnection, root.identity, (line) => logs.push(line));
        onTestFinished(() => {
            client.dispose();
            rootConnection.close();
            publicServer.close();
            consumerRoot.close();
            consumerConnection.close();
        });

        const access = consumerConnection.get(hubAccessInterface).request({
            consumer: {
                name: 'Auth',
                purpose: 'Authenticate requests',
                principal: authPrincipal.id,
            },
            dependencies: {
                calendar: {
                    interfaces: [{ id: 'events', required: true }],
                    members: [{ interfaceId: 'events', member: { exact: 'list' }, required: true }],
                },
            },
            duration: 'persistent',
        });
        await waitUntil(() => authHost.getDesired().entries.length === 1);

        const [request] = await waitForRequests(client, 1);
        expect(request.request).toMatchObject({
            kind: 'discover',
            consumer: {
                name: 'Auth',
                principal: authPrincipal.id,
            },
        });
        expect(logs).toContain(
            'approval: discovered 1 manifest source: de.hediet/cloud/ext/auth',
        );
        expect(logs).toContain(
            "approval: source 'de.hediet/cloud/ext/auth' has 1 pending request",
        );

        await client.deny(request.id, 'federation discovery test');
        await expect(access).resolves.toEqual({
            status: 'denied',
            reason: 'federation discovery test',
        });
    });
});

function registerReferralDirectory(
    connection: LinkRpcConnection,
    serviceId: string,
    childServiceId: string,
): void {
    connection.register(directoryInterface, {
        list: () => ({
            items: [{
                serviceId: childServiceId,
                interfaceId: directoryInterface.info.id,
                interfaceHash: directoryInterface.schemaHash,
            }],
        }),
        watch: directoryWatchNever,
    }, serviceId === '' ? undefined : { serviceId });
}

function signedConnection(
    transport: IMessageTransport,
    principal: Principal,
): LinkRpcConnection {
    const signed = SigningSender.wrapChannel(JsonRpcChannel.create(transport), { principal });
    return new LinkRpcConnection(signed.sender);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('condition not met before timeout');
}

async function waitForRequests(
    client: ReturnType<typeof createHubApprovalCommandClient>,
    count: number,
): ReturnType<typeof client.requests> {
    for (let attempt = 0; attempt < 200; attempt++) {
        const requests = await client.requests();
        if (requests.length === count) return requests;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('approval requests not observed before timeout');
}
