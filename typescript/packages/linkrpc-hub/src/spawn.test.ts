import { describe, expect, it } from 'vitest';
import { spawnCommand } from './spawn';

describe('spawnCommand', () => {
    it('preserves native executable arguments without a shell', async () => {
        const args = ['with spaces', 'line\nbreak', 'literal & value'];
        const child = spawnCommand({
            argv: [process.execPath, '--eval', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args],
        }, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout!.on('data', chunk => { stdout += String(chunk); });
        child.stderr!.on('data', chunk => { stderr += String(chunk); });
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        expect({ code, stderr, args: JSON.parse(stdout) }).toEqual({ code: 0, stderr: '', args });
    });
});
