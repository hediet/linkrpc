import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
    connectNdjson,
    INITIALIZE_METHOD,
    LINKRPC_INITIALIZE_METHOD_ALIAS,
} from './initialize';
import type { JsonRpcMessage } from '../protocol/jsonRpc';

/** A pair of streams wired back-to-back: what a sends, b receives. */
function streamPair(): { aIn: PassThrough; aOut: PassThrough; } {
    return { aIn: new PassThrough({ encoding: 'utf8' }), aOut: new PassThrough({ encoding: 'utf8' }) };
}

function collect(stream: PassThrough): () => string {
    let buf = '';
    stream.on('data', (c: string) => (buf += c));
    return () => buf;
}

describe('connectNdjson handshake', () => {
    it('completes a client/server initialize and binds the token', async () => {
        const aToB = new PassThrough({ encoding: 'utf8' });
        const bToA = new PassThrough({ encoding: 'utf8' });

        const serverP = connectNdjson({
            input: aToB,
            output: bToA,
            initialize: { kind: 'server', isTokenAccepted: async (t) => t === 'sekret' },
        });
        const clientP = connectNdjson({
            input: bToA,
            output: aToB,
            initialize: { kind: 'client', token: 'sekret' },
        });

        const [server, client] = await Promise.all([serverP, clientP]);
        expect(server.token).toBe('sekret');

        // The handshake messages are consumed by the transport, not delivered up.
        const received: JsonRpcMessage[] = [];
        server.transport.setListener((m) => received.push(m));
        void client.transport.send({ jsonrpc: '2.0', id: 1, method: 'app::ping', params: {} });
        await new Promise((r) => setTimeout(r, 20));
        expect(received).toHaveLength(1);
        expect((received[0] as { method: string }).method).toBe('app::ping');
    });

    it('traces handshake messages in both directions', async () => {
        const aToB = new PassThrough({ encoding: 'utf8' });
        const bToA = new PassThrough({ encoding: 'utf8' });
        const traced: Array<{ direction: string; method?: string; }> = [];

        const serverP = connectNdjson({
            input: aToB,
            output: bToA,
            initialize: { kind: 'server', isTokenAccepted: async () => true },
        });
        const clientP = connectNdjson({
            input: bToA,
            output: aToB,
            initialize: { kind: 'client', token: 'sekret' },
            trace: (direction, message) => traced.push({
                direction,
                ...('method' in message ? { method: message.method } : {}),
            }),
        });

        await Promise.all([serverP, clientP]);
        expect(traced).toEqual([
            { direction: 'send', method: INITIALIZE_METHOD },
            { direction: 'receive' },
        ]);
    });

    it('rejects a bad token and sends an error reply', async () => {
        const aToB = new PassThrough({ encoding: 'utf8' });
        const bToA = new PassThrough({ encoding: 'utf8' });
        const clientSees = collect(bToA);

        const serverP = connectNdjson({
            input: aToB,
            output: bToA,
            initialize: { kind: 'server', isTokenAccepted: async () => false },
        });
        const clientP = connectNdjson({
            input: bToA,
            output: aToB,
            initialize: { kind: 'client', token: 'nope' },
        });

        await expect(serverP).rejects.toThrow(/unauthenticated/);
        await expect(clientP).rejects.toThrow(/rejected/);
        expect(clientSees()).toContain('unauthenticated');
    });

    it('rejects when the first message is not initialize', async () => {
        const aToB = new PassThrough({ encoding: 'utf8' });
        const bToA = new PassThrough({ encoding: 'utf8' });

        const serverP = connectNdjson({
            input: aToB,
            output: bToA,
            initialize: { kind: 'server', isTokenAccepted: async () => true },
        });
        // Client sends a non-initialize message first.
        aToB.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'app::ping', params: {} }) + '\n');

        await expect(serverP).rejects.toThrow(/expected initialize/);
    });

    it('accepts the transitional linkrpc initialize spelling server-side', async () => {
        const aToB = new PassThrough({ encoding: 'utf8' });
        const bToA = new PassThrough({ encoding: 'utf8' });
        const serverReply = collect(bToA);
        const serverP = connectNdjson({
            input: aToB,
            output: bToA,
            initialize: { kind: 'server', isTokenAccepted: async (token) => token === 'sekret' },
        });
        aToB.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: LINKRPC_INITIALIZE_METHOD_ALIAS,
            params: { protocolVersion: 1, token: 'sekret' },
        }) + '\n');

        await expect(serverP).resolves.toMatchObject({ token: 'sekret' });
        expect(serverReply()).toContain('"protocolVersion":1');
    });

    it('times out when no handshake arrives', async () => {
        const { aIn, aOut } = streamPair();
        await expect(
            connectNdjson({
                input: aIn,
                output: aOut,
                initialize: { kind: 'server', isTokenAccepted: async () => true },
                handshakeTimeoutMs: 30,
            }),
        ).rejects.toThrow(/timed out/);
    });

    it('rejects immediately when the transport closes during the handshake', async () => {
        const { aIn, aOut } = streamPair();
        const connecting = connectNdjson({
            input: aIn,
            output: aOut,
            initialize: { kind: 'client' },
            handshakeTimeoutMs: 10_000,
        });

        aIn.destroy();

        await expect(connecting).rejects.toThrow(/transport closed during handshake/);
    });

    it('passes through with no initialize role', async () => {
        const { aIn, aOut } = streamPair();
        const { transport, token } = await connectNdjson({ input: aIn, output: aOut });
        expect(token).toBeUndefined();
        expect(typeof transport.send).toBe('function');
        // No handshake bytes written.
        expect(aOut.readableLength).toBe(0);
        void INITIALIZE_METHOD;
    });
});
