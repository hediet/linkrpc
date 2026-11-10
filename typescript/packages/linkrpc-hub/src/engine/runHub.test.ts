import { LinkRpcConnection, defineInterface, requestType } from '@hediet/linkrpc';
import { mergeTopologyGraphs } from '@hediet/linkrpc-infra/inspection';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { HubConfigSchema } from '../config';
import { fetchFullDirectory } from '@hediet/linkrpc-infra/approval';
import { SocketServer } from '../hub/server/node';
import { runHub, type RunningHub } from './runHub';

const echoInterface = defineInterface(
    { id: 'federation.echo', description: 'Federation test echo.' },
    {
        echo: requestType(
            z.object({ value: z.string() }),
            z.object({ value: z.string() }),
        ),
    },
);

const PRIMARY_SERVICE_ID = 'test.federation';
const SECONDARY_SERVICE_ID = `${PRIMARY_SERVICE_ID}/secondary`;
const PRIMARY_ECHO_SERVICE_ID = `${PRIMARY_SERVICE_ID}/primary/echo`;
const SECONDARY_ECHO_SERVICE_ID = `${SECONDARY_SERVICE_ID}/echo`;
const OUTSIDE_GRANTED_NAMESPACE = `${PRIMARY_SERVICE_ID}/outside`;
const UPLINK_TOKEN = 'secondary-uplink';

function primaryConfig(socketPath: string) {
    return HubConfigSchema.parse({
        hubServiceId: PRIMARY_SERVICE_ID,
        forwardChecking: false,
        listeners: [{
            type: 'socket',
            path: socketPath,
            handlers: [{
                token: 'static',
                value: UPLINK_TOKEN,
                grantedServiceId: SECONDARY_SERVICE_ID,
            }],
        }],
    });
}

function secondaryConfig(socketPath: string, claimServiceIds = [SECONDARY_SERVICE_ID]) {
    return HubConfigSchema.parse({
        hubServiceId: SECONDARY_SERVICE_ID,
        forwardChecking: false,
        endpoints: [{
            kind: 'socket',
            path: socketPath,
            token: UPLINK_TOKEN,
            routeServiceIds: [PRIMARY_SERVICE_ID],
            claimServiceIds,
        }],
    });
}

function discoverableSecondaryConfig(socketPath: string) {
    return HubConfigSchema.parse({
        ...secondaryConfig(socketPath),
        forwardChecking: true,
        consentApprover: false,
    });
}

function attachPeer(hub: RunningHub) {
    const link = hub.hub.attachOut();
    const connection = LinkRpcConnection.fromTransport(link.transport);
    return {
        connection,
        dispose: () => {
            connection.close();
            link.dispose();
        },
    };
}

function attachEcho(hub: RunningHub, serviceId: string, location: string) {
    const link = hub.hub.attachOut();
    const connection = LinkRpcConnection.fromTransport(link.transport);
    link.addPrefixRoute(serviceId);
    connection.register(echoInterface, {
        echo: ({ value }) => ({ value: `${location}:${value}` }),
    }, { serviceId });
    connection.enableReflection({ serviceId });
    return {
        dispose: () => {
            connection.close();
            link.dispose();
        },
    };
}

