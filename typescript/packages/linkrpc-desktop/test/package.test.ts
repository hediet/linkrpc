import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('ships the advertised executable and package entry points', () => {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    expect(execFileSync(process.execPath, ['dist/cli.js', '--help'], { cwd, encoding: 'utf8' })).toContain('linkrpc-desktop serve');
    const exports = execFileSync(process.execPath, ['--input-type=module', '-e', `
        const service = await import('./dist/index.js');
        const browser = await import('./dist/browser.js');
        console.log(JSON.stringify({
            service: Object.keys(service).sort(),
            browser: Object.keys(browser).sort(),
        }));
    `], { cwd, encoding: 'utf8' });
    expect(JSON.parse(exports)).toEqual({
        service: ['VncBackend', 'hostVncDesktop', 'startDesktopViewer'],
        browser: ['connectDesktop', 'createViewerClient'],
    });
});
