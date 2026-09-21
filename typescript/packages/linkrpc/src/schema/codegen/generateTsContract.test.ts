import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import * as rpc from '../../index';
import { generateTsContract } from './generateTsContract';

const echo = rpc.defineInterface({ id: 'test.echo' }, {
    echo: rpc.requestType(z.object({ text: z.string() }), z.string()),
    changed: rpc.notificationType(z.object({ text: z.string() })),
});
const ref = { interfaceId: echo.info.id, interfaceHash: echo.schemaHash };
const contract: rpc.StaticHubSchemaDocument = {
    interfaceSchemas: [echo.toSchema()],
    services: [{ serviceId: '', interfaces: [ref] }, { serviceId: 'worker', interfaces: [ref] }],
    defaultInterface: ref,
    bareInterfaces: [{ interface: ref, prefix: '' }, { interface: ref, prefix: 'Runtime.' }],
};

describe('static contracts', () => {
    it('allows schema-only and bare-only contracts and resolves exact hashes', () => {
        expect(rpc.parseStaticHubSchema({ interfaceSchemas: [echo.toSchema()] }).services).toBeUndefined();
        expect(rpc.parseStaticHubSchema({
            interfaceSchemas: [echo.toSchema()], bareInterfaces: contract.bareInterfaces,
        }).bareInterfaces).toEqual(contract.bareInterfaces);
        expect(() => rpc.parseStaticHubSchema({
            ...contract, defaultInterface: { ...ref, interfaceHash: 'wrong' },
        })).toThrow(/does not resolve/);
        expect(() => rpc.parseStaticHubSchema({
            ...contract, interfaceSchemas: [{ ...echo.toSchema(), hash: 'wrong' }],
        })).toThrow(/hash mismatch/);
    });

    it('rejects duplicate and conflicting routes but allows overlapping bare prefixes', () => {
        expect(() => rpc.parseStaticHubSchema({
            ...contract, bareInterfaces: [contract.bareInterfaces![0], contract.bareInterfaces![0]],
        })).toThrow(/Duplicate bare prefix/);
        const other = rpc.defineInterface({ id: 'other' }, echo.members);
        expect(() => rpc.parseStaticHubSchema({
            ...contract, interfaceSchemas: [echo.toSchema(), other.toSchema()],
            bareInterfaces: [{ interface: { interfaceId: other.info.id, interfaceHash: other.schemaHash }, prefix: '' }],
        })).toThrow(/conflicts/);
        expect(() => rpc.parseStaticHubSchema({
            ...contract, bareInterfaces: ['text/', 'text/document/'].map((prefix) => ({ interface: ref, prefix })),
        })).not.toThrow();
        expect(() => rpc.parseStaticHubSchema({
            ...contract, services: [{ serviceId: '', interfaces: [ref, ref] }],
        })).toThrow(/Duplicate interface/);
    });

    it('generates deterministic shared definitions and explicit collision overrides', () => {
        const other = rpc.defineInterface({ id: 'test-echo' }, echo.members);
        const document = { interfaceSchemas: [echo.toSchema(), other.toSchema()] };
        expect(() => generateTsContract(document)).toThrow(/collides.*overrides/);
        const options = { interfaceNames: { [`${other.info.id}@${other.schemaHash}`]: 'otherInterface' } };
        expect(generateTsContract(document, options)).toBe(generateTsContract({
            interfaceSchemas: [...document.interfaceSchemas].reverse(),
        }, options));
        expect(() => generateTsContract(contract, { bindingNames: { 'bare:typo': 'oops' } }))
            .toThrow(/Unknown naming override/);
        expect(() => generateTsContract(contract, { bindingNames: { default: 'class' } }))
            .toThrow(/Invalid TypeScript/);
    });

    it('compiles generated bindings, preserves hashes, and roundtrips calls and notifications', async () => {
        const source = generateTsContract(contract, { linkRpcImport: '../../index' });
        expect(source.match(/new InterfaceDefinition\(/g)).toHaveLength(1);
        typecheck(`${source}
import { LinkRpcConnection, type InterfaceClient } from '../../index';
declare const connection: LinkRpcConnection;
const client: InterfaceClient<typeof testEchoInterface> = connection.get(runtimeBare);
const response: Promise<string> = client.echo({ text: 'typed' });
connection.register(testEchoDefault, { echo: ({ text }) => text, changed: ({ text }) => {} });
// @ts-expect-error typed parameters survive the descriptor
client.echo({ wrong: true });
`);
        const js = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText.replace(/^import [^\n]*\n/gm, '').replace(/^export /gm, '');
        const exports = ['testEchoInterface', 'testEchoRoot', 'workerTestEchoService', 'testEchoDefault', 'testEchoBare', 'runtimeBare'];
        const generated = new Function(...Object.keys(rpc), 'z', `${js}\nreturn { ${exports.join(', ')} };`)(...Object.values(rpc), z);
        expect(generated.testEchoInterface.schemaHash).toBe(echo.schemaHash);
        for (const name of exports.slice(1)) {
            const pair = new rpc.TransportPair();
            const server = rpc.LinkRpcConnection.fromTransport(pair.a);
            const client = rpc.LinkRpcConnection.fromTransport(pair.b);
            const seen: string[] = [];
            const target = generated[name];
            expect(Object.isFrozen(target)).toBe(true);
            const registration = server.register(target, {
                echo: ({ text }: { text: string }) => text,
                changed: ({ text }: { text: string }) => { seen.push(text); },
            });
            try {
                const remote = client.get(target) as rpc.InterfaceClient<typeof echo>;
                expect(await remote.echo({ text: name })).toBe(name);
                await remote.changed({ text: name });
                expect(seen).toEqual([name]);
                registration.dispose();
                await expect(remote.echo({ text: name })).rejects.toThrow();
            } finally { server.close(); client.close(); }
        }
    }, 30_000);

    it('retains LinkRPC metadata for default targets but not bare targets', async () => {
        const sent: { method: string; opts: unknown }[] = [];
        const connection = new rpc.LinkRpcConnection({
            sendRequest: async (method, _params, opts) => { sent.push({ method, opts }); return 'ok'; },
            sendNotification: async (method, _params, opts) => { sent.push({ method, opts }); },
            sendRequestWithStream: () => { throw new Error('not used'); },
            close: () => {},
        });
        for (const target of [
            rpc.defaultInterfaceTarget(echo), rpc.bareInterfaceTarget(echo),
            rpc.interfaceTarget(echo), rpc.interfaceTarget(echo, { serviceId: 'worker' }),
            rpc.bareInterfaceTarget(echo, { prefix: 'Runtime.' }),
        ]) {
            await connection.get(target).echo({ text: 'test' });
            await connection.get(target).changed({ text: 'test' });
        }
        expect(sent.map((item) => item.method)).toEqual([
            'echo', 'changed', 'echo', 'changed',
            'test.echo::echo', 'test.echo::changed',
            'worker::test.echo::echo', 'worker::test.echo::changed',
            'Runtime.echo', 'Runtime.changed',
        ]);
        expect(sent[0]!.opts).toMatchObject({ interfaceHash: echo.schemaHash });
        expect(sent[1]!.opts).toMatchObject({ interfaceHash: echo.schemaHash });
        expect(sent[2]!.opts).toBeUndefined();
        expect(sent[3]!.opts).toBeUndefined();
        for (const item of sent.slice(4, 8)) expect(item.opts).toMatchObject({ interfaceHash: echo.schemaHash });
        for (const item of sent.slice(8)) expect(item.opts).toBeUndefined();
    });

    it('supports streaming through default targets without weakening bare mode', async () => {
        const stream = rpc.defineInterface({ id: 'test.stream' }, {
            read: rpc.requestType(z.object({}), z.string()).withStream({ server: z.string() }),
        });
        const pair = new rpc.TransportPair();
        const server = rpc.LinkRpcConnection.fromTransport(pair.a);
        const client = rpc.LinkRpcConnection.fromTransport(pair.b);
        const target = rpc.defaultInterfaceTarget(stream);
        server.register(target, {
            read: async (_params, _context, stream) => {
                await stream.send('progress');
                return 'done';
            },
        });
        try {
            const seen: string[] = [];
            expect(await client.get(target).read({}, { onMessage: (value) => seen.push(value) })).toBe('done');
            expect(seen).toEqual(['progress']);
            expect(() => client.get(rpc.bareInterfaceTarget(stream))).toThrow(/streaming/);
        } finally { server.close(); client.close(); }
    });
});

function typecheck(source: string): void {
    const file = fileURLToPath(new URL('./generated-contract-type-test.ts', import.meta.url)).replace(/\\/g, '/');
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, noEmit: true,
    };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (candidate, version, ...rest) => candidate === file
        ? ts.createSourceFile(file, source, version, true, ts.ScriptKind.TS)
        : original(candidate, version, ...rest);
    const errors = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
    expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))).toEqual([]);
}
