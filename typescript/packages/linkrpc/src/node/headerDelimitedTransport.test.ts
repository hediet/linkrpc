import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { JsonRpcMessage } from '../protocol/jsonRpc';
import { HeaderDelimitedTransport } from './headerDelimitedTransport';

describe('HeaderDelimitedTransport', () => {
    it('parses fragmented and coalesced LSP frames with case-insensitive headers', () => {
        const input = new PassThrough();
        const transport = new HeaderDelimitedTransport(input, new PassThrough());
        const received: JsonRpcMessage[] = [];
        transport.setListener((message) => received.push(message));
        const first = frame(
            { jsonrpc: '2.0', method: 'first', params: 'héllo' },
            'cOnTeNt-TyPe: application/vscode-jsonrpc; Charset = "UTF-8"\r\n',
        );
        const second = frame({ jsonrpc: '2.0', id: 'two', result: null });

        input.write(first.subarray(0, 11));
        input.write(Buffer.concat([first.subarray(11), second]));

        expect(received).toEqual([
            { jsonrpc: '2.0', method: 'first', params: 'héllo' },
            { jsonrpc: '2.0', id: 'two', result: null },
        ]);
        transport.dispose();
    });

    it('reports malformed, oversized, and truncated frames', async () => {
        const cases = [
            {
                wire: 'Content-Length: nope\r\n\r\n{}',
                options: {},
                reason: 'missing or invalid Content-Length',
            },
            {
                wire: 'Content-Length: 11\r\n\r\n',
                options: { maxContentLength: 10 },
                reason: 'Content-Length exceeds 10 bytes',
            },
            {
                wire: 'Content-Length: 4\r\n\r\n{}',
                options: {},
                reason: 'Truncated header-delimited frame',
                end: true,
            },
        ];
        for (const testCase of cases) {
            const input = new PassThrough();
            let reason: string | undefined;
            const transport = new HeaderDelimitedTransport(
                input,
                new PassThrough(),
                (value) => { reason = value; },
                testCase.options,
            );
            if (testCase.end) input.end(testCase.wire);
            else input.write(testCase.wire);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(transport.closed).toBe(true);
            expect(reason).toContain(testCase.reason);
        }
    });

    it('uses UTF-8 byte length and does not take stream ownership', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const chunks: Buffer[] = [];
        output.on('data', (chunk: Buffer) => chunks.push(chunk));
        const transport = new HeaderDelimitedTransport(input, output);

        await transport.send({ jsonrpc: '2.0', method: 'unicode', params: '🦊' });
        const wire = Buffer.concat(chunks);
        const separator = wire.indexOf(Buffer.from('\r\n\r\n'));
        const body = wire.subarray(separator + 4);
        expect(wire.subarray(0, separator).toString()).toBe(`Content-Length: ${body.length}`);

        transport.dispose();
        expect(input.destroyed).toBe(false);
        expect(output.destroyed).toBe(false);
    });
});

function frame(message: JsonRpcMessage, extraHeader = ''): Buffer {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    return Buffer.concat([
        Buffer.from(`${extraHeader}Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
        body,
    ]);
}
