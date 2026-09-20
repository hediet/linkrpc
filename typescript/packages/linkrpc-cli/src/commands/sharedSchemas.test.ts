import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
    InterfaceDefinition,
    JsonRpcChannel,
    LinkRpcConnection,
    type LinkRpcInterfaceSchema,
    type MemberMap,
} from '@hediet/linkrpc';
import {
    adaptJsonRpcTransport,
    createNdjsonJsonRpcTransport,
} from '@hediet/linkrpc-infra/json-rpc';
import * as linkRpc from '@hediet/linkrpc';
import * as zod from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { main } from '../cli';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const fixtureRoot = join(repoRoot, 'interop', 'shared-schemas');
const manifest = join(fixtureRoot, 'Cargo.toml');
const targetDirectory = join(fixtureRoot, 'target');
const binary = join(
    targetDirectory,
    'debug',
    process.platform === 'win32' ? 'shared-schemas-peer.exe' : 'shared-schemas-peer',
);
const commandDirectory = fileURLToPath(new URL('.', import.meta.url));
const testDirectory = join(
    commandDirectory,
    `.shared-schemas-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
);
const generatedPath = join(testDirectory, 'generated.ts');
const defaultGeneratedPath = join(testDirectory, 'generated-default.ts');
const usagePath = join(testDirectory, 'usage.ts');
const bundlePath = join(testDirectory, 'interfaces.json');

let schema: LinkRpcInterfaceSchema;
let definition: InterfaceDefinition<MemberMap>;
let defaultDefinition: InterfaceDefinition<MemberMap>;
let typedRuntime: TypedRuntime;
let measurement: Measurement;

beforeAll(async () => {
    await mkdir(testDirectory, { recursive: true });
    await execFileAsync('cargo', [
        'build',
        '--locked',
        '--jobs',
        '2',
        '--manifest-path',
        manifest,
        '--package',
        'shared-schemas-peer',
    ], {
        cwd: fixtureRoot,
        env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
    });

    const exported = await runFixture('export');
    schema = JSON.parse(exported) as LinkRpcInterfaceSchema;
    measurement = JSON.parse(await runFixture('measure')) as Measurement;
    await writeFile(bundlePath, JSON.stringify({
        interfaceSchemas: [schema],
        services: [],
    }));
    await main([
        'codegen',
        '--input',
        bundlePath,
        '--interface',
        schema.id,
        '--name',
        'sharedSchemasInterface',
        '--output',
        generatedPath,
        '--preserve-wire-schema',
    ]);
    await main([
        'codegen',
        '--input',
        bundlePath,
        '--interface',
        schema.id,
        '--name',
        'defaultSharedSchemasInterface',
        '--output',
        defaultGeneratedPath,
    ]);

    const generatedSource = await readFile(generatedPath, 'utf8');
    const defaultGeneratedSource = await readFile(defaultGeneratedPath, 'utf8');
    const usageSource = typedUsageSource(sampleSnapshot);
    await writeFile(usagePath, usageSource);
    expectTypeChecks([generatedPath, defaultGeneratedPath, usagePath]);
    definition = evaluateGenerated(generatedSource, 'sharedSchemasInterface');
    defaultDefinition = evaluateGenerated(
        defaultGeneratedSource,
        'defaultSharedSchemasInterface',
    );
    typedRuntime = evaluateTypedUsage(usageSource, definition);
}, 250_000);

afterAll(async () => {
    await rm(testDirectory, { recursive: true, force: true });
});

describe('shared Rust trait schemas through both code generators', () => {
    it('exports one closed shared graph and cuts the former inline bytes by more than half', () => {
        expect(schema.id).toBe('interop.shared-schemas');
        expect(Object.keys(schema.methods)).toHaveLength(8);
        const components = schema.components?.schemas ?? {};
        expect(Object.keys(components).length).toBeGreaterThanOrEqual(5);
        expect(schema.methods.echo!.params).toEqual(schema.methods.echo!.result);
        expect(schema.methods.restore!.params).toEqual(schema.methods.echo!.params);
        expect(schema.methods.changed!.params).toEqual(schema.methods.echo!.params);

        const snapshot = dereference(schema.methods.echo!.params, components);
        const properties = snapshot.properties as Record<string, unknown>;
        const metadata = dereference(properties.metadata, components);
        expect(metadata.properties).toMatchObject({
            title: { type: 'string' },
            format: { type: 'string' },
            definitions: { type: 'object' },
        });
        expect(properties.previousMetadata).toBeDefined();
        expect(properties.metadataHistory).toBeDefined();
        expect(properties.metadataByName).toBeDefined();
        expect(properties.state).toBeDefined();
        expectNoDanglingComponentRefs(schema);

        expect(measurement).toMatchObject({
            methodCount: 8,
            inlineBytes: 58_829,
            inlineObjectSchemaCount: 325,
            sharedObjectSchemaCount: 10,
        });
        expect(measurement.componentCount).toBeGreaterThanOrEqual(5);
        expect(measurement.sharedBytes).toBeLessThan(measurement.inlineBytes / 2);
        expect(measurement.reductionPercent).toBeGreaterThan(50);
    });

    it('uses the actual CLI output as an executable, strongly typed frozen interface', () => {
        expect(definition).toBeInstanceOf(InterfaceDefinition);
        expect(definition.schemaHash).toBe(schema.hash);
        expect(definition.toSchema()).toEqual(schema);
    });

    it('surfaces why Rust canonical JSON requires --preserve-wire-schema', () => {
        expect(defaultDefinition).toBeInstanceOf(InterfaceDefinition);
        expect(defaultDefinition.schemaHash).not.toBe(schema.hash);
        expect(defaultDefinition.toSchema()).not.toEqual(schema);
    });

    for (const mode of ['original-server', 'generated-server'] as const) {
        it(`generated TypeScript client calls ${mode}`, async () => {
            const peer = await startPeer(mode);
            peer.start();
            try {
                await within(typedRuntime.runClient(peer.connection), `${mode} typed client`);
            } finally {
                await peer.stop();
            }
        }, 30_000);
    }

    for (const mode of ['original-client', 'generated-client'] as const) {
        it(`${mode} calls generated TypeScript server`, async () => {
            const peer = await startPeer(mode);
            const called: string[] = [];
            typedRuntime.registerServer(peer.connection, called);
            peer.start();
            try {
                const [code, signal] = await within(peer.exited, mode);
                expect({ code, signal }, peer.stderr()).toEqual({
                    code: 0,
                    signal: null,
                });
                expect(called).toEqual([
                    'echo',
                    'restore',
                    'archive',
                    'history',
                    'optional',
                    'dictionary',
                    'inspect',
                ]);
            } finally {
                await peer.stop();
            }
        }, 30_000);
    }
});

async function runFixture(command: 'export' | 'measure'): Promise<string> {
    const result = await execFileAsync(binary, [command], {
        cwd: fixtureRoot,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
}

function evaluateGenerated(
    source: string,
    exportName: string,
): InterfaceDefinition<MemberMap> {
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
        },
        reportDiagnostics: true,
    });
    const errors = transpiled.diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ) ?? [];
    expect(errors.map(formatDiagnostic)).toEqual([]);
    const generatedModule: { exports: Record<string, unknown> } = { exports: {} };
    const requireGeneratedDependency = (specifier: string): unknown => {
        if (specifier === '@hediet/linkrpc') return linkRpc;
        if (specifier === 'zod') return zod;
        throw new Error(`Unexpected generated dependency: ${specifier}`);
    };
    new Function('require', 'module', 'exports', transpiled.outputText)(
        requireGeneratedDependency,
        generatedModule,
        generatedModule.exports,
    );
    const result = generatedModule.exports[exportName];
    if (!(result instanceof InterfaceDefinition)) {
        throw new Error('CLI output did not export an InterfaceDefinition');
    }
    return result;
}

function evaluateTypedUsage(
    source: string,
    generatedDefinition: InterfaceDefinition<MemberMap>,
): TypedRuntime {
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
        },
        reportDiagnostics: true,
    });
    const errors = transpiled.diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ) ?? [];
    expect(errors.map(formatDiagnostic)).toEqual([]);
    const usageModule: { exports: Record<string, unknown> } = { exports: {} };
    const requireUsageDependency = (specifier: string): unknown => {
        if (specifier === '@hediet/linkrpc') return linkRpc;
        if (specifier === './generated') {
            return { sharedSchemasInterface: generatedDefinition };
        }
        throw new Error(`Unexpected typed usage dependency: ${specifier}`);
    };
    new Function('require', 'module', 'exports', transpiled.outputText)(
        requireUsageDependency,
        usageModule,
        usageModule.exports,
    );
    const runClient = usageModule.exports.runClient;
    const registerServer = usageModule.exports.registerServer;
    if (typeof runClient !== 'function' || typeof registerServer !== 'function') {
        throw new Error('Typed usage module did not export its runtime wrappers');
    }
    return {
        async runClient(connection: unknown): Promise<void> {
            await runClient(connection);
        },
        registerServer(connection: unknown, called: string[]): void {
            registerServer(connection, called);
        },
    };
}

function expectTypeChecks(rootNames: string[]): void {
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
    };
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(rootNames, options));
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1}: ${message}`;
}

