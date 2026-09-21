import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
    bareInterfaceTarget,
    defaultsInterface,
    RpcError,
} from '@hediet/linkrpc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRustPeer, within } from './rustPeer';
import { createGeneratedProtocolInterfaceDefinition } from './contracts/generated';
import {
    cdpDocument,
    importedInteropContracts,
    lspDiagnostics,
    lspDidOpen,
    lspSelectionRanges,
    type InteropProtocol,
} from './generatedInteropContracts';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const manifest = fileURLToPath(new URL('./rust/Cargo.toml', import.meta.url));
const targetDirectory = join(repoRoot, 'rust', 'target', 'protocol-interop');
const coldRustBuildTimeoutMs = 600_000;
const binary = join(targetDirectory, 'debug',
    process.platform === 'win32' ? 'linkrpc-protocol-interop.exe' : 'linkrpc-protocol-interop');
const contracts = importedInteropContracts();
const protocols = ['cdp', 'lsp'] as const;
const prefix = (protocol: InteropProtocol): string => protocol === 'cdp' ? 'DOM.' : 'textDocument/';
let scratch: string | undefined;
let report: unknown;

beforeAll(async () => {
    const scratchParent = join(repoRoot, 'rust', 'target');
    await mkdir(scratchParent, { recursive: true });
    scratch = await mkdtemp(join(scratchParent, 'protocol-inputs-'));
    const schemas = join(scratch, 'schemas');
    await mkdir(join(schemas, 'full'), { recursive: true });
    await mkdir(join(schemas, 'selected'), { recursive: true });
    for (const schema of contracts.full) {
        await writeFile(join(schemas, 'full', `${schema.id}.json`), JSON.stringify(schema));
    }
    for (const schema of Object.values(contracts.selected)) {
        await writeFile(join(schemas, 'selected', `${schema.id}.json`), JSON.stringify(schema));
    }
    const reportPath = join(targetDirectory, 'generation-report.json');
    await execFileAsync('cargo', [
        'build', '--locked', '--jobs', '2', '--manifest-path', manifest,
    ], {
        cwd: repoRoot,
        env: {
            ...process.env,
            CARGO_TARGET_DIR: targetDirectory,
            LINKRPC_PROTOCOL_SCHEMAS: schemas,
            LINKRPC_PROTOCOL_REPORT: reportPath,
        },
        timeout: coldRustBuildTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
    });
    report = JSON.parse(await readFile(reportPath, 'utf8'));
}, coldRustBuildTimeoutMs + 10_000);

afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true });
});