async function waitForClaim(hub: RunningHub, serviceId: string): Promise<void> {
    await waitFor(
        () => hub.hub.getTopologyGraph('test').routes.some((s) => s.serviceId === serviceId),
        `claim '${serviceId}'`,
    );
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${description}`);
}

describe('runHub far-end federation', () => {
    it('joins configured hubs through the explicit root overlay', async () => {
        const socketPath = SocketServer.allocSocketPath();
        const primary = await runHub({ config: primaryConfig(socketPath), log: () => { } });
        const secondary = await runHub({ config: secondaryConfig(socketPath), log: () => { } });
        try {
            await waitForClaim(primary, SECONDARY_SERVICE_ID);
            await waitFor(() => {
                const primaryGraph = primary.hub.getTopologyGraph('test');
                const secondaryGraph = secondary.hub.getTopologyGraph('test');
                return primaryGraph.links.some((link) => link.peerState === 'identified')
                    && secondaryGraph.links.some((link) => link.peerState === 'identified');
            }, 'reciprocal peer identification');

            const primaryGraph = primary.hub.getTopologyGraph('test');
            const secondaryGraph = secondary.hub.getTopologyGraph('test');
            const overlay = primaryGraph.nodes.find((node) => node.label === 'Root overlay');
            const primaryPeerLink = primaryGraph.links.find(
                (link) => link.from.nodeId === overlay?.nodeId
                    && link.peerState === 'identified',
            );
            const secondaryLink = secondaryGraph.links.find(
                (link) => link.peerState === 'identified',
            );

            expect(overlay).toBeDefined();
            expect(primaryPeerLink).toBeDefined();
            expect(secondaryLink).toBeDefined();
            expect(secondaryLink?.to).toEqual(primaryPeerLink?.from);
            expect(primaryPeerLink?.to).toEqual(secondaryLink?.from);

            const merged = mergeTopologyGraphs([
                { source: PRIMARY_SERVICE_ID, graph: primaryGraph },
                { source: SECONDARY_SERVICE_ID, graph: secondaryGraph },
            ]);
            const overlayChildLinks = merged.links.filter((link) =>
                [link.from.nodeId, link.to.nodeId].includes(overlay!.nodeId)
                && [link.from.nodeId, link.to.nodeId].includes(secondary.hub.nodeId));
            const directHubLinks = merged.links.filter((link) =>
                [link.from.nodeId, link.to.nodeId].includes(primary.hub.nodeId)
                && [link.from.nodeId, link.to.nodeId].includes(secondary.hub.nodeId));
            expect(overlayChildLinks).toHaveLength(1);
            expect(overlayChildLinks[0]?.sources.sort()).toEqual([
                PRIMARY_SERVICE_ID,
                SECONDARY_SERVICE_ID,
            ]);
            expect(directHubLinks).toHaveLength(0);
        } finally {
            secondary.dispose();
            primary.dispose();
        }
    });

    it('keeps a denied namespace claim degraded, logs it, and cancels retries on dispose', async () => {
        const socketPath = SocketServer.allocSocketPath();
        const logs: string[] = [];
        const primary = await runHub({ config: primaryConfig(socketPath), log: () => { } });
        const secondary = await runHub({
            config: secondaryConfig(socketPath, [OUTSIDE_GRANTED_NAMESPACE]),
            log: (line) => logs.push(line),
        });
        try {
            await waitFor(
                () => logs.some((line) => line.includes('outside this connection\'s granted namespace')),
                'strict namespace denial log',
            );
            expect(
                primary.hub.getTopologyGraph('test').routes.some(
                    (route) => route.serviceId === OUTSIDE_GRANTED_NAMESPACE,
                ),
            ).toBe(false);

            const failures = logs.filter((line) => line.includes('connection failed')).length;
            secondary.dispose();
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(logs.filter((line) => line.includes('connection failed'))).toHaveLength(failures);
        } finally {
            secondary.dispose();
            primary.dispose();
        }
    });

    it('stays locally alive while a rolling predecessor holds the claim, then connects after replacement', async () => {
        const socketPath = SocketServer.allocSocketPath();
        const logs: string[] = [];
        let primary = await runHub({ config: primaryConfig(socketPath), log: () => { } });
        const conflict = primary.hub.attachOut();
        conflict.addPrefixRoute(SECONDARY_SERVICE_ID);

        const secondary = await runHub({
            config: secondaryConfig(socketPath),
            log: (line) => logs.push(line),
        });
        const secondaryEcho = attachEcho(secondary, SECONDARY_ECHO_SERVICE_ID, 'secondary');
        const secondaryCaller = attachPeer(secondary);
        let primaryEcho: ReturnType<typeof attachEcho> | undefined;
        let primaryCaller: ReturnType<typeof attachPeer> | undefined;

        try {
            await expect(
                secondaryCaller.connection.service(SECONDARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'local' }),
            ).resolves.toEqual({ value: 'secondary:local' });
            await waitFor(
                () => logs.some((line) =>
                    line.includes(`prefix '${SECONDARY_SERVICE_ID}' is already claimed`)
                ),
                'conflicting claim denial log',
            );
            expect(logs.some((line) => line.endsWith(' connected'))).toBe(false);

            conflict.dispose();
            primary.dispose();
            primary = await runHub({ config: primaryConfig(socketPath), log: () => { } });
            primaryEcho = attachEcho(primary, PRIMARY_ECHO_SERVICE_ID, 'primary');
            primaryCaller = attachPeer(primary);
            await waitForClaim(primary, SECONDARY_SERVICE_ID);

            await expect(
                primaryCaller.connection.service(SECONDARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'out' }),
            ).resolves.toEqual({ value: 'secondary:out' });
            await expect(
                secondaryCaller.connection.service(PRIMARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'back' }),
            ).resolves.toEqual({ value: 'primary:back' });
            expect(logs.some((line) => line.endsWith(' connected'))).toBe(true);
        } finally {
            primaryCaller?.dispose();
            primaryEcho?.dispose();
            secondaryCaller.dispose();
            secondaryEcho.dispose();
            conflict.dispose();
            secondary.dispose();
            primary.dispose();
        }
    });

    it('serves locally before an initially unavailable socket appears', async () => {
        const socketPath = SocketServer.allocSocketPath();
        const logs: string[] = [];
        const secondary = await runHub({
            config: secondaryConfig(socketPath),
            log: (line) => logs.push(line),
        });
        const secondaryEcho = attachEcho(secondary, SECONDARY_ECHO_SERVICE_ID, 'secondary');
        const secondaryCaller = attachPeer(secondary);
        let primary: RunningHub | undefined;
        let primaryEcho: ReturnType<typeof attachEcho> | undefined;
        let primaryCaller: ReturnType<typeof attachPeer> | undefined;

        try {
            await expect(
                secondaryCaller.connection.service(SECONDARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'local' }),
            ).resolves.toEqual({ value: 'secondary:local' });
            await waitFor(
                () => logs.some((line) => line.includes('connect') && line.includes('failed')),
                'initial socket failure log',
            );

            primary = await runHub({ config: primaryConfig(socketPath), log: () => { } });
            primaryEcho = attachEcho(primary, PRIMARY_ECHO_SERVICE_ID, 'primary');
            primaryCaller = attachPeer(primary);
            await waitForClaim(primary, SECONDARY_SERVICE_ID);

            await expect(
                primaryCaller.connection.service(SECONDARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'out' }),
            ).resolves.toEqual({ value: 'secondary:out' });
            await expect(
                secondaryCaller.connection.service(PRIMARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'back' }),
            ).resolves.toEqual({ value: 'primary:back' });
        } finally {
            primaryCaller?.dispose();
            primaryEcho?.dispose();
            primary?.dispose();
            secondaryCaller.dispose();
            secondaryEcho.dispose();
            secondary.dispose();
        }
    });

    it('carries traffic both ways over one link and reconnects after the far-end hub restarts', async () => {
        const socketPath = SocketServer.allocSocketPath();
        let primary = await runHub({ config: primaryConfig(socketPath), log: () => { } });
        const secondary = await runHub({
            config: discoverableSecondaryConfig(socketPath),
            log: () => { },
        });
        const secondaryEcho = attachEcho(secondary, SECONDARY_ECHO_SERVICE_ID, 'secondary');
        let primaryEcho = attachEcho(primary, PRIMARY_ECHO_SERVICE_ID, 'primary-1');
        const secondaryCaller = attachPeer(secondary);
        let primaryCaller = attachPeer(primary);

        try {
            await waitForClaim(primary, SECONDARY_SERVICE_ID);
            const beforeRestart = await fetchFullDirectory(
                primaryCaller.connection,
                PRIMARY_SERVICE_ID,
            );
            expect(beforeRestart).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    serviceId: SECONDARY_SERVICE_ID,
                    interfaceId: 'hubAccessManifest',
                }),
                expect.objectContaining({
                    serviceId: SECONDARY_ECHO_SERVICE_ID,
                    interfaceId: echoInterface.info.id,
                }),
            ]));
            await expect(
                primaryCaller.connection.service(SECONDARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'out' }),
            ).resolves.toEqual({ value: 'secondary:out' });
            await expect(
                secondaryCaller.connection.service(PRIMARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'back' }),
            ).resolves.toEqual({ value: 'primary-1:back' });

            primaryCaller.dispose();
            primaryEcho.dispose();
            primary.dispose();

            await new Promise((resolve) => setTimeout(resolve, 300));
            primary = await runHub({ config: primaryConfig(socketPath), log: () => { } });
            primaryEcho = attachEcho(primary, PRIMARY_ECHO_SERVICE_ID, 'primary-2');
            primaryCaller = attachPeer(primary);
            await waitForClaim(primary, SECONDARY_SERVICE_ID);
            const afterRestart = await fetchFullDirectory(
                primaryCaller.connection,
                PRIMARY_SERVICE_ID,
            );
            expect(afterRestart).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    serviceId: SECONDARY_SERVICE_ID,
                    interfaceId: 'hubAccessManifest',
                }),
                expect.objectContaining({
                    serviceId: SECONDARY_ECHO_SERVICE_ID,
                    interfaceId: echoInterface.info.id,
                }),
            ]));

            await expect(
                primaryCaller.connection.service(SECONDARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'again' }),
            ).resolves.toEqual({ value: 'secondary:again' });
            await expect(
                secondaryCaller.connection.service(PRIMARY_ECHO_SERVICE_ID)
                    .get(echoInterface).echo({ value: 'again' }),
            ).resolves.toEqual({ value: 'primary-2:again' });
        } finally {
            primaryCaller.dispose();
            secondaryCaller.dispose();
            primaryEcho.dispose();
            secondaryEcho.dispose();
            secondary.dispose();
            primary.dispose();
        }
    });
});

describe('runHub listener default route', () => {
    const CHILD_SERVICE_ID = `${PRIMARY_SERVICE_ID}/child`;
    const CHILD_ECHO_SERVICE_ID = `${CHILD_SERVICE_ID}/echo`;
    const ELSEWHERE_ECHO_SERVICE_ID = 'test.elsewhere/echo';

    // The child only listens; the parent connects in (like the devbox Docker
    // hub, whose uplink comes from outside), and the listener makes it the
    // child's default route.
    const childConfig = (socketPath: string) => HubConfigSchema.parse({
        hubServiceId: CHILD_SERVICE_ID,
        forwardChecking: false,
        listeners: [{
            type: 'socket',
            path: socketPath,
            handlers: [{ token: 'static', value: UPLINK_TOKEN, defaultRoute: true }],
        }],
    });
    const parentConfig = (socketPath: string) => HubConfigSchema.parse({
        hubServiceId: PRIMARY_SERVICE_ID,
        forwardChecking: false,
        endpoints: [{ kind: 'socket', path: socketPath, token: UPLINK_TOKEN, routeServiceIds: [CHILD_SERVICE_ID] }],
    });
    const echo = (peer: { connection: LinkRpcConnection<unknown> }, serviceId: string, value: string) =>
        peer.connection.service(serviceId).get(echoInterface).echo({ value });
    /** Retries `call` until it succeeds (or fails), e.g. while the parent (re)connects. */
    const settles = async (call: () => Promise<unknown>, succeeds: boolean, description: string) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
            if (await call().then(() => true, () => false) === succeeds) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`timed out waiting for ${description}`);
    };

    it('routes unclaimed ids up, fails unknown child ids without looping, and follows reconnects', async () => {
        const socketPath = SocketServer.allocSocketPath();
        const child = await runHub({ config: childConfig(socketPath), log: () => { } });
        const childEcho = attachEcho(child, CHILD_ECHO_SERVICE_ID, 'child');
        const childCaller = attachPeer(child);
        let parent = await runHub({ config: parentConfig(socketPath), log: () => { } });
        let elsewhereEcho = attachEcho(parent, ELSEWHERE_ECHO_SERVICE_ID, 'parent-1');
        let parentCaller = attachPeer(parent);
        try {
            await settles(() => echo(childCaller, ELSEWHERE_ECHO_SERVICE_ID, 'probe'), true, 'uplink');
            await expect(echo(childCaller, ELSEWHERE_ECHO_SERVICE_ID, 'up')).resolves.toEqual({ value: 'parent-1:up' });
            await expect(echo(parentCaller, CHILD_ECHO_SERVICE_ID, 'down')).resolves.toEqual({ value: 'child:down' });
            await expect(echo(childCaller, `${CHILD_SERVICE_ID}/missing`, 'x')).rejects.toThrow(/no route|Method not found/);
            await expect(echo(parentCaller, `${CHILD_SERVICE_ID}/missing`, 'x')).rejects.toThrow(/no route|Method not found/);

            parentCaller.dispose();
            elsewhereEcho.dispose();
            parent.dispose();
            await settles(() => echo(childCaller, ELSEWHERE_ECHO_SERVICE_ID, 'probe'), false, 'uplink cleared');
            await expect(echo(childCaller, ELSEWHERE_ECHO_SERVICE_ID, 'gone')).rejects.toThrow(/no route|Method not found/);

            parent = await runHub({ config: parentConfig(socketPath), log: () => { } });
            elsewhereEcho = attachEcho(parent, ELSEWHERE_ECHO_SERVICE_ID, 'parent-2');
            parentCaller = attachPeer(parent);
            await settles(() => echo(childCaller, ELSEWHERE_ECHO_SERVICE_ID, 'probe'), true, 'uplink again');
            await expect(echo(childCaller, ELSEWHERE_ECHO_SERVICE_ID, 'again')).resolves.toEqual({ value: 'parent-2:again' });
        } finally {
            parentCaller.dispose();
            childCaller.dispose();
            elsewhereEcho.dispose();
            childEcho.dispose();
            parent.dispose();
            child.dispose();
        }
    });

    it('rejects a second default route in the same config', async () => {
        const config = HubConfigSchema.parse({
            ...childConfig(SocketServer.allocSocketPath()),
            endpoints: [{ kind: 'socket', path: SocketServer.allocSocketPath(), defaultRoute: true }],
        });
        await expect(runHub({ config, log: () => { } })).rejects.toThrow(/default-route conflict/);
    });
});
