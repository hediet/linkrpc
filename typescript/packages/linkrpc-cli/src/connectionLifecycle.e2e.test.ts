import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEndpointUri } from '@hediet/linkrpc/node';
import { connectViaTransport } from '@hediet/linkrpc-client-internal';
import { SocketServer } from '@hediet/linkrpc-hub/hub/server/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopConnectionBroker } from './commands/connectionBrokerClient';
import { ContextStore } from './contexts';
import { complete } from './completions/complete';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'linkrpc-lifecycle-'));
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
    const project = path.join(root, 'project');
    const child = path.join(project, 'child');
    await mkdir(child, { recursive: true });
    const server = await SocketServer.start();
    cleanups.push(async () => server.dispose());
    let activeConnections = 0;
    server.setConnectionHandler(transport => {
        activeConnections++;
        transport.onDidClose(() => activeConnections--);
        const remote = connectViaTransport(transport);
        remote.setRequestHandler({
            handleRequest: async call => ({ result: call.params ?? null }),
            handleNotification: () => {},
        });
    });
    const endpoint = formatEndpointUri({ kind: 'socket', path: server.endpoint });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(LINKRPC|HUBRPC)_/.test(key)) delete env[key];
    }
    Object.assign(env, { APPDATA: root, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root });
    const storeFile = process.platform === 'darwin'
        ? path.join(root, 'Library', 'Application Support', 'linkrpc', 'contexts.json')
        : path.join(root, 'linkrpc', 'contexts.json');
    const store = new ContextStore({ file: storeFile, cwd: project });
    const cli = fileURLToPath(new URL('../dist/linkrpc.js', import.meta.url));

    async function run(args: string[], cwd = project) {
        return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
            execFile(process.execPath, [cli, ...args], {
                cwd, env, timeout: 90_000, windowsHide: true,
            }, (error, stdout, stderr) => {
                if (error && typeof error.code !== 'number') {
                    reject(error);
                    return;
                }
                resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim() });
            });
        });
    }

    async function ok(args: string[], cwd?: string) {
        const result = await run(args, cwd);
        expect({ code: result.code, stderr: result.code === 0 ? '' : result.stderr })
            .toEqual({ code: 0, stderr: '' });
        return result.stdout;
    }

    async function create(args: string[]) {
        const broker = await ok(['--endpoint', endpoint, 'connection', 'create', ...args]);
        cleanups.push(() => stopConnectionBroker(broker, true));
        return broker;
    }

    return { root, project, child, endpoint, store, storeFile, run, ok, create, active: () => activeConnections };
}

