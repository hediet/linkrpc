import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRawJsonRpcTransport } from '../json-rpc/client';
import { jsonRpcConnectionInterface } from '../json-rpc/interface';
import { lspInterface } from './index';
import { registerLanguageServerHost } from './node';

const MOCK_LSP_SCRIPT = `
const sep = Buffer.from('\\r\\n\\r\\n', 'ascii');
let buf = Buffer.alloc(0);
let expected = null;
function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    if (expected === null) {
      const idx = buf.indexOf(sep);
      if (idx === -1) return;
      const m = /content-length:\\s*(\\d+)/i.exec(buf.subarray(0, idx).toString('ascii'));
      expected = Number(m[1]);
      buf = buf.subarray(idx + 4);
    }
    if (buf.length < expected) return;
    const msg = JSON.parse(buf.subarray(0, expected).toString('utf8'));
    buf = buf.subarray(expected);
    expected = null;
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true }, cwd: process.cwd() } });
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'exit') {
      process.exit(0);
    }
  }
});
`;

describe('registerLanguageServerHost', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        for (const dir of tempDirs.splice(0)) {
            await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        }
    });

    async function makeTempDir(): Promise<string> {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'linkrpc-lsp-test-'));
        tempDirs.push(dir);
        return dir;
    }

    it('lists servers, runs an LSP initialize handshake, and rejects roots outside allowedRoots', async () => {
        const allowed = await makeTempDir();
        const outside = await makeTempDir();
        const mockServerPath = path.join(allowed, 'mock-lsp.cjs');
        await writeFile(mockServerPath, MOCK_LSP_SCRIPT, 'utf8');

        const link = new TransportPair();
        const serverConn = LinkRpcConnection.fromTransport(link.a);
        const clientConn = LinkRpcConnection.fromTransport(link.b);

        const reg = registerLanguageServerHost({
            connection: serverConn,
            serviceId: 'node/lsp',
            servers: [
                { id: 'mock', command: [process.execPath, mockServerPath], languages: ['rust'] },
            ],
            allowedRoots: [allowed],
            maxSessions: 2,
        });

        try {
            const lspClient = clientConn.get(lspInterface, { serviceId: 'node/lsp' });
            expect(await lspClient.listServers({})).toEqual({
                servers: [{ id: 'mock', languages: ['rust'] }],
            });

            const rawClient = clientConn.get(jsonRpcConnectionInterface, { serviceId: 'node/lsp' });

            // Rejects unknown server
            await expect(
                connectRawJsonRpcTransport(rawClient, { server: 'nope', rootUri: pathToFileURL(allowed).href }),
            ).rejects.toThrow(/Unknown language server/);

            // Rejects root outside allowedRoots
            await expect(
                connectRawJsonRpcTransport(rawClient, { server: 'mock', rootUri: pathToFileURL(outside).href }),
            ).rejects.toThrow(/outside allowed roots/);

            // Succeeds for allowed root and exchanges LSP initialize
            const transport = await connectRawJsonRpcTransport(rawClient, {
                server: 'mock',
                rootUri: pathToFileURL(allowed).href,
            });
            const reply = new Promise<unknown>((resolve) => {
                transport.onMessage((frame) => resolve(frame));
            });
            await transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
            const initResult = await reply as { id: number; result: { capabilities: { hoverProvider: boolean } } };
            expect(initResult.id).toBe(1);
            expect(initResult.result.capabilities.hoverProvider).toBe(true);

            transport.close('done');
        } finally {
            reg.dispose();
            link.a.dispose();
            link.b.dispose();
        }
    });
});