describe('generated CDP/LSP code across Rust and TypeScript', () => {
    it('compiles all imported Rust clients, traits, and server adapters', () => {
        expect(isRecord(report)).toBe(true);
        if (!isRecord(report) || !Array.isArray(report.interfaces)) {
            throw new Error('Missing Rust code-generation report');
        }
        expect(report.interfaces).toHaveLength(74);
        expect(report.interfaces.map((entry: unknown) => {
            if (!isRecord(entry) || typeof entry.id !== 'string' || !Array.isArray(entry.unsupported)) {
                throw new Error('Invalid Rust code-generation report entry');
            }
            return entry.id;
        }).sort()).toEqual(contracts.full.map((schema) => schema.id).sort());
        const approximations = report.interfaces.filter((entry: unknown) =>
            isRecord(entry) && Array.isArray(entry.unsupported) && entry.unsupported.length > 0);
        expect(approximations).toMatchSnapshot('documented Rust codegen fallbacks');
        if (approximations.length > 0) {
            console.info(`Rust codegen fallbacks in ${approximations.length} interfaces; `
                + `details: ${join(targetDirectory, 'generation-report.json')}`);
        }
    });

    for (const protocol of protocols) {
        it(`${protocol}: generated TypeScript client calls generated Rust server`, async () => {
            const definition = createGeneratedProtocolInterfaceDefinition(contracts.selected[protocol]);
            const peer = await startPeer('server', protocol);
            const target = bareInterfaceTarget(definition, { prefix: prefix(protocol) });
            const client = peer.connection.get(target);
            const notified = deferred<unknown>();
            const notification = protocol === 'cdp' ? 'documentUpdated' : 'publishDiagnostics';
            peer.connection.register(target, {
                [notification]: (params: unknown) => notified.resolve(params),
            });
            peer.start();
            try {
                const bindings = await within(
                    peer.connection.get(defaultsInterface).listBindings({}),
                    'Rust reflection',
                );
                expect(bindings.bindings).toContainEqual({
                    prefix: prefix(protocol),
                    interfaceId: definition.info.id,
                    interfaceHash: definition.schemaHash,
                });
                if (protocol === 'cdp') {
                    expect(await within(Promise.resolve(client.getDocument({ depth: 2 })), 'getDocument'))
                        .toEqual(cdpDocument);
                    expect(await within(notified.promise, 'documentUpdated')).toEqual({});
                    await expect(within(Promise.resolve(client.getDocument({ depth: -99 })), 'getDocument error'))
                        .rejects.toMatchObject({ code: -32000, message: 'cdp fixture error' });
                } else {
                    await client.didOpen(lspDidOpen);
                    expect(await within(notified.promise, 'publishDiagnostics')).toEqual(lspDiagnostics);
                    expect(await within(Promise.resolve(client.selectionRange({
                        textDocument: { uri: 'file:///interop.json' },
                        positions: [{ line: 1, character: 2 }],
                    })), 'selectionRange')).toEqual(lspSelectionRanges);
                    expect(await within(Promise.resolve(client.selectionRange({
                        textDocument: { uri: 'file:///interop.json' },
                        positions: [],
                    })), 'selectionRange null')).toBeNull();
                    await expect(within(Promise.resolve(client.selectionRange({
                        textDocument: { uri: 'file:///error.json' },
                        positions: [{ line: 1, character: 2 }],
                    })), 'selectionRange error'))
                        .rejects.toMatchObject({ code: -32000, message: 'lsp fixture error' });
                }
                expect(peer.frames.some(({ message }) => 'method' in message
                    && message.method.startsWith(prefix(protocol)))).toBe(true);
            } finally {
                await peer.stop();
            }
        }, 30_000);

        it(`${protocol}: generated Rust client calls generated TypeScript server`, async () => {
            const definition = createGeneratedProtocolInterfaceDefinition(contracts.selected[protocol]);
            const peer = await startPeer('client', protocol);
            const target = bareInterfaceTarget(definition, { prefix: prefix(protocol) });
            const outgoing = peer.connection.get(target);
            const called: string[] = [];
            if (protocol === 'cdp') {
                peer.connection.register(target, {
                    getDocument: async (params: unknown) => {
                        called.push('getDocument');
                        if (isRecord(params) && params.depth === -99) {
                            throw new RpcError('cdp fixture error', -32000);
                        }
                        expect(params).toEqual({ depth: 2 });
                        await outgoing.documentUpdated({});
                        return cdpDocument;
                    },
                });
            } else {
                peer.connection.register(target, {
                    didOpen: async (params: unknown) => {
                        called.push('didOpen');
                        expect(params).toEqual(lspDidOpen);
                        await outgoing.publishDiagnostics(lspDiagnostics);
                    },
                    selectionRange: async (params: unknown) => {
                        called.push('selectionRange');
                        if (isRecord(params) && isRecord(params.textDocument)
                            && params.textDocument.uri === 'file:///error.json') {
                            throw new RpcError('lsp fixture error', -32000);
                        }
                        if (isRecord(params) && Array.isArray(params.positions)
                            && params.positions.length === 0) {
                            expect(params).toEqual({
                                textDocument: { uri: 'file:///interop.json' }, positions: [],
                            });
                            return null;
                        }
                        expect(params).toEqual({
                            textDocument: { uri: 'file:///interop.json' },
                            positions: [{ line: 1, character: 2 }],
                        });
                        return lspSelectionRanges;
                    },
                });
            }
            peer.connection.enableReflection();
            peer.start();
            try {
                const [code, signal] = await within(peer.exited, `Rust ${protocol} client`);
                expect({ code, signal }, peer.stderr()).toEqual({ code: 0, signal: null });
                expect(called).toEqual(protocol === 'cdp'
                    ? ['getDocument', 'getDocument']
                    : ['didOpen', 'selectionRange', 'selectionRange', 'selectionRange']);
            } finally {
                await peer.stop();
            }
        }, 30_000);
    }
});

async function startPeer(mode: 'client' | 'server', protocol: InteropProtocol) {
    return startRustPeer(binary, [mode, protocol]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}