function dereference(
    value: unknown,
    components: Record<string, unknown>,
): Record<string, unknown> {
    if (!isRecord(value)) throw new Error('Expected a schema object');
    if (typeof value.$ref !== 'string') return value;
    const prefix = '#/components/schemas/';
    if (!value.$ref.startsWith(prefix)) throw new Error(`Unexpected ref ${value.$ref}`);
    const encoded = value.$ref.slice(prefix.length);
    const name = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    const target = components[name];
    if (!isRecord(target)) throw new Error(`Dangling ref ${value.$ref}`);
    return target;
}

function expectNoDanglingComponentRefs(schemaValue: unknown): void {
    const root = schemaValue as LinkRpcInterfaceSchema;
    const components = root.components?.schemas ?? {};
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(visit);
        } else if (isRecord(value)) {
            if (typeof value.$ref === 'string') dereference(value, components);
            Object.values(value).forEach(visit);
        }
    };
    visit(schemaValue);
}

async function startPeer(mode: PeerMode) {
    const child: ChildProcessWithoutNullStreams = spawn(binary, [mode], {
        cwd: fixtureRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-65_536);
    });
    await once(child, 'spawn');
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    const input = new PassThrough();
    const transport = adaptJsonRpcTransport(createNdjsonJsonRpcTransport({
        input,
        output: child.stdin,
    }));
    const lifecycle = JsonRpcChannel.createWithClose(transport);
    transport.onClose(() => lifecycle.close());
    const connection = new LinkRpcConnection(lifecycle.channel);
    return {
        connection,
        exited,
        stderr: () => stderr,
        start(): void {
            child.stdout.pipe(input);
        },
        async stop(): Promise<void> {
            connection.close();
            transport.dispose();
            child.stdout.unpipe(input);
            input.destroy();
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.stdin.end();
            const kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
            try {
                await exited;
            } finally {
                clearTimeout(kill);
            }
        },
    };
}

