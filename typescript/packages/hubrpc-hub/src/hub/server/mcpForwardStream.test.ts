import { describe, expect, it } from 'vitest';
import { defineInterface, requestType, HubRpcConnection, TransportPair } from '@vscode/hubrpc';
import { z } from 'zod';
import { hubGrantedServiceIdInterface } from '@vscode/hubrpc/hub/common';
import { createHubServiceInterfaces } from './hubServices';
import { RootOverlay } from './routing/rootOverlay';
import { registerHubServices } from './rootServices';
import { type AttachedLink, Hub } from './routing/routingHub';

/**
 * Mirror of `vscode.mcp-forward`: one long-lived streaming `connect` request
 * whose duplex stream carries opaque frames. We keep a local copy so this hub
 * test has no dependency on the CLI package.
 */
const forwardInterface = defineInterface(
    { id: 'vscode.mcp-forward', description: 'Transparent MCP tunnel.' },
    {
        connect: requestType(
            z.object({ clientInfo: z.object({ name: z.string(), version: z.string() }).optional() }),
            z.object({ serverInfo: z.object({ name: z.string(), version: z.string() }).optional() }),
        ).withStream({
            client: z.object({ frame: z.unknown() }),
            server: z.object({ frame: z.unknown() }),
        }),
    },
);

function makeOverlay(hub: Hub, grantedServiceIdNamespace?: string): { overlay: RootOverlay; upstream: AttachedLink; } {
    const p = new TransportPair();
    const upstream = hub.attach(p.b);
    const overlay = new RootOverlay({ uplink: p.a });
    registerHubServices(overlay.root, upstream, { grantedServiceIdNamespace });
    return { overlay, upstream };
}

/** Attach a participant onto a fresh overlay and return its connection. */
function joinOverlay(hub: Hub, prefix: string): { conn: HubRpcConnection; overlay: RootOverlay; } {
    const { overlay } = makeOverlay(hub, prefix);
    const pair = new TransportPair();
    overlay.connectParticipant(pair.a);
    const conn = HubRpcConnection.fromTransport(pair.b);
    return { conn, overlay };
}

describe('mcp-forward streaming across the hub', () => {
    it('round-trips duplex frames between two participants through the hub', async () => {
        const hub = new Hub();
        createHubServiceInterfaces(hub);

        // Producer: serves the forward interface under `cli`, echoes each client
        // frame straight back as a server frame, and keeps the leg open.
        const producer = joinOverlay(hub, 'cli');
        const received: unknown[] = [];
        producer.conn.register(
            forwardInterface,
            {
                connect: (_params, _ctx, stream) => {
                    stream.onMessage(({ frame }) => {
                        received.push(frame);
                        stream.send({ frame: { echoed: frame } });
                    });
                    return new Promise(() => { /* stays open for the session */ });
                },
            },
            { serviceId: 'cli' },
        );
        producer.conn.enableReflection({ serviceId: 'cli' });
        await producer.conn.get(hubGrantedServiceIdInterface).register({ serviceId: 'cli' });

        // Consumer: opens the leg and sends a frame immediately (the race the
        // MCP `initialize` handshake hits).
        const consumer = joinOverlay(hub, 'aggregator');
        const fromServer: unknown[] = [];
        const call = consumer.conn
            .service('cli')
            .get(forwardInterface)
            .connect(
                { clientInfo: { name: 'test', version: '0.0.0' } },
                { onMessage: ({ frame }) => fromServer.push(frame) },
            );
        call.send({ frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } });

        await _until(() => fromServer.length > 0, 2000);

        expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'initialize' }]);
        expect(fromServer).toEqual([
            { echoed: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
        ]);

        call.cancel('done');
    });
});

async function _until(cond: () => boolean, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}
