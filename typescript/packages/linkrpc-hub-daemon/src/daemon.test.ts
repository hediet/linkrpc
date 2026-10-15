import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connectToHub } from '@hediet/linkrpc/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectToHubManagement, connectToLocalHub, type DaemonStatus, type ServiceStatus } from './client';
import { HubDaemon } from './daemon';
import { HubHome } from './paths';
import { AlreadyRunningError } from './singleInstance';
import { bridgeStdioToLocalHub } from './stdioBridge';
// @ts-expect-error -- plain ESM test fixture without declarations
import { echoInterface } from './test/echoInterface.mjs';

const echoService = fileURLToPath(new URL('./test/echoService.mjs', import.meta.url));

function service(env: Record<string, string>, extra: object = {}): object {
    return { command: [process.execPath, echoService], env, ...extra };
}

async function waitFor<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await probe();
        if (value !== undefined && value !== false) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
}

describe('HubDaemon', () => {
    let dir: string;
    let home: HubHome;
    let daemon: HubDaemon | undefined;

    const serviceStatus = (name: string): ServiceStatus | undefined =>
        daemon!.status().services.find(s => s.name === name);
    const running = (name: string) => waitFor(() => {
        const status = serviceStatus(name);
        return status?.state === 'running' ? status : undefined;
    }, `${name} to run`);
    const writeConfig = (config: object) => fs.writeFileSync(home.configFile, JSON.stringify(config, null, 4));
    const echo = async (name: string): Promise<{ text: string; pid: number; }> => {
        const hub = await connectToLocalHub({ home });
        try {
            return await hub.connection.service(`hub/${name}`).get(echoInterface).echo({ text: 'hi' });
        } finally {
            hub.close();
        }
    };

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrh-'));
        home = HubHome.at(dir);
        daemon = await HubDaemon.start({ home });
    });

    afterEach(async () => {
        await daemon?.shutdown();
        daemon = undefined;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('starts configured services, lets applications call them, and restarts only what changed', async () => {
        writeConfig({ services: { a: service({ ECHO_PREFIX: 'a:' }), b: service({ ECHO_PREFIX: 'b:' }) } });
        const a = await running('a');
        const b = await running('b');
        expect(await echo('a')).toEqual({ text: 'a:hi', pid: a.pid });
        expect(await echo('b')).toEqual({ text: 'b:hi', pid: b.pid });

        writeConfig({ services: { a: service({ ECHO_PREFIX: 'a:' }), b: service({ ECHO_PREFIX: 'B:' }) } });
        const restartedB = await waitFor(() => {
            const status = serviceStatus('b');
            return status?.state === 'running' && status.pid !== b.pid ? status : undefined;
        }, 'b to restart');
        expect(await echo('b')).toEqual({ text: 'B:hi', pid: restartedB.pid });
        expect(serviceStatus('a')?.pid).toBe(a.pid);

        writeConfig({ services: { a: service({ ECHO_PREFIX: 'a:' }) } });
        await waitFor(() => serviceStatus('b') === undefined, 'b to be removed');
        expect(serviceStatus('a')?.pid).toBe(a.pid);
    });

    it('keeps the running configuration when the file becomes invalid', async () => {
        writeConfig({ services: { a: service({}) } });
        const a = await running('a');
        fs.appendFileSync(home.configFile, '\n}}');
        const error = await waitFor(() => daemon!.status().config.error, 'the config error');
        expect(error).toMatch(/invalid JSON/);
        expect(serviceStatus('a')).toMatchObject({ state: 'running', pid: a.pid });
    });

    it('applies restart policies and start timeouts', async () => {
        writeConfig({
            services: {
                never: service({ ECHO_FAIL_AT_START: '1' }, { restart: 'never' }),
                retried: service({ ECHO_FAIL_AT_START: '1' }),
                silent: { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], startTimeoutMs: 300, restart: 'never' },
                spawned: { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], readiness: 'spawned', stopTimeoutMs: 200 },
            },
        });
        expect(await waitFor(() => serviceStatus('never')?.state === 'failed' && serviceStatus('never'), 'never to fail'))
            .toMatchObject({ error: 'exited with code 7', lastExit: { code: 7 } });
        await waitFor(() => (serviceStatus('retried')?.restarts ?? 0) >= 1, 'retried to restart');
        expect(await waitFor(() => serviceStatus('silent')?.state === 'failed' && serviceStatus('silent'), 'silent to fail'))
            .toMatchObject({ error: 'did not connect to the hub within 300 ms' });
        await running('spawned');
    });

    it('passes arguments verbatim and keeps exited one-shot services down on in-place edits', async () => {
        const printArgs = ['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', 'x&echo INJECTED', '%PATH%'];
        writeConfig({ services: { once: { command: printArgs, readiness: 'spawned', restart: 'never' } } });
        const exited = await waitFor(() => serviceStatus('once')?.state === 'stopped' && serviceStatus('once'), 'once to exit');
        expect(daemon!.status().services[0]!.lastExit?.code).toBe(0);
        const connection = await connectToHubManagement(home);
        try {
            const { lines } = await connection.management.getServiceLogs({ name: 'once' });
            expect(lines.filter(line => line.stream === 'stdout').map(line => line.text))
                .toEqual([JSON.stringify(['a b', 'x&echo INJECTED', '%PATH%'])]);
        } finally {
            connection.close();
        }

        writeConfig({ services: { once: { command: printArgs, readiness: 'spawned', restart: 'never', description: 'edited' } } });
        await waitFor(() => serviceStatus('once')?.description === 'edited', 'the description to apply');
        expect(serviceStatus('once')).toMatchObject({ state: 'stopped', lastExit: exited.lastExit });
    });

    it('bridges handshake-free stdio JSON-RPC to the hub unchanged', async () => {
        writeConfig({ services: { a: service({ ECHO_PREFIX: 'a:' }) } });
        const { pid } = await running('a');
        const input = new PassThrough();
        const output = new PassThrough();
        const bridged = bridgeStdioToLocalHub({ home, input, output });
        const response = new Promise<unknown>(resolve => {
            let buffered = '';
            output.on('data', (chunk: Buffer) => {
                buffered += chunk.toString('utf8');
                const newline = buffered.indexOf('\n');
                if (newline >= 0) resolve(JSON.parse(buffered.slice(0, newline)));
            });
        });
        input.write(JSON.stringify({ jsonrpc: '2.0', id: 'vscode-1', method: 'hub/a::test.echo::echo', params: { text: 'hi' } }) + '\n');
        expect(await response).toEqual({ jsonrpc: '2.0', id: 'vscode-1', result: { text: 'a:hi', pid } });
        input.end();
        await bridged;
    });

    it('serves the management API', async () => {
        writeConfig({ services: { a: service({}) } });
        await running('a');
        const connection = await connectToHubManagement(home);
        try {
            const { management } = connection;
            const updates: DaemonStatus[] = [];
            const watch = management.watchStatus({}, { onMessage: status => updates.push(status) });
            const watchEnded = Promise.resolve(watch).catch(() => undefined);

            await management.setServiceEnabled({ name: 'a', enabled: false });
            expect(serviceStatus('a')?.state).toBe('disabled');
            expect(fs.readFileSync(home.configFile, 'utf8')).toContain('"enabled": false');
            await waitFor(() => updates.some(u => u.services[0]?.state === 'disabled'), 'a streamed status update');

            await management.setServiceEnabled({ name: 'a', enabled: true });
            await running('a');
            const before = serviceStatus('a')!.pid;
            await management.restartService({ name: 'a' });
            expect((await running('a')).pid).not.toBe(before);
            expect((await management.getServiceLogs({ name: 'a' })).lines.map(l => l.text))
                .toContain(`echo service ${before} starting`);

            const document = await management.getConfig({});
            await expect(management.setConfig({ text: '{ "services": 1 }', expectedRevision: document.revision })).rejects.toThrow();
            await expect(management.setConfig({ text: '{}', expectedRevision: 'stale' })).rejects.toThrow(/changed since/);
            await management.setConfig({ text: '{}', expectedRevision: document.revision });
            expect(daemon!.status().services).toEqual([]);
            watch.cancel();
            await watchEnded;
        } finally {
            connection.close();
        }
    });

    it('needs no token by default and enforces a configured one', async () => {
        writeConfig({ services: { a: service({ ECHO_PREFIX: 'a:' }) } });
        await running('a');
        expect(JSON.parse(fs.readFileSync(home.discoveryFile, 'utf8')).token).toBeUndefined();
        const endpoint = daemon!.status().endpoint;
        const plain = await connectToHub({ endpoint, token: '' });
        try {
            expect((await plain.connection.service('hub/a').get(echoInterface).echo({ text: 'x' })).text).toBe('a:x');
        } finally {
            plain.close();
        }

        writeConfig({ localEndpoint: { token: 'secret' }, services: { a: service({ ECHO_PREFIX: 'a:' }) } });
        await waitFor(() => JSON.parse(fs.readFileSync(home.discoveryFile, 'utf8')).token === 'secret', 'the token to apply');
        await running('a');
        await expect(connectToHub({ endpoint, token: '' })).rejects.toThrow();
        expect((await echo('a')).text).toBe('a:hi');
    });

    it('listens on a fixed endpoint that the config can change', async () => {
        expect(daemon!.status().endpoint).toBe(home.defaultAppEndpoint);
        const custom = process.platform === 'win32'
            ? `\\\\.\\pipe\\linkrpc-hub-test-${path.basename(dir)}`
            : path.join(home.runtimeDir, 'custom.sock');
        writeConfig({ localEndpoint: { path: custom }, services: { a: service({ ECHO_PREFIX: 'a:' }) } });
        await running('a');
        expect(daemon!.status().endpoint).toBe(custom);
        expect(JSON.parse(fs.readFileSync(home.discoveryFile, 'utf8')).endpoint).toBe(custom);
        const hub = await connectToHub({ endpoint: custom, token: '' });
        try {
            expect((await hub.connection.service('hub/a').get(echoInterface).echo({ text: 'x' })).text).toBe('a:x');
        } finally {
            hub.close();
        }
    });

    it('owns its home exclusively and cleans up on shutdown', async () => {
        await expect(HubDaemon.start({ home })).rejects.toBeInstanceOf(AlreadyRunningError);
        writeConfig({ services: { a: service({}) } });
        const { pid } = await running('a');
        expect(fs.existsSync(home.discoveryFile)).toBe(true);

        await daemon!.shutdown();
        daemon = undefined;
        expect([fs.existsSync(home.discoveryFile), fs.existsSync(home.managementFile)]).toEqual([false, false]);
        await waitFor(() => {
            try {
                process.kill(pid!, 0);
                return undefined;
            } catch {
                return true;
            }
        }, 'the service process to exit');
        await expect(connectToLocalHub({ home })).rejects.toThrow(/not running/);
        daemon = await HubDaemon.start({ home });
    });
});
