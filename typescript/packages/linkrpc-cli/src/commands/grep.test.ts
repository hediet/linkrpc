import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../cli';

afterEach(() => {
    process.exitCode = undefined;
});

describe('linkrpc grep', () => {
    const server = fileURLToPath(new URL('../../examples/demo-server.ts', import.meta.url));
    const grep = async (...args: string[]) => {
        const stdout: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
            stdout.push(String(chunk));
            return true;
        });
        try {
            await main([
                '--context', ':empty',
                '--endpoint-cmd-stdio', `${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(server)}`,
                'grep', ...args,
            ]);
        } finally {
            spy.mockRestore();
        }
        const exitCode = process.exitCode;
        process.exitCode = undefined;
        return { exitCode, stdout: stdout.join('') };
    };

    it('prints matching members with line numbers and context', async () => {
        expect(await grep('TEXT: z')).toMatchInlineSnapshot(`
          {
            "exitCode": undefined,
            "stdout": "demo.echo::echo
          19-             z.object({
          20:                 text: z.string(),
          21-             }),
          22-             z.object({
          23:                 text: z.string(),
          24-             }),
          ",
          }
        `);
        expect(await grep('TEXT: z', '-C', '0')).toMatchInlineSnapshot(`
          {
            "exitCode": undefined,
            "stdout": "demo.echo::echo
          20:                 text: z.string(),
          --
          23:                 text: z.string(),
          ",
          }
        `);
    }, 30_000);

    it('matches literally with --fixed-strings', async () => {
        expect(await grep('z.object({})', '--fixed-strings', '-C', '0')).toMatchInlineSnapshot(`
          {
            "exitCode": undefined,
            "stdout": "demo.echo::ping
          27:             z.object({}),
          ",
          }
        `);
    }, 30_000);

    it('exits with 1 when nothing matches', async () => {
        expect(await grep('no such member')).toMatchInlineSnapshot(`
          {
            "exitCode": 1,
            "stdout": "",
          }
        `);
    }, 30_000);
});
