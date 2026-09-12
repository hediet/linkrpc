import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as publicApi from '@hediet/linkrpc-infra/json-rpc';

const protocolHelpers = [
    'createCdpWebSocketTransport',
    'createLspJsonRpcTransport',
    'createLspMessageTransport',
    'createLspChildProcessTransport',
    'importCdpProtocol',
    'importLspProtocol',
    'createProtocolInterfaceDefinition',
];

describe('protocol POC package boundary', () => {
    it('does not expose protocol-specific helpers in the public API', () => {
        for (const name of protocolHelpers) expect(publicApi).not.toHaveProperty(name);
    });

    it('does not package POC sources, declarations, or source maps', () => {
        const packageRoot = new URL('../../', import.meta.url);
        const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));
        expect(manifest.files).toEqual(['dist/']);
        expect(Object.keys(manifest.exports)).not.toContain('./json-rpc/contracts');
        for (const file of filesUnder(new URL('dist/', packageRoot))) {
            const content = readFileSync(file, 'utf8');
            expect(content, file.pathname).not.toContain('/test/protocols/');
            for (const name of protocolHelpers) {
                expect(content, file.pathname).not.toContain(name);
            }
        }
    });
});

function* filesUnder(directory: URL): Generator<URL> {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        if (entry.isDirectory()) yield* filesUnder(child);
        else if (entry.isFile()) yield child;
    }
}