describe('connection lifecycle CLI', { timeout: 180_000 }, () => {
    it('preserves remote connection startup errors instead of reporting only broker exit code', async () => {
        const f = await fixture();
        const missingSocket = formatEndpointUri({
            kind: 'socket',
            path: process.platform === 'win32'
                ? `\\\\.\\pipe\\missing-linkrpc-${path.basename(f.root)}`
                : path.join(f.root, 'missing.sock'),
        });
        const result = await f.run([
            '--endpoint', missingSocket, 'connection', 'create', '--timeout', 'inf',
            '--new-context', '.',
        ]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('connection broker failed to start:');
        expect(result.stderr).toMatch(/ENOENT|ECONNREFUSED/);
        expect(await f.store.list()).toEqual([]);
    });

    it.each([false, true])('preserves bounded cmd-env startup diagnostics (large output: %s)', async large => {
        const f = await fixture();
        const endpoint = formatEndpointUri({
            kind: 'cmd-env',
            command: {
                argv: [process.execPath, '-e', [
                    large ? 'process.stdout.write("discarded-start:" + "x".repeat(20000));' : '',
                    'process.stdout.write("\\nchild stdout diagnostic\\n");',
                    'process.stderr.write("child stderr diagnostic\\n");',
                    'process.exitCode = 23;',
                ].join(' ')],
            },
        });
        const result = await f.run(['--endpoint', endpoint, 'connection', 'create', '--ttl', 'inf']);
        expect(result.code).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('connection broker failed to start: overlay: cmd-env child exited (code 23)');
        expect(result.stderr).toContain('child stdout diagnostic');
        if (!large) expect(result.stderr).toContain('child stderr diagnostic');
        expect(result.stderr).not.toContain('discarded-start:');
        expect(result.stderr.length).toBeLessThan(17_000);
    });

    it('reports the cmd-env startup deadline and kills a child that never connects', async () => {
        const f = await fixture();
        const pidFile = path.join(f.root, 'startup-child.pid');
        const endpoint = formatEndpointUri({
            kind: 'cmd-env',
            command: {
                argv: [process.execPath, '-e', [
                    'require("node:fs").writeFileSync(process.env.LINKRPC_TEST_PID_FILE, String(process.pid));',
                    'process.stderr.write("still starting the application\\n");',
                    'setInterval(() => {}, 1000);',
                ].join(' ')],
            },
            env: { LINKRPC_TEST_PID_FILE: pidFile },
        });
        const result = await f.run([
            '--endpoint', endpoint, 'connection', 'create', '--timeout', 'inf', '--new-context', '.',
        ]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('overlay: timed out waiting for cmd-env child to connect');
        expect(result.stderr).toContain('still starting the application');
        expect(await f.store.list()).toEqual([]);
        const pid = Number(await readFile(pidFile, 'utf8'));
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    });

    it('requires an explicit limit even with stored limits and --new-context', async () => {
        const f = await fixture();
        await f.store.set({ kind: 'id', id: 'limits' }, {
            endpoint: f.endpoint, connectionTimeout: '30s', connectionTtl: '5min',
        });
        for (const command of [['connection', 'create'], ['connect']]) {
            const result = await f.run([...command, '--context', 'id:limits', '--new-context', 'id:owned']);
            expect(result.code).not.toBe(0);
            expect(result.stderr).toContain('requires an explicit --timeout or --ttl');
        }
        expect(f.active()).toBe(0);
        expect((await f.store.list()).map(c => c.key)).toEqual(['id:limits']);
    });

    it.each([
        [['--timeout', 'inf'], 'inf', 'inf'],
        [['--ttl', 'inf'], 'inf', 'inf'],
        [['--timeout', '2min'], 120_000, 'inf'],
        [['--ttl', '2min'], 'inf', 120_000],
        [['--timeout', '2min', '--ttl', '3min'], 120_000, 180_000],
    ] as const)('uses explicit limits and defaults omissions to inf: %j', async (args, timeoutMs, ttlMs) => {
        const f = await fixture();
        await f.store.set({ kind: 'root' }, { connectionTimeout: '1ms', connectionTtl: '1ms' });
        const broker = await f.create([...args]);
        expect(JSON.parse(await f.ok(['--endpoint', broker, 'connection', 'status'])))
            .toMatchObject({ timeoutMs, ttlMs });
        await f.ok(['--endpoint', broker, 'connection', 'destroy']);
        await vi.waitFor(() => expect(f.active()).toBe(0));
    });

    it('owns a folder broker without copying ownership to derived contexts or temporary overrides', async () => {
        const f = await fixture();
        await f.create(['--timeout', 'inf', '--new-context', '.']);
        expect(JSON.parse(await f.ok(['call', 'echo', '--params', '{"ok":true}', '--no-validate'], f.child)))
            .toEqual({ ok: true });
        await f.ok(['context', 'show', '--new-context', 'id:derived']);
        expect((await f.store.select({ selector: 'id:derived' })).context?.ownedConnection).toBeUndefined();
        await f.ok(['context', 'remove', '--context', 'id:derived']);
        await f.ok(['--endpoint', f.endpoint, 'call', 'echo', '--params', '{}', '--no-validate']);
        await f.ok(['context', 'set', '--validation', 'off']);
        expect((await f.store.select()).context?.ownedConnection).toBeDefined();
        expect(f.active()).toBe(1);
        await f.ok(['context', 'remove', '--context', '.']);
        await vi.waitFor(() => expect(f.active()).toBe(0));
        expect(await f.store.list()).toEqual([]);
    });

    it.each([
        ['context', 'set', '--endpoint', 'ws://unused.invalid'],
        ['context', 'set', '--endpoint-token', 'replacement'],
        ['context', 'set', '--endpoint-cmd', 'node unused.js'],
        ['context', 'set', '--unset', 'endpoint'],
        ['context', 'set', '--unset', 'endpoint-token'],
        ['--endpoint', 'ws://unused.invalid', '--context-set', 'context', 'show'],
    ])('tears down and clears ownership on persisted mutation: %j', async (...args) => {
        const f = await fixture();
        await f.create(['--ttl', 'inf', '--new-context', '.']);
        await f.ok(args);
        await vi.waitFor(() => expect(f.active()).toBe(0));
        expect((await f.store.select()).context?.ownedConnection).toBeUndefined();
    });

    it('does not stop saved/shared endpoints when their contexts are removed', async () => {
        const f = await fixture();
        const broker = await f.create(['--timeout', 'inf']);
        await f.ok(['context', 'set', '--context', 'id:shared', '--endpoint', broker]);
        await f.ok(['context', 'remove', '--context', 'id:shared']);
        expect(JSON.parse(await f.ok(['--endpoint', broker, 'connection', 'status'])))
            .toMatchObject({ timeoutMs: 'inf' });
    });

    it.each(['timeout', 'ttl'])('cleans up after finite %s expiration', async limit => {
        const f = await fixture();
        await f.create([`--${limit}`, '1500ms', '--new-context', '.']);
        await vi.waitFor(() => expect(f.active()).toBe(0), { timeout: 5_000 });
        await f.ok(['context', 'remove', '--context', '.']);
        expect(await f.store.list()).toEqual([]);
    });

    it('preserves context ownership when shutdown authentication fails', async () => {
        const f = await fixture();
        const broker = await f.create(['--timeout', 'inf']);
        const parsed = new URL(broker);
        parsed.searchParams.set('token', 'wrong');
        await f.store.replace({ kind: 'id', id: 'bad-auth' }, { endpoint: broker }, {
            createOnly: true, ownedConnection: { endpoint: parsed.toString() },
        });
        const before = await readFile(f.storeFile, 'utf8');
        const result = await f.run(['context', 'remove', '--context', 'id:bad-auth']);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('failed to stop connection owned by context id:bad-auth');
        expect(await readFile(f.storeFile, 'utf8')).toBe(before);
        expect(f.active()).toBe(1);
    });

    it.each(['rpc connection create --timeout i', 'hub connection create --ttl i', 'rpc connect --ttl i'])(
        'completes unlimited limits: %s', async line => {
            expect(await complete({ line, point: line.length }))
                .toEqual([{ text: 'inf', tooltip: 'Unlimited (no timer).' }]);
        },
    );
});
