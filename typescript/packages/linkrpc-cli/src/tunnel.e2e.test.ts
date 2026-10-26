import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SocketServer } from '@hediet/linkrpc-hub/hub/server/node';
import { parseHubConfig } from '@hediet/linkrpc-client-internal';
import { runHub, type RunningHub } from './engine/runHub';

const CLI = fileURLToPath(new URL('../dist/linkrpc.js', import.meta.url));

function endpointUri(socketPath: string): string {
    return process.platform === 'win32'
        ? `npipe://${socketPath.replace(/^\\\\/, '').replace(/\\/g, '/')}`
        : `unix:${socketPath}`;
}

describe('tunnel e2e', () => {
    it('exits non-zero when its target goes away, so a supervisor can restart it', async () => {
        const socketPath = SocketServer.allocSocketPath();
        const config = parseHubConfig({
            forwardChecking: false,
            hubServiceId: 'hub',
            listeners: [{ type: 'socket', path: socketPath, handlers: [{ token: 'anonymous', grantedServiceId: 'svc' }] }],
        });
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linkrpc-tunnel-e2e-'));
        let running: RunningHub | undefined;
        try {
            running = await runHub({ config, log: () => { /* quiet */ } });
            // A target that serves nothing and exits after a moment.
            const target = `"${process.execPath}" -e "setTimeout(() => {}, 500)"`;
            const child = spawn(process.execPath, [
                CLI, 'hub', '--context', ':empty', '--no-use-env', '--principal', `file:${path.join(home, 'identity.json')}`,
                '--endpoint', endpointUri(socketPath),
                'tunnel', 'svc', '--target-endpoint-cmd-stdio', target,
            ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, APPDATA: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home } });
            let stderr = '';
            child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
            const code = await new Promise<number | null | 'timeout'>((resolve) => {
                const timer = setTimeout(() => { child.kill(); resolve('timeout'); }, 15_000);
                child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
            });
            expect(stderr).toContain("claimed 'svc'");
            expect(stderr).toContain('tunnel: the target connection closed');
            expect(code).toBe(1);
        } finally {
            await running?.dispose();
            fs.rmSync(home, { recursive: true, force: true });
        }
    }, 30_000);
});
