import { describe, expect, it } from 'vitest';
import { HubRpcConnection, TransportPair } from '@vscode/hubrpc';
import { mcpForwardInterface } from './mcpForward.interface';

/**
 * Verifies the raw streaming round-trip the MCP aggregator depends on: a client
 * frame sent immediately after `connect` must reach the server handler, and a
 * server frame must reach the client's `onMessage`. This isolates the hubrpc
 * stream wiring from the CLI child-process forwarder + socket transport.
 */
describe('mcpForward streaming round-trip', () => {
    it('delivers a client frame sent right after connect, and echoes back', async () => {
        const pair = new TransportPair();
        const serverConn = HubRpcConnection.fromTransport(pair.a);
        const clientConn = HubRpcConnection.fromTransport(pair.b);

        const received: unknown[] = [];
        let resolveGotFirst: () => void;
        const gotFirst = new Promise<void>((r) => (resolveGotFirst = r));

        serverConn.register(
            mcpForwardInterface,
            {
                connect: (_params, _ctx, stream) => {
                    stream.onMessage(({ frame }) => {
                        received.push(frame);
                        // Echo the frame straight back to the client.
                        stream.send({ frame: { echoed: frame } });
                        resolveGotFirst();
                    });
                    // Never resolve: a real forward leg stays open for the
                    // whole MCP session.
                    return new Promise(() => { });
                },
            },
            { serviceId: 'svc' },
        );

        const fromServer: unknown[] = [];
        const call = clientConn
            .service('svc')
            .get(mcpForwardInterface)
            .connect(
                { clientInfo: { name: 'test', version: '0.0.0' } },
                { onMessage: ({ frame }) => fromServer.push(frame) },
            );

        // Send a frame immediately — this is the race the MCP `initialize`
        // handshake hits.
        call.send({ frame: { jsonrpc: '2.0', id: 1, method: 'initialize' } });

        await gotFirst;
        // Give the echo a tick to travel back.
        await new Promise((r) => setTimeout(r, 20));

        expect(received).toEqual([
            { jsonrpc: '2.0', id: 1, method: 'initialize' },
        ]);
        expect(fromServer).toEqual([
            { echoed: { jsonrpc: '2.0', id: 1, method: 'initialize' } },
        ]);

        call.cancel('done');
    });
});
