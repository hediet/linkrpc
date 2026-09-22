import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeInterfaceHash, type LinkRpcInterfaceSchema } from '@hediet/linkrpc';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tsErrors } from './typedErrorsContract';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));
const manifest = join(here, 'rust-typed-errors', 'Cargo.toml');
const target = join(repoRoot, 'rust', 'target', 'typed-errors-interop');
const cliRoot = join(repoRoot, 'typescript', 'packages', 'linkrpc-cli');
const tsx = createRequire(join(cliRoot, 'package.json')).resolve('tsx/cli');
const env = {
    ...process.env,
    CARGO_TARGET_DIR: target,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=@hediet/source`,
};
const binary = (name: string) => join(target, 'debug', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
let scratch: string;
let generatedInput: string;
const cases: { author: string; binary: string; directory: string; schema: LinkRpcInterfaceSchema }[] = [];

beforeAll(async () => {
    scratch = await mkdtemp(join(here, '.typed-errors-'));
    await exec('cargo', ['build', '--locked', '--jobs', '2', '--manifest-path', manifest, '--bin', 'authored-errors'], {
        cwd: repoRoot, env, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
    });
    const exported = await exec(binary('authored-errors'), ['export'], { env });
    const rustSchema: LinkRpcInterfaceSchema = JSON.parse(exported.stdout);
    const tsSchema = tsErrors.toSchema();
    generatedInput = join(scratch, 'ts-interface.json');
    await writeFile(generatedInput, JSON.stringify(tsSchema));
    await exec('cargo', [
        'build', '--locked', '--jobs', '2', '--manifest-path', manifest,
        '--features', 'generated', '--bin', 'generated-errors',
    ], {
        cwd: repoRoot, env: { ...env, LINKRPC_TYPED_ERROR_SCHEMA: generatedInput },
        timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
    });
    for (const [author, schema, executable] of [
        ['Rust', rustSchema, 'authored-errors'],
        ['TypeScript', tsSchema, 'generated-errors'],
    ] as const) {
        expect(schema.hash).toBe(computeInterfaceHash(schema));
        for (const code of [-32001, -32002, -32003]) {
            const raw = schema.methods.check.errors?.find((error) => error.code === code);
            expect(raw).toMatchObject({ code, schema: expect.anything() });
            expect(Object.keys(raw!).sort()).toEqual(['code', 'schema']);
        }
        const directory = join(scratch, author.toLowerCase());
        await mkdir(directory);
        const bundle = join(directory, 'bundle.json');
        await writeFile(bundle, JSON.stringify({ services: [], interfaceSchemas: [schema] }));
        const args = [
            join(cliRoot, 'src', 'linkrpc.ts'), 'codegen',
            '--input', bundle, '--interface', schema.id,
            '--name', 'contract', '--output', join(directory, 'contract.ts'),
            '--preserve-wire-schema',
        ];
        await exec(process.execPath, [tsx, ...args], { env, timeout: 30_000 });
        await exec(process.execPath, [tsx, ...args, '--check'], { env, timeout: 30_000 });
        const source = await readFile(join(here, 'typedErrorsPeer.ts.template'), 'utf8');
        const base = author === 'Rust' ? 1000 : 2000;
        await writeFile(join(directory, 'peer.ts'), source
            .replaceAll('__MISSING__', '1')
            .replaceAll('__BUSY__', '1')
            .replaceAll('__NULLABLE__', String(base + 3))
            .replaceAll('__RECURSIVE__', String(base + 4))
            .replaceAll('__NUMERIC__', String(base + 5)));
        cases.push({ author, binary: binary(executable), directory, schema });
    }
}, 540_000);

afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true });
});

describe('typed application errors through authored interface JSON', () => {
    for (const author of ['Rust', 'TypeScript']) {
        it(`${author}: type-checks actual CLI output and negative client/server usages`, () => {
            const fixture = cases.find((entry) => entry.author === author)!;
            for (const customConditions of [[], ['@hediet/source']]) {
                const program = ts.createProgram([join(fixture.directory, 'peer.ts')], {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.ESNext,
                    moduleResolution: ts.ModuleResolutionKind.Bundler,
                    customConditions,
                    strict: true,
                    skipLibCheck: true,
                    noEmit: true,
                    types: ['node'],
                });
                const diagnostics = ts.getPreEmitDiagnostics(program);
                expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
                    getCanonicalFileName: (name) => name,
                    getCurrentDirectory: () => here,
                    getNewLine: () => '\n',
                }), customConditions.length === 0 ? 'packaged declarations' : 'workspace sources').toBe('');
            }
        }, 30_000);

        for (const mode of ['client', 'server']) {
            it(`${author}: TypeScript ${mode} exchanges typed errors with Rust`, async () => {
                const fixture = cases.find((entry) => entry.author === author)!;
                const result = await exec(process.execPath, [
                    tsx, join(fixture.directory, 'peer.ts'), mode, fixture.binary, fixture.schema.hash,
                ], { env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
                expect(result.stdout).toContain('typed errors verified');
            }, 100_000);
        }
    }

    it('rejects incorrect generated Rust error payloads at compile time', async () => {
        let failure: string | undefined;
        try {
            await exec('cargo', [
                'rustc', '--locked', '--jobs', '2', '--manifest-path', manifest,
                '--features', 'generated', '--bin', 'generated-errors',
                '--', '--cfg', 'typed_error_negative_test',
            ], {
                cwd: repoRoot, env: { ...env, LINKRPC_TYPED_ERROR_SCHEMA: generatedInput },
                timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
            });
        } catch (error) {
            if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') {
                throw error;
            }
            failure = error.stderr;
        }
        expect(failure, 'wrong generated error payload must not compile').toBeDefined();
        expect(failure).toContain('mismatched types');
        expect(failure).toContain('expected');
    }, 130_000);
});