async function within<T>(promise: Promise<T>, operation: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${operation} timed out`)), 10_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface Measurement {
    readonly methodCount: number;
    readonly componentCount: number;
    readonly inlineObjectSchemaCount: number;
    readonly sharedObjectSchemaCount: number;
    readonly inlineBytes: number;
    readonly sharedBytes: number;
    readonly savedBytes: number;
    readonly reductionPercent: number;
}

interface TypedRuntime {
    runClient(connection: unknown): Promise<void>;
    registerServer(connection: unknown, called: string[]): void;
}

type PeerMode =
    | 'original-server'
    | 'original-client'
    | 'generated-server'
    | 'generated-client';

const sampleSnapshot = {
    snapshotId: 'snapshot-42',
    metadata: {
        title: 'Paused daemon',
        format: 'linkrpc.snapshot',
        definitions: {
            scope: 'worker',
            runtime: 'node',
        },
    },
    previousMetadata: {
        title: 'Paused daemon',
        format: 'linkrpc.snapshot',
        definitions: {
            scope: 'worker',
            runtime: 'node',
        },
    },
    metadataHistory: [{
        title: 'Paused daemon',
        format: 'linkrpc.snapshot',
        definitions: {
            scope: 'worker',
            runtime: 'node',
        },
    }, {
        title: 'Paused daemon',
        format: 'linkrpc.snapshot',
        definitions: {
            scope: 'worker',
            runtime: 'node',
        },
    }],
    metadataByName: {
        primary: {
            title: 'Paused daemon',
            format: 'linkrpc.snapshot',
            definitions: {
                scope: 'worker',
                runtime: 'node',
            },
        },
    },
    frames: [{
        functionName: 'handleRequest',
        location: {
            scriptId: 'daemon.ts',
            lineNumber: 41,
            columnNumber: 7,
        },
        inlinedLocations: [{
            scriptId: 'daemon.ts',
            lineNumber: 41,
            columnNumber: 7,
        }],
    }, {
        functionName: 'handleRequest',
        location: {
            scriptId: 'daemon.ts',
            lineNumber: 41,
            columnNumber: 7,
        },
        inlinedLocations: [{
            scriptId: 'daemon.ts',
            lineNumber: 41,
            columnNumber: 7,
        }],
    }],
    selectedFrame: {
        functionName: 'handleRequest',
        location: {
            scriptId: 'daemon.ts',
            lineNumber: 41,
            columnNumber: 7,
        },
        inlinedLocations: [{
            scriptId: 'daemon.ts',
            lineNumber: 41,
            columnNumber: 7,
        }],
    },
    framesByScript: {
        'daemon.ts': {
            functionName: 'handleRequest',
            location: {
                scriptId: 'daemon.ts',
                lineNumber: 41,
                columnNumber: 7,
            },
            inlinedLocations: [{
                scriptId: 'daemon.ts',
                lineNumber: 41,
                columnNumber: 7,
            }],
        },
    },
    state: {
        kind: 'failed',
        message: 'paused on exception',
        location: {
            scriptId: 'daemon.ts',
            lineNumber: 41,
            columnNumber: 7,
        },
    },
    tags: ['daemon', 'paused'],
};

function typedUsageSource(sample: unknown): string {
    return `
import {
    type InterfaceClient,
    type InterfaceHandlers,
    LinkRpcConnection,
} from '@hediet/linkrpc';
import { sharedSchemasInterface } from './generated';

type Client = InterfaceClient<typeof sharedSchemasInterface>;
type Snapshot = Parameters<Client['echo']>[0];
const sampleSnapshot: Snapshot = ${JSON.stringify(sample)};

function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, stable(child)]),
        );
    }
    return value;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(expected))) {
        throw new Error(label + ' returned an unexpected value');
    }
}

