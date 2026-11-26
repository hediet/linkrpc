import { PassThrough } from 'node:stream';
import type { JsonValue } from '@hediet/linkrpc';
import { describe, expect, it } from 'vitest';
import { createContentLengthJsonRpcTransport } from './contentLength';

function frameMessage(message: JsonValue, extraHeaders = ''): Buffer {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = `Content-Length: ${body.length}\r\n${extraHeaders}\r\n`;
    return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

describe('createContentLengthJsonRpcTransport', () => {
    it('round-trips JSON-RPC messages including multibyte UTF-8 characters', async () => {
        const aToB = new PassThrough();
        const bToA = new PassThrough();
        const a = createContentLengthJsonRpcTransport({ input: bToA, output: aToB });
        const b = createContentLengthJsonRpcTransport({ input: aToB, output: bToA });

        const receivedByB: JsonValue[] = [];
        const receivedByA: JsonValue[] = [];
        b.onMessage((frame) => receivedByB.push(frame));
        a.onMessage((frame) => receivedByA.push(frame));

        const req = { jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: { text: 'héllo 🦀 世界' } };
        const res = { jsonrpc: '2.0', id: 1, result: { contents: '→ ok' } };
        await a.send(req);
        await b.send(res);
        await new Promise((r) => setImmediate(r));

        expect(receivedByB).toEqual([req]);
        expect(receivedByA).toEqual([res]);

        a.close();
        b.close();
    });

    it('parses byte-by-byte split chunks, extra headers, and multiple messages in one chunk', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const transport = createContentLengthJsonRpcTransport({ input, output });

        const received: JsonValue[] = [];
        transport.onMessage((frame) => received.push(frame));

        const m1 = { jsonrpc: '2.0', id: 1, method: 'initialize' };
        const m2 = { jsonrpc: '2.0', method: 'initialized', params: { note: '✓' } };
        const combined = Buffer.concat([
            frameMessage(m1, 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n'),
            frameMessage(m2),
        ]);

        // Feed first message byte-by-byte, second message in one chunk.
        const splitPoint = 25;
        for (let i = 0; i < splitPoint; i++) {
            input.write(combined.subarray(i, i + 1));
        }
        input.write(combined.subarray(splitPoint));
        await new Promise((r) => setImmediate(r));

        expect(received).toEqual([m1, m2]);
        transport.close();
    });

    it('closes on missing Content-Length or oversized body', async () => {
        const input1 = new PassThrough();
        const output1 = new PassThrough();
        const t1 = createContentLengthJsonRpcTransport({ input: input1, output: output1 });
        const reason1 = new Promise<string | undefined>((resolve) => t1.onClose(resolve));
        input1.write('Content-Type: text/plain\r\n\r\n{}');
        expect(await reason1).toContain('Content-Length');
        expect(t1.closed).toBe(true);

        const input2 = new PassThrough();
        const output2 = new PassThrough();
        const t2 = createContentLengthJsonRpcTransport({ input: input2, output: output2, maxBodyBytes: 16 });
        const reason2 = new Promise<string | undefined>((resolve) => t2.onClose(resolve));
        input2.write(frameMessage({ jsonrpc: '2.0', id: 1, method: 'wayTooLongForSixteenBytes' }));
        expect(await reason2).toContain('exceeded 16 bytes');
        expect(t2.closed).toBe(true);
    });
});
