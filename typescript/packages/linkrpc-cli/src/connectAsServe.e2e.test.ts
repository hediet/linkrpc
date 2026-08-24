import { describe, expect, it } from 'vitest';
import {
    defineInterface,
    requestType,
    LinkRpcConnection,
    TransportPair,
} from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import { z } from 'zod';
import { connectionTokenBinderInterface } from '@hediet/linkrpc-hub/hub/server';
import { SocketServer } from '@hediet/linkrpc-hub/hub/server/node';
import { runHub, type RunningHub } from './engine/runHub';
import { parseHubConfig } from '@hediet/linkrpc-client';
import { connectAs } from './commands/connectAs';
import { openDialTransport, type DialEndpoint } from './commands/connectAsTransports';

const echoInterface = defineInterface(
    { id: 'echo', description: 'Echoes a message.' },
    { echo: requestType(z.object({ message: z.string() }), z.object({ reply: z.string() })) },
);

/**
 * A trivial stay-alive child for the `cmd-env` minter endpoint. Its only job is
 * to exist so `runHub` registers the routable `hub::connectionTokenBinder`
 * (registration is config-driven; the child need not participate). `runHub`
 * kills it on dispose.
 */
const IDLE_ARGV = [process.execPath, '-e', 'setInterval(() => {}, 2147483647)'];

describe('connect-as e2e (runHub config path: bound listener + central connectionTokenBinder)', () => {
    it('serves the hub from config, mints via hub::connectionTokenBinder, and splices a target as its slot', async () => {
        // Real bound-token socket listener + a cmd-env endpoint whose
        // `connectionTokenBinder` config makes `runHub` register the routable
        // `hub::connectionTokenBinder` (scoped to `svc/`).
        const boundPath = SocketServer.allocSocketPath();
        const config = parseHubConfig({
            forwardChecking: false,
            hubServiceId: 'hub',
            listeners: [
                { type: 'socket', path: boundPath, handlers: [{ token: 'bound' }] },
            ],
            endpoints: [
                {
                    kind: 'cmd-env',
                    argv: IDLE_ARGV,
                    connectionTokenBinder: { identitySlotPrefix: 'svc/', serviceIdPrefix: 'svc/' },
                },
            ],
        });

        let running: RunningHub | undefined;
        try {
            running = await runHub({ config, log: () => { /* quiet */ } });

            // Broker: attach in-process to mint via the routable binder.
            const brokerPair = new TransportPair();
            running.hub.attach(brokerPair.a);
            const brokerConn = LinkRpcConnection.fromTransport(brokerPair.b);
            const binder = brokerConn.service('hub').get(connectionTokenBinderInterface);

            // Target: an in-memory participant; connect-as splices its far side
            // onto the hub's real bound-token socket listener.
            const targetPair = new TransportPair();
            const targetConn = LinkRpcConnection.fromTransport(targetPair.b);

            let stopConnectAs: (() => void) | undefined;
            const stop = new Promise<void>((r) => { stopConnectAs = r; });
            const boundEndpoint: DialEndpoint = { kind: 'socket', path: boundPath };

            const run = connectAs({
                mintToken: async () => {
                    const { token } = await binder.bindConnectionToken({
                        identitySlot: 'svc/echo',
                        serviceIdNamespace: 'svc/echo',
                    });
                    return token;
                },
                openHubTransport: (token) => openDialTransport(boundEndpoint, token),
                openTargetTransport: async () => ({
                    transport: targetPair.a,
                    onClose: () => { /* driven by the test */ },
                    dispose: () => targetPair.a.dispose(),
                }),
                stop,
            });

            // The spliced target is a bound participant: it sees + claims its
            // granted namespace and serves a service the hub can route to.
            const grant = await targetConn.get(hubGrantedServiceIdInterface).get({});
            expect(grant.grantedServiceIdNamespace).toBe('svc/echo');

            await targetConn.get(hubGrantedServiceIdInterface).register({ serviceId: 'svc/echo' });
            targetConn.register(
                echoInterface,
                { echo: ({ message }) => ({ reply: `echo:${message}` }) },
                { serviceId: 'svc/echo' },
            );

            // A second in-process consumer reaches the target through the splice.
            const consumerPair = new TransportPair();
            running.hub.attach(consumerPair.a);
            const consumer = LinkRpcConnection.fromTransport(consumerPair.b);
            const res = await consumer.service('svc/echo').get(echoInterface).echo({ message: 'ping' });
            expect(res).toEqual({ reply: 'echo:ping' });

            consumer.close();
            brokerConn.close();
            targetConn.close();
            stopConnectAs?.();
            await run;
        } finally {
            running?.dispose();
        }
    });
});