export async function runClient(connection: LinkRpcConnection): Promise<void> {
    const client: Client = connection.get(sharedSchemasInterface);
    const echoed = await client.echo(sampleSnapshot);
    echoed.metadata.title satisfies string;
    echoed.metadata.format satisfies string;
    echoed.metadata.definitions.runtime satisfies string | undefined;
    echoed.frames[0]!.location.lineNumber satisfies number;
    assertEqual(echoed, sampleSnapshot, 'echo');
    assertEqual(await client.restore(sampleSnapshot), sampleSnapshot, 'restore');
    assertEqual(await client.archive(sampleSnapshot), sampleSnapshot, 'archive');
    const history = await client.history(sampleSnapshot);
    history[0]!.state.kind satisfies 'ready' | 'failed';
    assertEqual(history, [sampleSnapshot, sampleSnapshot], 'history');
    const optional = await client.optional(sampleSnapshot);
    optional?.snapshotId satisfies string | undefined;
    assertEqual(optional, sampleSnapshot, 'optional');
    const dictionary = await client.dictionary(sampleSnapshot);
    dictionary.current?.snapshotId satisfies string | undefined;
    assertEqual(dictionary, { current: sampleSnapshot }, 'dictionary');
    assertEqual(await client.inspect(sampleSnapshot), sampleSnapshot.metadata, 'inspect');
    client.changed(sampleSnapshot);
}

export function registerServer(
    connection: LinkRpcConnection,
    called: string[],
): void {
    const handlers: InterfaceHandlers<typeof sharedSchemasInterface> = {
        echo: async (value) => {
            called.push('echo');
            return value;
        },
        restore: async (value) => {
            called.push('restore');
            return value;
        },
        archive: async (value) => {
            called.push('archive');
            return value;
        },
        inspect: async (value) => {
            called.push('inspect');
            return value.metadata;
        },
        history: async (value) => {
            called.push('history');
            return [value, value];
        },
        optional: async (value) => {
            called.push('optional');
            return value;
        },
        dictionary: async (value) => {
            called.push('dictionary');
            return { current: value };
        },
        changed: async (_value) => {
            called.push('changed');
        },
    };
    handlers satisfies InterfaceHandlers<typeof sharedSchemasInterface>;
    connection.register(sharedSchemasInterface, handlers);
}

function negativeTypeCheck(client: Client, snapshot: Snapshot): void {
    // @ts-expect-error lineNumber is numeric in the generated contract.
    client.echo({ ...snapshot, frames: [{ ...snapshot.frames[0]!, location: { ...snapshot.frames[0]!.location, lineNumber: 'forty-one' } }] });
}
void negativeTypeCheck;
`;
}
