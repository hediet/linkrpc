import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubHome, readEndpointDiscovery, connectToHubManagement } from '@hediet/linkrpc-hub-daemon/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(isolated = false) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lr-services-cli-'));
    cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const home = HubHome.at(path.join(root, 'daemon'));
    cleanup.push(async () => {
        if (!readEndpointDiscovery(home.managementFile)) return;
        const handle = await connectToHubManagement(home);
        await handle.management.shutdown({});
        handle.close();
        for (let i = 0; i < 100 && readEndpointDiscovery(home.managementFile); i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    });
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(LINKRPC|HUBRPC)_/.test(key)) delete env[key];
    Object.assign(env, { LINKRPC_HUB_HOME: home.customDir, APPDATA: root, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root });
    const packageDir = fileURLToPath(new URL('..', import.meta.url));
    let cli = path.join(packageDir, 'dist', 'hub.js');
    if (isolated) {
        const target = path.join(root, 'cli');
        const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
        expect(manifest.dependencies['@hediet/linkrpc-hub-daemon']).toBeUndefined();
        await cp(path.join(packageDir, 'dist'), path.join(target, 'dist'), { recursive: true });
        await writeFile(path.join(target, 'package.json'), JSON.stringify({ ...manifest, devDependencies: undefined }));
        for (const name of Object.keys(manifest.dependencies)) {
            const destination = path.join(target, 'node_modules', name);
            await mkdir(path.dirname(destination), { recursive: true });
            await symlink(await realpath(path.join(packageDir, 'node_modules', name)), destination, process.platform === 'win32' ? 'junction' : 'dir');
        }
        cli = path.join(target, 'dist', 'hub.js');
    }
    const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        execFile(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...overrides }, windowsHide: true, timeout: 45_000 }, (error, stdout, stderr) => {
            if (error && typeof error.code !== 'number') { reject(error); return; }
            resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
        });
    });
    const ok = async (args: string[]) => {
        const result = await run(args);
        expect({ code: result.code, error: result.code ? result.stderr : '' }).toEqual({ code: 0, error: '' });
        return result.stdout;
    };
    return { root, home, env, run, ok, cli };
}

