import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeInterfaceHash, interfaceFromSchema, isRpcFailure, type InterfaceClient, type InterfaceHandlers } from '@hediet/linkrpc';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRustPeer, within } from './rustPeer';
import { numbers, templateInterop } from './templateInteropContract';

const exec = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const target = join(root, 'rust', 'target', 'interface-templates-interop');
const binary = join(target, 'debug', `interface-templates-peer${process.platform === 'win32' ? '.exe' : ''}`);
const schema = templateInterop.toSchema();
let scratch: string;

beforeAll(async () => {
    scratch = await mkdtemp(join(here, 'rust-interface-templates', '.input-'));
    const input = join(scratch, 'interface.json');
    await writeFile(input, JSON.stringify(schema));
    await exec('cargo', [
        'build', '--locked', '--jobs', '2', '--manifest-path',
        join(here, 'rust-interface-templates', 'Cargo.toml'),
    ], {
        cwd: root,
        env: { ...process.env, CARGO_TARGET_DIR: target, LINKRPC_TEMPLATE_SCHEMA: input },
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
    });
}, 250_000);

afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
});

function checkTypes(client: InterfaceClient<typeof templateInterop>): void {
    // @ts-expect-error specializing Value to number must not erase the input type
    void client.numbers.get('4');
    // @ts-expect-error the local nested API must not expose the mapped wire name
    void client.readNumber(4);
    // @ts-expect-error specialization also applies to the error data
    numbers.members.get.errors[0].create('missing');
    // @ts-expect-error grouped providers must return the specialized value
    const wrong: InterfaceHandlers<typeof templateInterop>['numbers']['get'] = () => '5';
    void wrong;
    const call = client.numbers.exchange(10);
    // @ts-expect-error duplex input retains the specialized type
    void call.send('5');
}
void checkTypes;

describe('TS-authored interface templates through generated Rust and real stdio', () => {
    it('typechecks grouped handlers, nested clients, and rejected usages against sources and declarations', () => {
        for (const customConditions of [[], ['@hediet/source']]) {
            const program = ts.createProgram([fileURLToPath(import.meta.url)], {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
                strict: true,
                declaration: true,
                skipLibCheck: true,
                noEmit: true,
                types: ['node'],
                customConditions,
            });
            expect(ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), {
                getCanonicalFileName: name => name,
                getCurrentDirectory: () => here,
                getNewLine: () => '\n',
            }), customConditions.length ? 'workspace sources' : 'packaged declarations').toBe('');
        }
    }, 30_000);

    it('preserves authored template metadata and the concrete hash through Rust codegen', async () => {
        const exported = JSON.parse((await exec(binary, ['export'])).stdout);
        expect(exported).toEqual(schema);
        expect(exported.hash).toBe(computeInterfaceHash(exported));
        expect(interfaceFromSchema(exported).toSchema()).toEqual(schema);
        expect(Object.keys(schema.methods).sort()).toEqual(['numbers$exchange', 'readNumber']);
        expect(schema['x-interface-templates']).toMatchObject({
            instances: [{ members: { get: 'readNumber', exchange: 'numbers$exchange' } }],
        });
        const plain = { ...schema };
        delete plain['x-interface-templates'];
        expect(computeInterfaceHash(plain)).toBe(schema.hash);
    });

    it('TS nested client calls generated Rust provider with mapped requests, errors, and duplex streams', async () => {
        const peer = await startRustPeer(binary, ['server']);
        try {
            peer.start();
            const client = peer.connection.get(templateInterop);
            expect(await within(client.numbers.get(4), 'mapped request')).toBe(5);
            const missing = await within(client.numbers.get(-1), 'Missing error');
            expect(numbers.members.get.errors[0].is(missing)).toBe(true);
            if (!isRpcFailure(missing)) throw new Error('expected Missing');
            const data: number = missing.error.data;
            expect(missing.error.type).toBe('Missing');
            expect(data).toBe(-1);

            const values: number[] = [];
            const call = client.numbers.exchange(10, { onMessage: value => values.push(value) });
            await within(call.send(5), 'duplex input');
            expect(await within(call, 'duplex final')).toBe(15);
            expect(values).toEqual([15]);
            const wireMethods = peer.frames.flatMap(({ message }) =>
                'method' in message ? [message.method] : []);
            expect(wireMethods).toContain('interop.templates::readNumber');
            expect(wireMethods).toContain('interop.templates::numbers$exchange');
        } finally {
            await peer.stop();
        }
    }, 30_000);

    it('generated Rust client calls TS grouped handlers with mapped requests, errors, and duplex streams', async () => {
        const peer = await startRustPeer(binary, ['client']);
        const requests: number[] = [];
        const streamInputs: number[] = [];
        try {
            peer.connection.register(templateInterop, {
                numbers: {
                    get: value => {
                        requests.push(value);
                        return value < 0 ? numbers.members.get.errors[0].create(value) : value + 1;
                    },
                    exchange: async (initial, _context, stream) => {
                        const input = await new Promise<number>(resolve => {
                            stream.onMessage(value => resolve(value));
                        });
                        streamInputs.push(input);
                        await stream.send(initial + input);
                        return initial + input;
                    },
                },
            });
            peer.start();
            const [code, signal] = await within(peer.exited, 'generated Rust client');
            expect({ code, signal }, peer.stderr()).toEqual({ code: 0, signal: null });
            expect(requests).toEqual([4, -1]);
            expect(streamInputs).toEqual([5]);
        } finally {
            await peer.stop();
        }
    }, 30_000);
});
