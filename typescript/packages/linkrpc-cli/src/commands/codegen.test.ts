import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineInterface, requestType } from '@hediet/linkrpc';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli';

const testDir = resolve(
    `.codegen-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
);

afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
});

describe('linkrpc codegen', () => {
    it('exports a real stdio endpoint then generates and checks a whole offline contract', async () => {
        const bundlePath = resolve(testDir, 'exported.json');
        const outputPath = resolve(testDir, 'contract.ts');
        const server = fileURLToPath(new URL('../../examples/demo-server.ts', import.meta.url));
        await main([
            '--context', ':empty',
            '--endpoint-cmd-stdio', `${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(server)}`,
            'contract', 'export', '--output', bundlePath,
        ]);
        const document = JSON.parse(await readFile(bundlePath, 'utf8'));
        expect(document).not.toHaveProperty('directories');
        expect(document.defaultInterface.interfaceId).toBe('demo.echo');
        expect(document.bareInterfaces).toContainEqual({ prefix: '', interface: document.defaultInterface });
        const args = ['codegen', '--input', bundlePath, '--output', outputPath];
        await main(args);
        const generated = await readFile(outputPath, 'utf8');
        expect(generated).toContain('export const demoEchoInterface: typeof');
        expect(generated).toContain('demoEchoDefault: DefaultInterfaceTarget<typeof demoEchoInterface> = defaultInterfaceTarget(demoEchoInterface);');
        expect(generated).toContain('demoEchoBare: BareInterfaceTarget<typeof demoEchoInterface> = bareInterfaceTarget(demoEchoInterface, { prefix: "" });');
        await expect(main([...args, '--check'])).resolves.toBeUndefined();
    }, 30_000);

    it('supports explicit whole-contract naming overrides', async () => {
        await mkdir(testDir, { recursive: true });
        const schema = defineInterface({ id: 'test.names' }, { ping: requestType(z.object({}), z.null()) }).toSchema();
        const ref = { interfaceId: schema.id, interfaceHash: schema.hash };
        const bundle = resolve(testDir, 'names.json');
        const names = resolve(testDir, 'overrides.json');
        const output = resolve(testDir, 'named.ts');
        await writeFile(bundle, JSON.stringify({ interfaceSchemas: [schema], bareInterfaces: [{ prefix: 'Runtime.', interface: ref }] }));
        await writeFile(names, JSON.stringify({
            interfaceNames: { [`${schema.id}@${schema.hash}`]: 'runtimeInterface' },
            bindingNames: { 'bare:Runtime.': 'runtime' },
        }));
        await main(['codegen', '--input', bundle, '--output', output, '--names', names]);
        expect(await readFile(output, 'utf8')).toContain('runtime: BareInterfaceTarget<typeof runtimeInterface> = bareInterfaceTarget(runtimeInterface, { prefix: "Runtime." });');
    });

    it('generates through the CLI and check detects missing and stale output without writing', async () => {
        await mkdir(testDir, { recursive: true });
        const daemon = defineInterface(
            { id: 'dbgjs.daemon' },
            { ping: requestType(z.object({ value: z.string() }), z.null()) },
        ).toSchema();
        const cdp = defineInterface(
            { id: 'cdp' },
            { evaluate: requestType(z.object({ expression: z.string() }), z.unknown()) },
        ).toSchema();
        const bundlePath = resolve(testDir, 'interfaces.json');
        const outputPath = resolve(testDir, 'generated', 'daemon.ts');
        await writeFile(bundlePath, JSON.stringify({
            interfaceSchemas: [cdp, daemon],
            services: [{
                serviceId: 'daemon',
                interfaces: [{
                    interfaceId: daemon.id,
                    interfaceHash: daemon.hash,
                }],
            }],
            defaultInterface: {
                interfaceId: daemon.id,
                interfaceHash: daemon.hash,
            },
        }));
        const args = [
            'codegen',
            '--input', bundlePath,
            '--interface', 'dbgjs.daemon',
            '--name', 'daemonInterface',
            '--output', outputPath,
            '--preserve-wire-schema',
        ];

        await expect(main([...args, '--check'])).rejects.toThrow(/output is missing/);
        await main(args);
        const generated = await readFile(outputPath, 'utf8');
        expect(generated).toContain('export const daemonInterface = new InterfaceDefinition(');
        expect(generated).toContain('const wireSchema: LinkRpcInterfaceSchema = JSON.parse(');
        await expect(main([...args, '--check'])).resolves.toBeUndefined();

        await writeFile(outputPath, `${generated}// stale\n`);
        await expect(main([...args, '--check'])).rejects.toThrow(/output is stale/);
        expect(await readFile(outputPath, 'utf8')).toBe(`${generated}// stale\n`);
    });
});