describe('hub services CLI', { timeout: 120_000 }, () => {
    it('bootstraps standalone management, detaches, lists, logs, and stops', async () => {
        const f = await fixture();
        const missing = await f.run(['services', 'list', '--all-contexts']);
        expect(missing.code).not.toBe(0);
        expect(missing.stderr).toContain('no local services are running');
        await f.ok(['services', 'run', '--new-context', '.', '--detach', '--readiness', 'spawned', '--',
            process.execPath, '-e', 'console.log("background-output"); setInterval(() => {}, 1000)']);
        const list = JSON.parse(await f.ok(['services', 'list']));
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: 'main', persistent: false, restart: 'never', runtime: { state: 'running' } });
        expect(await f.ok(['services', 'logs'])).toContain('background-output');
        await f.ok(['services', 'stop']);
        expect(JSON.parse(await f.ok(['services', 'list']))).toEqual([]);
        const noServices = await f.run(['ls']);
        expect(noServices.stderr).toContain('no local services are running');
    });

    it('streams foreground output and preserves process exit status', async () => {
        const f = await fixture();
        const result = await f.run(['services', 'run', '--new-context', '.', '--readiness', 'spawned', '--',
            process.execPath, '-e', 'console.log("foreground-output"); process.exitCode = 7']);
        expect(result.stdout).toContain('foreground-output');
        expect(result.code).toBe(7);
        expect(JSON.parse(await f.ok(['services', 'list']))).toEqual([]);
    });

    it('discovers and calls a daemon-owned participant from another CLI process', async () => {
        const f = await fixture();
        const script = fileURLToPath(new URL('../../linkrpc-hub-daemon/src/test/echoService.mjs', import.meta.url));
        await f.ok(['services', 'run', '--new-context', '.', '--env', 'ECHO_REFLECTION=1', '--detach', '--', process.execPath, script]);
        const endpoints = JSON.parse(await f.ok(['services', 'list']));
        expect(await f.ok(['ls', '--json'])).toContain('test.echo');
        const result = await f.ok(['call', `${endpoints[0].serviceId}::test.echo::echo`, '--params', '{"text":"separate terminal"}']);
        expect(JSON.parse(result)).toMatchObject({ text: 'separate terminal' });
        await f.ok(['services', 'stop']);
    });

    it('uses the effective Hub endpoint without falling back to local execution', async () => {
        const f = await fixture();
        await f.ok(['services', 'run', '--new-context', '.', '--detach', '--readiness', 'spawned', '--',
            process.execPath, '-e', 'setInterval(() => {}, 1000)']);
        const endpoint = readEndpointDiscovery(f.home.discoveryFile)!.endpoint;
        const result = await f.run(['services', 'list'], { HUBRPC_ENDPOINT: endpoint, HUBRPC_TOKEN: '' });
        expect({ code: result.code, error: result.code ? result.stderr : '' }).toEqual({ code: 0, error: '' });
        expect(JSON.parse(result.stdout)).toHaveLength(1);
        const missing = process.platform === 'win32' ? `\\\\.\\pipe\\missing-${path.basename(f.root)}` : path.join(f.root, 'missing.sock');
        const failed = await f.run(['--endpoint', missing, 'services', 'run', '--cwd', f.root, '--id', 'forbidden', '--', process.execPath, '-e', '0']);
        expect(failed.code).not.toBe(0);
        expect(JSON.parse(await f.ok(['services', 'list'])).map((value: { id: string }) => value.id)).toEqual(['main']);
        const refused = await f.run(['services', 'restart'], { HUBRPC_ENDPOINT: endpoint });
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain('only replaces the default local daemon');
        expect(JSON.parse(await f.ok(['services', 'list']))).toHaveLength(1);
    });

    it('explicitly restarts the daemon and retains persistent definitions without OS autostart changes', async () => {
        const f = await fixture();
        await f.ok(['services', 'run', '--new-context', '.', '--persistent', '--readiness', 'spawned', '--', process.execPath, '-e', '0']);
        const before = readEndpointDiscovery(f.home.managementFile)!;
        await f.ok(['services', 'restart']);
        const after = readEndpointDiscovery(f.home.managementFile)!;
        expect(after.pid).not.toBe(before.pid);
        expect(JSON.parse(await f.ok(['services', 'list']))).toMatchObject([{ id: 'main', persistent: true, desired: false, runtime: { state: 'disabled' } }]);
        const handle = await connectToHubManagement(f.home);
        try {
            const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
            expect((await handle.management.getStatus({})).version).toBe(manifest.version);
        } finally {
            handle.close();
        }
    });

    it('runs and restarts from a relocated CLI package with only runtime dependencies', async () => {
        const f = await fixture(true);
        await f.ok(['services', 'run', '--new-context', '.', '--readiness', 'spawned', '--', process.execPath, '-e', 'console.log("bundled")']);
        const first = readEndpointDiscovery(f.home.managementFile)!;
        await f.ok(['services', 'restart']);
        expect(readEndpointDiscovery(f.home.managementFile)!.pid).not.toBe(first.pid);
        expect(JSON.parse(await f.ok(['services', 'list']))).toEqual([]);
    });

    it('fails fast for a legacy daemon and replaces it only on explicit restart', async () => {
        const f = await fixture();
        const script = fileURLToPath(new URL('./test/legacyDaemon.mjs', import.meta.url));
        const child = spawn(process.execPath, [script, f.home.stateDir], { env: f.env, stdio: 'ignore', windowsHide: true });
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        cleanup.push(async () => {
            if (child.exitCode === null) child.kill();
            await exited;
        });
        await vi.waitFor(() => expect(readEndpointDiscovery(f.home.managementFile)?.pid).toBe(child.pid), { timeout: 10_000 });
        const failed = await f.run(['services', 'list', '--all-contexts']);
        expect(failed.code).not.toBe(0);
        expect(failed.stderr).toContain('hub services restart');
        expect(failed.stderr).toContain('cannot report its interfaces');
        expect(readEndpointDiscovery(f.home.managementFile)?.pid).toBe(child.pid);
        await f.ok(['services', 'restart']);
        expect(readEndpointDiscovery(f.home.managementFile)?.pid).not.toBe(child.pid);
        expect(JSON.parse(await f.ok(['services', 'list', '--all-contexts']))).toEqual([]);
    });
});
