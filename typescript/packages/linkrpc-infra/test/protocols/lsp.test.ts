import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@hediet/linkrpc';
import { createLspJsonRpcTransport } from './lsp';

describe('LSP Content-Length transport', () => {
    it('decodes fragmented headers and coalesced UTF-8 frames', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const transport = createLspJsonRpcTransport({ input, output });
        const frames: JsonValue[] = [];
        transport.onMessage((frame) => frames.push(frame));
        const first = frame({ jsonrpc: '2.0', method: 'one', params: 'héllo' },
            'cOnTeNt-TyPe: application/vscode-jsonrpc; charset=utf-8\r\n');
        const second = frame({ jsonrpc: '2.0', id: 2, result: null });

        input.write(first.subarray(0, 7));
        input.write(Buffer.concat([first.subarray(7), second]));

        expect(frames).toEqual([
            { jsonrpc: '2.0', method: 'one', params: 'héllo' },
            { jsonrpc: '2.0', id: 2, result: null },
        ]);
        transport.close();
    });

    it('encodes Content-Length using UTF-8 bytes and preserves null params', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        const chunks: Buffer[] = [];
        output.on('data', (chunk: Buffer) => chunks.push(chunk));
        const transport = createLspJsonRpcTransport({ input, output });

        await transport.send({ jsonrpc: '2.0', id: 'x', method: 'echo', params: null });

        const wire = Buffer.concat(chunks);
        const separator = wire.indexOf(Buffer.from('\r\n\r\n'));
        const body = wire.subarray(separator + 4);
        expect(wire.subarray(0, separator).toString()).toBe(`Content-Length: ${body.length}`);
        expect(JSON.parse(body.toString())).toEqual({
            jsonrpc: '2.0', id: 'x', method: 'echo', params: null,
        });
        transport.close();
    });

    it('closes with explicit invalid and truncated frame errors', async () => {
        const invalidInput = new PassThrough();
        const invalid = createLspJsonRpcTransport({
            input: invalidInput,
            output: new PassThrough(),
        });
        let invalidReason: string | undefined;
        invalid.onClose((reason) => { invalidReason = reason; });
        invalidInput.write('Content-Length: nope\r\n\r\n{}');
        expect(invalid.closed).toBe(true);
        expect(invalidReason).toContain('Invalid LSP frame');

        const truncatedInput = new PassThrough();
        const truncated = createLspJsonRpcTransport({
            input: truncatedInput,
            output: new PassThrough(),
        });
        let truncatedReason: string | undefined;
        truncated.onClose((reason) => { truncatedReason = reason; });
        truncatedInput.end('Content-Length: 10\r\n\r\n{}');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(truncated.closed).toBe(true);
        expect(truncatedReason).toBe('Truncated LSP frame');
    });

    it('enforces configurable frame limits and content types', () => {
        for (const wire of [
            'Content-Length: 3\r\nContent-Type: application/json\r\n\r\n{}\n',
            'Long-Header: abcdefghijklmnopqrstuvwxyz\r\n\r\n',
            'Content-Length: 20\r\n\r\n',
        ]) {
            const input = new PassThrough();
            const transport = createLspJsonRpcTransport({
                input,
                output: new PassThrough(),
                maxHeaderBytes: 32,
                maxContentLength: 10,
            });
            input.write(wire);
            expect(transport.closed).toBe(true);
        }
    });
});

function frame(value: JsonValue, extraHeader = ''): Buffer {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    return Buffer.concat([
        Buffer.from(`${extraHeader}Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
        body,
    ]);
}
