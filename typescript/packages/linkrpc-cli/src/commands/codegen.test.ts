import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
