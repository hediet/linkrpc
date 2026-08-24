import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineInterface } from '../connection/interfaceDefinition';
import { requestType } from '../schema/memberTypes';
import { NdjsonTransport } from './ndjsonTransport';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { JsonRpcChannel } from '../connection/jsonRpcChannel';

const echo = defineInterface(
    { id: 'test.echo' },
    {
        ping: requestType(z.object({ msg: z.string() }), z.object({ pong: z.string() })),
    },
);

/**
 * Wire two ndjson transports back-to-back through Node PassThrough streams.
 * Exercises the real framing path without spawning a child.
 */
function makeNdjsonPair(): { client: LinkRpcConnection; server: LinkRpcConnection; dispose: () => void; } {
    const aToB = new PassThrough({ encoding: 'utf8' });
    const bToA = new PassThrough({ encoding: 'utf8' });
    const clientTransport = new NdjsonTransport(bToA, aToB);
    const serverTransport = new NdjsonTransport(aToB, bToA);
    const client = LinkRpcConnection.fromTransport(clientTransport);
    const server = LinkRpcConnection.fromTransport(serverTransport);
    return {
        client,
        server,
        dispose: () => {
            client.close();
            server.close();
            aToB.end();
            bToA.end();
        },
    };
}

describe('NdjsonTransport', () => {
    it('round-trips a request over newline-delimited JSON', async () => {
        const { client, server, dispose } = makeNdjsonPair();
        server.register(echo, {
            ping: async ({ msg }) => ({ pong: msg.toUpperCase() }),
        });
        const r = await client.get(echo).ping({ msg: 'hi' });
        expect(r).toEqual({ pong: 'HI' });
        dispose();
    });

    it('handles chunked input that splits across message boundaries', async () => {
        const input = new PassThrough({ encoding: 'utf8' });
        const output = new PassThrough({ encoding: 'utf8' });
        const received: unknown[] = [];
        const t = new NdjsonTransport(input, output);
        t.setListener((m) => received.push(m));

        // Write two messages split awkwardly: half, rest+newline+half, rest.
        const m1 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x' }) + '\n';
        const m2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'y' }) + '\n';
        input.write(m1.slice(0, 5));
        input.write(m1.slice(5) + m2.slice(0, 7));
        input.write(m2.slice(7));

        await new Promise((r) => setImmediate(r));
        expect(received).toEqual([
            { jsonrpc: '2.0', id: 1, method: 'x' },
            { jsonrpc: '2.0', id: 2, method: 'y' },
        ]);
        t.dispose();
    });

    it('ignores malformed JSON lines without breaking the stream', async () => {
        const input = new PassThrough({ encoding: 'utf8' });
        const output = new PassThrough({ encoding: 'utf8' });
        const received: unknown[] = [];
        const t = new NdjsonTransport(input, output);
        t.setListener((m) => received.push(m));

        input.write('not-json\n');
        input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ok' }) + '\n');

        await new Promise((r) => setImmediate(r));
        expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ok' }]);
        t.dispose();
    });

    it('closes cleanly when the output stream emits an asynchronous write error', async () => {
        const input = new PassThrough({ encoding: 'utf8' });
        const output = new PassThrough({ encoding: 'utf8' });
        let closeCount = 0;
        const t = new NdjsonTransport(input, output, () => closeCount++);

        output.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        await new Promise((r) => setImmediate(r));

        expect(closeCount).toBe(1);
        expect(() => t.send({ jsonrpc: '2.0', id: 1, method: 'after-close' })).not.toThrow();
    });

    it('rejects pending and subsequent requests when the channel closes', async () => {
        const input = new PassThrough({ encoding: 'utf8' });
        const output = new PassThrough({ encoding: 'utf8' });
        const rpc = JsonRpcChannel.createWithClose(new NdjsonTransport(input, output));

        const pending = rpc.channel.sender.sendRequest('test::pending', undefined);
        rpc.close();

        await expect(pending).rejects.toThrow(/Connection closed/);
        await expect(rpc.channel.sender.sendRequest('test::after-close', undefined)).rejects.toThrow(
            /Connection closed/,
        );
    });
});
