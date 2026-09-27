import {
    createSeededMemoryPrincipal,
    defineInterface,
    LinkRpcConnection,
    type IMessageTransport,
    JsonRpcChannel,
    type Permission,
    type Principal,
    SigningSender,
    TransportPair,
    requestType,
    signedHash,
} from '@hediet/linkrpc';
import {
    HubAccessManifestHost,
    registerHubAccessManifest,
} from '@hediet/linkrpc-hub';
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
import { autorun } from '@vscode/observables';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { createApprovalClient, type ApprovalClient } from '@hediet/linkrpc-infra/approval';

const eventsInterface = defineInterface({ id: 'events' }, {
    list: requestType(z.object({}), z.object({ events: z.array(z.string()) })),
});

const requestedPermission: Permission = {
    target: {
        serviceId: { exact: 'calendar' },
        interfaceId: { exact: 'events' },
        members: [{ exact: 'list' }],
    },
    canInvoke: true,
};

describe('observable approval clients and delegated authority', () => {
    it('requests delegation from a root, grants a third identity a complete chain, and invokes through it', async () => {
        const root = await createSeededMemoryPrincipal({ seed: 810 });
        const delegate = await createSeededMemoryPrincipal({ seed: 811 });
        const consumerPrincipal = await createSeededMemoryPrincipal({ seed: 812 });
        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        onTestFinished(() => services.dispose());

        const attach = (accessHost?: HubAccessManifestHost): IMessageTransport => {
            const hubPair = new TransportPair();
            const upstream = hub.attach(withForwardedCallGate(hubPair.b, {
                requireCapability: true,
                acceptedRootIssuers: () => [{ principal: root.id, isPublic: true }],
            }));
            const overlay = new RootOverlay({ uplink: hubPair.a });
            registerHubServices(overlay.root, upstream, { hubServiceId: 'hub' });
            accessHost?.registerHubAccessAtRoot(overlay.root);
            const appPair = new TransportPair();
            overlay.connectParticipant(withVerifiedSignature(appPair.a, { verifySignatures: true }));
            onTestFinished(() => overlay.dispose());
            return appPair.b;
        };

        const accessHost = new HubAccessManifestHost({
            acceptableRootIds: [root.id],
            log: () => {},
        });
        const source = hubRegisterServiceId(hub, 'approval-source');
        registerHubAccessManifest(source.connection, accessHost, { serviceId: 'approval-source' });
        source.connection.enableReflection({ serviceId: 'approval-source' });
        onTestFinished(() => source.dispose());

        const calendar = hubRegisterServiceId(hub, 'calendar');
        calendar.connection.register(eventsInterface, {
            list: () => ({ events: ['approved through delegation'] }),
        }, { serviceId: 'calendar' });
        onTestFinished(() => calendar.dispose());

        const rootConnection = signedConnection(attach(), root);
        const rootApprover = await createApprovalClient({ connection: rootConnection, principal: root });
        onTestFinished(() => {
            rootApprover.dispose();
            rootConnection.close();
        });
        const rootCounts: number[] = [];
        const observation = autorun((reader) => {
            rootCounts.push(rootApprover.snapshot.read(reader).requests.length);
        });
        onTestFinished(() => observation.dispose());

        const delegateSender = HubSigningSender.create(attach(accessHost), delegate);
        const delegateConnection = new LinkRpcConnection(delegateSender);
        onTestFinished(() => delegateConnection.close());
        const delegationPromise = delegateSender.requestAccess({
            consumer: { name: 'Delegated approver' },
            permissions: [{
                target: {
                    serviceId: { prefix: '' },
                    interfaceId: { prefix: '' },
                    members: [{ prefix: '' }],
                },
                canDelegate: true,
                canInvoke: false,
            }],
            duration: 'persistent',
        });
        const delegationRequest = await waitForRequest(rootApprover, delegate.id);
        await rootApprover.approve(delegationRequest.id);
        const delegation = await delegationPromise;
        expect(delegation.status).toBe('granted');
        if (!('capabilities' in delegation)) throw new Error('Expected root to grant delegation');
        expect(delegation.capabilities).toHaveLength(1);
        const parent = delegation.capabilities[0];
        expect(parent).toMatchObject({ issuer: root.id, audience: delegate.id });
        expect(delegate.capBag.capabilities).toContainEqual(parent);
        expect(rootCounts).toContain(1);

        const delegatedApprover = await createApprovalClient({
            connection: delegateConnection,
            principal: delegate,
        });
        onTestFinished(() => delegatedApprover.dispose());

        const consumerSender = HubSigningSender.create(attach(accessHost), consumerPrincipal);
        const consumerConnection = new LinkRpcConnection(consumerSender);
        onTestFinished(() => consumerConnection.close());
        const accessPromise = consumerSender.requestAccess({
            consumer: { name: 'Calendar client' },
            permissions: [requestedPermission],
            duration: 'persistent',
        });
        const request = await waitForRequest(delegatedApprover, consumerPrincipal.id);
        const prepared = await delegatedApprover.prepareApproval(request.id);
        await delegatedApprover.approvePrepared(prepared);
        const result = await accessPromise;
        expect(result.status).toBe('granted');
        if (!('capabilities' in result)) throw new Error('Expected delegated approval to grant access');
        expect(result.capabilities).toHaveLength(2);
        expect(result.capabilities[0]).toMatchObject({
            issuer: delegate.id,
            audience: consumerPrincipal.id,
            parentHash: signedHash('capability', parent),
        });
        expect(result.capabilities[1]).toEqual(parent);
        for (const capability of result.capabilities) {
            expect(consumerPrincipal.capBag.capabilities).toContainEqual(capability);
        }

        // No manual cap attachment: the normal connection must send the whole chain.
        await expect(consumerConnection.service('calendar').get(eventsInterface).list({}))
            .resolves.toEqual({ events: ['approved through delegation'] });
        expect(accessHost.getDesired().entries).toEqual([]);

        const incompletePrincipal = await createSeededMemoryPrincipal({ seed: 812 });
        await incompletePrincipal.capBag.add(result.capabilities[0]);
        const incompleteConnection = signedConnection(attach(), incompletePrincipal);
        onTestFinished(() => incompleteConnection.close());
        await expect(incompleteConnection.service('calendar').get(eventsInterface).list({}))
            .rejects.toThrow();
    });
});

function signedConnection(transport: IMessageTransport, principal: Principal) {
    return new LinkRpcConnection(SigningSender.wrapChannel(JsonRpcChannel.create(transport), { principal }));
}

async function waitForRequest(client: ApprovalClient, consumerPrincipal: string) {
    await expect.poll(async () => {
        await client.refresh();
        return client.snapshot.get().requests.some((r) => r.request.consumer.principal === consumerPrincipal);
    }, { timeout: 5000 }).toBe(true);
    return client.snapshot.get().requests.find((r) => r.request.consumer.principal === consumerPrincipal)!;
}
