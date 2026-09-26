import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { runGraphBoundaryFixture, runGraphClientBoundaryFixture } from './graphBoundary.fixture';

const exec = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));

function readDeclarations(url: URL, seen = new Set<string>()): string {
    if (seen.has(url.href)) return '';
    seen.add(url.href);
    const text = readFileSync(url, 'utf8');
    return text + ts.preProcessFile(text).importedFiles
        .filter(file => file.fileName.startsWith('.'))
        .map(file => readDeclarations(new URL(file.fileName.replace(/\.js$/, '.d.ts'), url), seen))
        .join('\n');
}

function checkFixture(result: Awaited<ReturnType<typeof runGraphBoundaryFixture>>) {
    expect(result.first.objects.map(row => row.ref.id)).toEqual(['one']);
    expect(result.first.complete).toBe(false);
    expect(result.second.objects.map(row => row.ref.id)).toEqual(['two']);
    expect(result.second.complete).toBe(true);
    expect(result.offers.map(offer => offer.ref.id)).toEqual(['one', 'two']);
    expect(result.retainedBeforeAck).toBe(true);
    expect(result.retainedAfterAck).toBe(true);
    expect(result.released).toBe(true);
    expect(result.cancellation).toBe('resolved');
    expect(result.members).toEqual(['fetchObjects', 'root$watch']);
}

describe('public graph package boundary', () => {
    it('runs grouped requests, duplex watches and cancellation through the workspace entry', async () => {
        checkFixture(await runGraphBoundaryFixture());
    });

    it('runs the same fixture through published JavaScript exports without source aliases', async () => {
        const fixture = new URL('./graphBoundary.fixture.ts', import.meta.url).href;
        const { stdout } = await exec(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
            `const {runGraphBoundaryFixture} = await import(${JSON.stringify(fixture)}); console.log(JSON.stringify(await runGraphBoundaryFixture()));`,
        ], { cwd: here, env: { ...process.env, NODE_OPTIONS: '' } });
        checkFixture(JSON.parse(stdout));
    });

    it('runs demand-driven clients against canonical source and published graph registrations', async () => {
        expect(await runGraphClientBoundaryFixture()).toEqual({ beforeAcquire: 0, fetched: ['root', 'child'] });
        const fixture = new URL('./graphBoundary.fixture.ts', import.meta.url).href;
        const { stdout } = await exec(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
            `const {runGraphClientBoundaryFixture} = await import(${JSON.stringify(fixture)}); console.log(JSON.stringify(await runGraphClientBoundaryFixture()));`,
        ], { cwd: here, env: { ...process.env, NODE_OPTIONS: '' } });
        expect(JSON.parse(stdout)).toEqual({ beforeAcquire: 0, fetched: ['root', 'child'] });
    });

    it('typechecks generic nested clients against both source and published declarations', () => {
        for (const customConditions of [['@hediet/source'], []]) {
            const program = ts.createProgram([fileURLToPath(new URL('./graphBoundary.fixture.ts', import.meta.url))], {
                target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
                strict: true, noEmit: true, skipLibCheck: true, types: ['node'], customConditions,
            });
            const diagnostics = ts.getPreEmitDiagnostics(program);
            expect(ts.formatDiagnostics(diagnostics, {
                getCanonicalFileName: name => name, getCurrentDirectory: () => here, getNewLine: () => '\n',
            }), customConditions.length ? 'source exports' : 'published declarations').toBe('');
        }
    }, 30_000);

    it('publishes graph only from infra and emits public generic declaration imports', () => {
        const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        expect(manifest.exports['./graph']['@hediet/source']).toBe('./src/graph/index.ts');
        expect(manifest.publishConfig.exports['./graph']).toBe('./dist/graph/index.js');
        const declarations = readDeclarations(new URL('../dist/graph/index.d.ts', import.meta.url));
        expect(declarations).toContain('GraphObjects: <R, V>');
        expect(declarations).toContain('GraphRoot: <P, R>');
        expect(declarations).not.toMatch(/\.\.\/.*(?:schema|connection)|@hediet\/linkrpc\/graph/);
        const browserEntry = readFileSync(new URL('../dist/graph/index.js', import.meta.url), 'utf8');
        expect(browserEntry).not.toMatch(/from ["'](?:node:|.*\/source(?:\.js)?["'])/);
        const core = JSON.parse(readFileSync(new URL('../../linkrpc/package.json', import.meta.url), 'utf8'));
        expect(core.exports['./graph']).toBeUndefined();
        expect(core.dependencies?.['@hediet/linkrpc-infra']).toBeUndefined();
    });
});
