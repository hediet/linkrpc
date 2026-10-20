import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectToHub } from '@hediet/linkrpc/node';
import { decodeConsoleData, type ConsoleServerMessage } from '@hediet/linkrpc-infra/console';
import { HubHome, readEndpointDiscovery, connectToHubManagement, managedEndpointsInterface } from '@hediet/linkrpc-hub-daemon/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

/** Terminal output without control sequences, so assertions do not depend on ConPTY's rendering. */
function screenText(value: string): string {
    // eslint-disable-next-line no-control-regex
    return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, '').replace(/\r/g, '');
}

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
    const start = (args: string[], terminal = false) => {
        // Exercise the CLI's real readline/key handling over a deterministic input stream.
        const terminalHook = 'data:text/javascript,' + encodeURIComponent('process.stdin.isTTY = true; process.stdin.setRawMode = () => process.stdin;');
        const child = spawn(process.execPath, [...(terminal ? ['--import', terminalHook] : []), cli, ...args], {
            cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
        const exited = new Promise<number | null>((resolve, reject) => {
            child.once('exit', resolve);
            child.once('error', reject);
        });
        cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        return { child, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
    };
    return { root, home, env, run, ok, cli, start };
}

describe('hub services CLI', { timeout: 120_000 }, () => {
    it('uses the always-existing root context when no folder context applies', async () => {
        const f = await fixture();
        const status = JSON.parse(await f.ok(['services', 'run', '-x', '--detach', '--id', 'scratch', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)']));
        expect({ namespace: status.namespace, id: status.id }).toEqual({ namespace: ':root', id: 'scratch' });
        expect(JSON.parse(await f.ok(['services', 'list']))).toMatchObject([{ namespace: ':root', id: 'scratch' }]);
        await f.ok(['services', 'stop', '--id', 'scratch']);

        const implicit = await f.run(['context', 'set', '--namespace', 'shared']);
        expect(implicit.code).not.toBe(0);
        expect(implicit.stderr).toContain('select it explicitly with --context :root');
        const created = await f.run(['context', '--new-context', ':root']);
        expect(created.stderr).toContain('The root context always exists');
        await f.ok(['context', 'set', '--context', ':root', '--namespace', 'shared']);
        expect(await f.ok(['context', 'list'])).toBe(':root\n');
        expect(await f.ok(['context', 'show'])).toMatch(/Reference: :root[\s\S]*--namespace = shared/);
        expect(await f.ok(['context', 'remove', '--context', ':root'])).toContain('Reset context :root');
        expect(await f.ok(['context', 'show'])).not.toContain('--namespace');
        const empty = await f.run(['--context', ':empty', 'services', 'list']);
        expect(empty.stderr).toContain('The :empty context has no namespace');
    });
    it.each([false, true])('prints matching reattach guidance for an attachment and duplicate launches (routed: %s)', async routed => {
        const f = await fixture();
        await f.ok(['context', '--new-context', '.']);
        await f.ok(['services', 'restart']);
        const flags = ['--context', f.root, '--no-use-env',
            ...(routed ? ['--endpoint', readEndpointDiscovery(f.home.discoveryFile)!.endpoint, '--daemon-service', 'hub/daemon'] : [])];
        await f.ok([...flags, 'services', '--namespace', 'custom namespace', 'run', '-x', '--detach', '--cwd', f.root, '--id', 'counter-fg', '--',
            process.execPath, '-e', 'setInterval(() => {}, 1000)']);
        const before = JSON.parse(await f.ok([...flags, 'services', '--namespace', 'custom namespace', 'list']));
        let hint = '';
        for (const mode of ['--detach', '--foreground']) {
            const result = await f.run([...flags, 'services', '--namespace', 'custom namespace', 'run', '-x', mode, '--cwd', f.root, '--id', 'counter-fg', '--', process.execPath]);
            expect(result.code).not.toBe(0);
            expect(result.stderr).toContain('Endpoint "counter-fg" already exists in custom namespace');
            const match = /Attach to it: (hub services attach .*)/.exec(result.stderr);
            expect(match).not.toBeNull();
            expect(result.stderr).toContain('Or replace it: rerun this command with --force');
            hint = match![1]!;
            expect(hint).toContain('--id counter-fg --context ');
            expect(hint).toContain("--namespace 'custom namespace' --no-use-env");
            expect(hint.includes('--endpoint ')).toBe(routed);
            if (routed) expect(hint).toContain('--daemon-service hub/daemon');
        }
        const attached = f.start([...flags, 'services', '--namespace', 'custom namespace', 'attach', '--id', 'counter-fg'], true);
        await vi.waitFor(() => expect(attached.stderr).toContain(`Reattach: ${hint}\n`), { timeout: 15_000 });
        attached.child.stdin.write('\x04');
        await vi.waitFor(() => expect(attached.child.exitCode).toBe(0), { timeout: 5000 });
        expect(JSON.parse(await f.ok([...flags, 'services', '--namespace', 'custom namespace', 'list']))[0].instanceId).toBe(before[0].instanceId);
        await f.ok([...flags, 'services', '--namespace', 'custom namespace', 'stop', '--id', 'counter-fg']);
    });

    it.each(['\x03', '\x04'])('promptly stops foreground work on terminal control %j', async control => {
        const f = await fixture();
        const owner = f.start(['services', 'run', '--new-context', '.', '-x', '--foreground', '--',
            process.execPath, '-e', 'console.log(process.pid); setInterval(() => {}, 1000)'], true);
        await vi.waitFor(() => expect(owner.stdout, owner.stderr).toMatch(/^\d+\n$/), { timeout: 15_000 });
        expect(owner.stderr).toContain('Attach from another terminal while running: hub services attach --id main --context ');
        expect(owner.stderr.split('Attach from another terminal while running:')[1]).not.toContain('--new-context');
        const pid = Number(owner.stdout.trim());
        const start = performance.now();
        owner.child.stdin.write(control);
        await vi.waitFor(() => expect(owner.child.exitCode, owner.stderr + owner.stdout).toBe(0), { timeout: 4000 });
        expect(await owner.exited).toBe(0);
        expect(performance.now() - start).toBeLessThan(2000);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(JSON.parse(await f.ok(['services', 'list']))).toEqual([]);
    });

    it.each([false, true])('shares interactive counter requests and responses (foreground: %s)', async foreground => {
        const f = await fixture();
        await f.ok(['context', '--new-context', '.']);
        const script = fileURLToPath(new URL('../examples/interactive-counter.mjs', import.meta.url));
        const args = ['services', 'run', '-x', foreground ? '--foreground' : '--detach', '--', process.execPath, script];
        const owner = foreground ? f.start(args, true) : undefined;
        if (!foreground) await f.ok(args);
        if (owner) await vi.waitFor(() => expect(owner.stdout, owner.stderr).toContain('Commands:'), { timeout: 15_000 });
        const attached = f.start(['services', 'attach'], true);
        await vi.waitFor(() => expect(attached.stdout, attached.stderr).toContain('tick 1\n'), { timeout: 15_000 });
        attached.child.stdin.write('count\r');
        await vi.waitFor(() => expect(attached.stdout).toMatch(/count [1-9]\d*\n/));
        (owner ?? attached).child.stdin.write('echo hello\r');
        await vi.waitFor(() => {
            expect(attached.stdout).toMatch(/\[\d+\] hello\n/);
            if (owner) expect(owner.stdout).toMatch(/\[\d+\] hello\n/);
        });
        attached.child.stdin.write('reset\r');
        await vi.waitFor(() => expect(attached.stdout).toContain('reset 0\n'));
        attached.child.stdin.write('invalid\r');
        await vi.waitFor(() => expect(attached.stderr).toContain('Unknown command: invalid.'));
        if (process.platform === 'win32') {
            // Windows pipes cannot deliver an interrupt; Ctrl+C must not terminate the shared service.
            attached.child.stdin.write('\x03');
            await vi.waitFor(() => expect(attached.stderr).toContain('Interrupting is not supported for pipe processes on this host'));
            expect(JSON.parse(await f.ok(['services', 'list']))).toMatchObject([{ runtime: { state: 'running' } }]);
        }
        attached.child.stdin.write('\x04');
        expect(await attached.exited).toBe(0);
        expect(JSON.parse(await f.ok(['services', 'list']))).toMatchObject([{ runtime: { state: 'running' } }]);
        const final = owner ?? f.start(['services', 'attach'], true);
        await vi.waitFor(() => expect(final.stdout).toContain('Commands:'), { timeout: 15_000 });
        final.child.stdin.write('quit\r');
        await vi.waitFor(() => expect(final.child.exitCode, final.stderr + final.stdout).toBe(0), { timeout: 5000 });
        expect(await final.exited).toBe(0);
        expect(final.stdout).toMatch(/bye \d+\n/);
        expect(JSON.parse(await f.ok(['services', 'list']))).toEqual([]);
    });

    it.each([false, true])('multiplexes a plain counter over CLI attach and the routed Hub API (foreground: %s)', async foreground => {
        const f = await fixture();
        await f.ok(['context', '--new-context', '.']);
        const counter = fileURLToPath(new URL('../examples/counter.mjs', import.meta.url));
        const args = ['services', 'run', foreground ? '-x' : '--no-rpc', foreground ? '--foreground' : '--detach',
            '--', process.execPath, counter];
        const owner = foreground ? f.start(args) : undefined;
        if (!foreground) await f.ok(args);
        await vi.waitFor(() => expect(readEndpointDiscovery(f.home.discoveryFile)).toBeDefined(), { timeout: 15_000 });
        const hub = await connectToHub({ endpoint: readEndpointDiscovery(f.home.discoveryFile)!.endpoint, token: '' });
        cleanup.push(async () => hub.close());
        const client = hub.connection.get(managedEndpointsInterface, { serviceId: 'hub/daemon' });
        await vi.waitFor(async () => expect(await client.list({})).toMatchObject([
            { rpc: false, sourceKind: 'process', runtime: { state: 'running', connections: 0 } },
        ]), { timeout: 15_000 });
        const [running] = await client.list({});
        expect(running!.console).toEqual({ mode: 'pipe' });
        const address = { namespace: running!.namespace, id: running!.id };
        const messages: ConsoleServerMessage[] = [];
        const observation = client.consoles.attach({ params: address, interactive: false }, {
            onMessage: message => { messages.push(message); },
        });
        const observed = observation.then(result => result, (error: unknown) => String(error));
        const observerOutput = () => messages.flatMap(message => message.t === 'output' && message.stream === 'stdout'
            ? [new TextDecoder().decode(decodeConsoleData(message.data))] : []).join('');
        const attached = f.start(['services', 'attach']);
        // The generic command finds the template instance through directory tags and reflection.
        const hubEndpoint = ['--endpoint', readEndpointDiscovery(f.home.discoveryFile)!.endpoint];
        const listing = await f.run([...hubEndpoint, 'attach']);
        expect(listing.stdout, listing.stderr).toMatch(/hub\/daemon {2}linkrpc\.managedEndpoints {2}consoles {2}\{/);
        const invalid = await f.run([...hubEndpoint, 'attach', 'hub/daemon', '--params', '{"id":"main"}']);
        expect(invalid.code).not.toBe(0);
        expect(invalid.stderr).toContain('--params does not match the params of console "consoles"');
        const generic = f.start([...hubEndpoint, 'attach', 'hub/daemon', '--params', JSON.stringify(address), '--read-only']);
        await vi.waitFor(() => {
            expect(attached.stdout, attached.stderr).toContain('1\n2\n');
            expect(generic.stdout, generic.stderr).toContain('1\n2\n');
            expect(observerOutput()).toContain('1\n2\n');
            if (owner) expect(owner.stdout, owner.stderr).toContain('1\n2\n');
        }, { timeout: 15_000 });
        attached.child.stdin.write('\x1d\n');
        expect(await attached.exited).toBe(0);
        generic.child.kill();
        await generic.exited;
        expect((await client.list({}))[0]?.runtime.pid).toBe(running!.runtime.pid);
        await vi.waitFor(() => expect(observerOutput()).toContain('3\n'), { timeout: 5000 });
        expect(await f.ok(['services', 'logs'])).toContain('1\n2\n3\n');
        if (owner) {
            owner.child.stdin.write('\x1d\n');
            expect(await owner.exited).toBe(0);
        } else {
            await f.ok(['services', 'stop']);
        }
        expect(await observed).toHaveProperty('exit');
        expect(await client.list({})).toEqual([]);
        expect(() => process.kill(running!.runtime.pid!, 0)).toThrow();
    });

    it('runs a TTY service: keys reach the program, attachments see the screen, and detach keys detach or stop', async () => {
        const f = await fixture();
        await f.ok(['context', '--new-context', '.']);
        const script = 'console.log("tty=" + process.stdout.isTTY); process.stdin.setRawMode(true);'
            + ' process.stdin.on("data", data => process.stdout.write("key=" + JSON.stringify(String(data)) + "\\r\\n"));';
        const owner = f.start(['--detach-keys', 'ctrl-p,ctrl-q', 'services', 'run', '-x', '-t', '--foreground', '--', process.execPath, '-e', script], true);
        await vi.waitFor(() => expect(screenText(owner.stdout), owner.stderr).toContain('tty=true'), { timeout: 15_000 });
        expect(owner.stderr).toContain('Foreground (TTY). Keys go to the program; Ctrl+P, then Ctrl+Q stops and removes the service.');
        // The owner's sequence is Ctrl+P, Ctrl+Q, so the default Ctrl+B, then d reaches the program.
        owner.child.stdin.write('\x03\x02d');
        await vi.waitFor(() => expect(screenText(owner.stdout)).toMatch(/key="\\u0003(\\u0002d)?"/), { timeout: 10_000 });
        await vi.waitFor(() => expect(screenText(owner.stdout)).toContain('\\u0002'), { timeout: 10_000 });

        const attached = f.start(['services', 'attach'], true);
        await vi.waitFor(() => expect(screenText(attached.stdout), attached.stderr).toContain('tty=true'), { timeout: 15_000 });
        expect(attached.stderr).toContain('Attached (TTY). Keys go to the program; Ctrl+B, then d detaches.');
        attached.child.stdin.write('a');
        await vi.waitFor(() => expect(screenText(owner.stdout)).toContain('key="a"'), { timeout: 10_000 });
        attached.child.stdin.write('\x02d');
        await vi.waitFor(() => expect(attached.child.exitCode, attached.stderr).toBe(0), { timeout: 5000 });
        expect(attached.stderr).toContain('Detached. Reattach: hub services attach --id main');
        expect(JSON.parse(await f.ok(['services', 'list']))).toMatchObject([{ owned: true, console: { mode: 'tty' }, runtime: { state: 'running' } }]);

        const invalidKeys = await f.run(['--detach-keys', 'alt-x', 'services', 'attach']);
        expect(invalidKeys.code).not.toBe(0);
        expect(invalidKeys.stderr).toContain('Invalid detach key "alt-x"');

        await f.ok(['context', 'set', '--detach-keys', 'ctrl-],q']);
        const stored = f.start(['services', 'attach'], true);
        await vi.waitFor(() => expect(stored.stderr).toContain('Attached (TTY). Keys go to the program; Ctrl+], then q detaches.'), { timeout: 15_000 });
        stored.child.stdin.write('\x1dq');
        await vi.waitFor(() => expect(stored.child.exitCode, stored.stderr).toBe(0), { timeout: 5000 });

        owner.child.stdin.write('\x10\x11');
        await vi.waitFor(() => expect(owner.child.exitCode, owner.stderr).toBe(0), { timeout: 5000 });
        expect(JSON.parse(await f.ok(['services', 'list']))).toEqual([]);
    });

    it('replaces detached and foreground endpoints with --force', async () => {
        const f = await fixture();
        await f.ok(['context', '--new-context', '.']);
        const counter = fileURLToPath(new URL('../examples/counter.mjs', import.meta.url));
        const owner = f.start(['services', 'run', '-x', '--foreground', '--', process.execPath, counter]);
        await vi.waitFor(() => expect(owner.stdout, owner.stderr).toContain('1\n'), { timeout: 15_000 });
        const [before] = JSON.parse(await f.ok(['services', 'list']));
        const replaced = JSON.parse(await f.ok(['services', 'run', '-x', '--detach', '--force', '--', process.execPath, counter]));
        expect({ owned: replaced.owned, replaced: replaced.instanceId !== before.instanceId }).toEqual({ owned: false, replaced: true });
        await owner.exited;
        expect(owner.stderr).toContain('Replaced by a new launch of the same endpoint.');
        expect(() => process.kill(before.runtime.pid, 0)).toThrow();
        const again = JSON.parse(await f.ok(['services', 'run', '-x', '--detach', '--force', '--', process.execPath, counter]));
        expect(again.instanceId).not.toBe(replaced.instanceId);
        expect(JSON.parse(await f.ok(['services', 'list']))).toMatchObject([{ instanceId: again.instanceId }]);
        await f.ok(['services', 'stop']);
    });

    it('rejects connected readiness for a plain process before starting a daemon', async () => {
        const f = await fixture();
        const result = await f.run(['services', 'run', '--no-rpc', '--readiness', 'connected', '--', process.execPath]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('--no-rpc cannot use --readiness connected');
        expect(readEndpointDiscovery(f.home.managementFile)).toBeUndefined();
    });

    it.each([
        { routed: false, rpc: false }, { routed: true, rpc: false },
        { routed: false, rpc: true }, { routed: true, rpc: true },
    ])('kills the foreground process tree when the CLI is forcibly killed ($routed, rpc: $rpc)', async ({ routed, rpc }) => {
        const f = await fixture();
        await f.ok(['context', '--new-context', '.']);
        await f.ok(['services', 'restart']);
        const endpoint = readEndpointDiscovery(f.home.discoveryFile)!.endpoint;
        const child = spawn(process.execPath, [f.cli,
            ...(routed ? ['--endpoint', endpoint] : []),
            'services', 'run', '--foreground', '--cwd', f.root,
            ...(rpc ? ['--readiness', 'spawned'] : ['--no-rpc']), '--restart', 'always', '--',
            process.execPath, '-e',
            'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]); console.log(JSON.stringify({ parent: process.pid, child: child.pid })); setInterval(() => {}, 1000)',
        ], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        await vi.waitFor(() => expect(stdout, stderr).toContain('"child":'), { timeout: 20_000 });
        const pids = JSON.parse(stdout.trim()) as { parent: number; child: number };
        expect(JSON.parse(await f.ok(['services', 'list']))).toMatchObject([{ runtime: { pid: pids.parent, state: 'running' } }]);
        const stopStarted = performance.now();
        child.kill('SIGKILL');
        await exited;
        await vi.waitFor(() => {
            expect(() => process.kill(pids.parent, 0)).toThrow();
            expect(() => process.kill(pids.child, 0)).toThrow();
        }, { timeout: 2000 });
        expect(performance.now() - stopStarted).toBeLessThan(2000);
        expect(JSON.parse(await f.ok(['services', 'list']))).toEqual([]);
    });

    it.each(['--detach', '--persistent'])('rejects --foreground with %s before starting a daemon', async conflict => {
        const f = await fixture();
        const result = await f.run(['services', 'run', '--foreground', conflict, '--', process.execPath, '-e', '0']);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('cannot be used with option');
        expect(readEndpointDiscovery(f.home.managementFile)).toBeUndefined();
    });

    it('forwards foreground stdin and cancels rather than detaching on Ctrl+]', async () => {
        const f = await fixture();
        const child = spawn(process.execPath, [f.cli, 'services', 'run', '--new-context', '.', '--foreground',
            '-x', '--', process.execPath, '-e',
            'process.stdin.on("data", data => process.stdout.write(data));',
        ], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdin.write('foreground-input\n');
        await vi.waitFor(() => expect(stdout, stderr).toContain('foreground-input'), { timeout: 15_000 });
        child.stdin.write('\x1d\n');
        await exited;
        await vi.waitFor(async () => expect(JSON.parse(await f.ok(['services', 'list']))).toEqual([]), { timeout: 15_000 });
    });

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

    it.each([false, true])('streams output and preserves process exit status (foreground: %s)', async foreground => {
        const f = await fixture();
        const result = await f.run(['services', 'run', ...(foreground ? ['--foreground'] : []), '--new-context', '.', '--readiness', 'spawned', '--',
            process.execPath, '-e', 'console.log("foreground-output"); process.exitCode = 7']);
        expect(result.stdout).toContain('foreground-output');
        expect(result.code).toBe(7);
        expect(JSON.parse(await f.ok(['services', 'list']))).toEqual([]);
    });

    it('discovers and calls a daemon-owned participant from another CLI process', async () => {
        const f = await fixture();
        const script = fileURLToPath(new URL('../../linkrpc-hub-daemon/src/test/echoService.mjs', import.meta.url));
        await f.ok(['services', '--namespace', 'other-project', 'run', '--env', 'ECHO_REFLECTION=1', '--detach', '--', process.execPath, script]);
        const endpoints = JSON.parse(await f.ok(['services', '--namespace', 'other-project', 'list']));
        expect(await f.ok(['--context', ':empty', 'ls', '--json'])).toContain('test.echo');
        const result = await f.ok(['--context', ':empty', 'call', `${endpoints[0].serviceId}::test.echo::echo`, '--params', '{"text":"separate terminal"}']);
        expect(JSON.parse(result)).toMatchObject({ text: 'separate terminal' });
        const missing = process.platform === 'win32' ? `\\\\.\\pipe\\missing-${path.basename(f.root)}` : path.join(f.root, 'missing.sock');
        const failed = await f.run(['--endpoint', missing, 'ls']);
        expect(failed.code).not.toBe(0);
        expect(failed.stdout).not.toContain('test.echo');
        await f.ok(['services', '--namespace', 'other-project', 'stop']);
    });

    it('explicit local discovery works without services, overrides ambient endpoints, and never bootstraps', async () => {
        const f = await fixture();
        const absent = await f.run(['--endpoint', 'linkrpc:local', 'ls']);
        expect(absent.code).not.toBe(0);
        expect(absent.stderr).toContain('local LinkRPC hub is not running');
        expect(readEndpointDiscovery(f.home.discoveryFile)).toBeUndefined();
        await f.ok(['--context', ':empty', 'services', 'restart']);
        const explicit = await f.run(['--endpoint', 'linkrpc:local', 'ls', '--json'], {
            HUBRPC_ENDPOINT: 'ws://127.0.0.1:1', HUBRPC_TOKEN: 'wrong-token',
        });
        expect({ code: explicit.code, error: explicit.code ? explicit.stderr : '' }).toEqual({ code: 0, error: '' });
        expect(explicit.stdout).toContain('linkrpc.managedEndpoints');
        await f.ok(['context', '--new-context', '.', '--endpoint', 'linkrpc:local']);
        expect(await f.ok(['ls', '--json'])).toContain('linkrpc.managedEndpoints');
        const implicit = await f.run(['--context', ':empty', 'ls']);
        expect(implicit.code).not.toBe(0);
        expect(implicit.stderr).toContain('no local services are running');
        const ui = await f.run(['--context', ':empty', 'ui']);
        expect(ui.stderr).toContain('no local services are running');
        const invalid = await f.run(['--namespace', 'not-for-call', 'ls']);
        expect(invalid.stderr).toContain("unknown option '--namespace'");
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
