import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineInterface, requestType, LinkRpcConnection, type InterfaceClient } from '@hediet/linkrpc';
import { connectToHub, formatEndpointUri } from '@hediet/linkrpc/node';
import {
    CONSOLE_INTERFACE_TAG,
    decodeConsoleData,
    encodeConsoleData,
    type ConsoleServerMessage,
    type ConsoleSize,
} from '@hediet/linkrpc-infra/console';
import { SocketServer } from '@hediet/linkrpc-hub/hub/server/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubDaemon } from './daemon';
import { HubHome } from './paths';
import { readEndpointDiscovery } from './discovery';
import { managedEndpointsInterface, type EndpointStatus, type RunEvent } from './endpointInterface';
import * as autostart from './autostart/autostart';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

type EndpointsClient = InterfaceClient<typeof managedEndpointsInterface>;

async function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-endpoints-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
    const home = HubHome.at(dir);
    let daemon = await HubDaemon.start({ home });
    cleanup.push(() => daemon.shutdown());
    const connection = async () => {
        const discovery = readEndpointDiscovery(home.managementFile)!;
        const handle = await connectToHub({ endpoint: discovery.endpoint, token: discovery.token! });
        cleanup.push(() => handle.close());
        return handle.connection;
    };
    const connect = async () => (await connection()).get(managedEndpointsInterface);
    const restart = async () => {
        await daemon.shutdown();
        daemon = await HubDaemon.start({ home });
        return connect();
    };
    return { home, connect, restart, daemon };
}

async function status(client: EndpointsClient, id: string, state: EndpointStatus['runtime']['state']) {
    let result: EndpointStatus | undefined;
    await vi.waitFor(async () => {
        result = (await client.list({ namespace: 'test' })).find(value => value.id === id);
        expect(result?.runtime.state).toBe(state);
    }, { timeout: 15_000 });
    return result!;
}

const processSource = (script = 'setInterval(() => {}, 1000)', options: { rpc?: boolean; tty?: boolean } = {}) => ({
    kind: 'process' as const, command: [process.execPath, '-e', script], readiness: 'spawned' as const, env: {},
    rpc: options.rpc ?? true, tty: options.tty ?? false,
});
const defaults = { namespace: 'test', id: 'main', persistent: false as const, restart: 'never' as const };
const address = { namespace: 'test', id: 'main' };
const text = (value: string) => encodeConsoleData(new TextEncoder().encode(value));

function outputText(messages: readonly (ConsoleServerMessage | RunEvent)[], stream: 'stdout' | 'tty' = 'stdout'): string {
    return messages.flatMap(message => message.t === 'output' && message.stream === stream
        ? [new TextDecoder().decode(decodeConsoleData(message.data))] : []).join('');
}

/** Terminal output without control sequences, so assertions do not depend on ConPTY's rendering. */
function screenText(value: string): string {
    // eslint-disable-next-line no-control-regex
    return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, '').replace(/\r/g, '');
}

function run(
    client: EndpointsClient,
    definition: Parameters<EndpointsClient['run']>[0]['definition'],
    options: { owner?: boolean; replace?: boolean; size?: ConsoleSize } = {},
) {
    const events: RunEvent[] = [];
    const call = client.run({
        definition, owner: options.owner ?? false, replace: options.replace ?? false,
        console: options.size ? { size: options.size } : {},
    }, { onMessage: event => { events.push(event); } });
    return { call, events, settled: call.then(result => result, (error: unknown) => error) };
}

type ConsolesClient = EndpointsClient['consoles'];

/** Attach to an endpoint's console through the management interface's `consoles` template instance. */
function attach(consoles: ConsolesClient, status: EndpointStatus, options: Omit<Parameters<ConsolesClient['attach']>[0], 'params'> = {}) {
    const messages: ConsoleServerMessage[] = [];
    const call = consoles.attach({ ...options, params: { namespace: status.namespace, id: status.id } }, { onMessage: message => { messages.push(message); } });
    return { call, messages, settled: call.then(result => result, (error: unknown) => error) };
}

describe('managed endpoint RPC', { timeout: 30_000 }, () => {
    it.each([false, true])('removes foreground work when the owner disconnects (routed: %s)', async routed => {
        const f = await fixture();
        const observer = await f.connect();
        const discovery = readEndpointDiscovery(routed ? f.home.discoveryFile : f.home.managementFile)!;
        const owner = await connectToHub({ endpoint: discovery.endpoint, token: discovery.token ?? '' });
        cleanup.push(() => owner.close());
        const client = owner.connection.get(managedEndpointsInterface, routed ? { serviceId: 'hub/daemon' } : {});
        const foreground = run(client, { ...defaults, restart: 'always', source: processSource() }, { owner: true });
        const running = await status(observer, 'main', 'running');
        expect(running).toMatchObject({ owned: true, console: { mode: 'pipe' } });
        await expect(observer.configure({ ...address, persistent: true })).rejects.toThrow(/foreground/);
        const observation = attach(observer.consoles, running);
        await vi.waitFor(() => expect(observation.messages.at(-1)).toEqual({ t: 'live' }));
        await observation.call.cancel();
        await observation.settled;
        expect((await status(observer, 'main', 'running')).runtime.pid).toBe(running.runtime.pid);
        owner.close();
        await foreground.settled;
        await vi.waitFor(async () => expect(await observer.list({ namespace: 'test' })).toEqual([]), { timeout: 15_000 });
        expect(() => process.kill(running.runtime.pid!, 0)).toThrow();
    });

    it('cancels foreground work explicitly and streams natural completion', async () => {
        const f = await fixture();
        const client = await f.connect();
        const cancelled = run(client, { ...defaults, source: processSource() }, { owner: true });
        await status(client, 'main', 'running');
        await cancelled.call.cancel();
        await cancelled.settled;
        await vi.waitFor(async () => expect(await client.list({ namespace: 'test' })).toEqual([]), { timeout: 15_000 });
        const completed = run(client, { ...defaults, source: processSource('console.log("foreground-done"); process.exitCode = 7') }, { owner: true });
        expect(await completed.call).toEqual({ exit: { code: 7, signal: null } });
        expect(outputText(completed.events)).toBe('foreground-done\n');
        expect(completed.events.filter(event => event.t === 'status').at(-1)).toMatchObject({ status: { runtime: { lastExit: { code: 7 } } } });
        expect(await client.list({ namespace: 'test' })).toEqual([]);
    });

    it('runs without ownership: completes with the final output and detaches on cancellation', async () => {
        const f = await fixture();
        const client = await f.connect();
        const fast = run(client, { ...defaults, source: processSource('console.log("final output")') });
        expect(await fast.call).toEqual({ exit: { code: 0, signal: null } });
        expect(outputText(fast.events)).toBe('final output\n');
        const detached = run(client, { ...defaults, source: processSource() });
        const running = await status(client, 'main', 'running');
        await detached.call.cancel();
        await detached.settled;
        expect((await status(client, 'main', 'running')).instanceId).toBe(running.instanceId);
        await client.stop(address);
    });

    it('does not restore foreground endpoints during Hub replacement', async () => {
        const f = await fixture();
        const client = await f.connect();
        const foreground = run(client, { ...defaults, source: processSource() }, { owner: true });
        await status(client, 'main', 'running');
        fs.writeFileSync(f.home.configFile, JSON.stringify({ localEndpoint: { token: 'changed' } }));
        await f.daemon.reload();
        await foreground.settled;
        expect(await client.list({ namespace: 'test' })).toEqual([]);
    });

    it('handles cancellation during startup without removing a duplicate named endpoint', async () => {
        const f = await fixture();
        const client = await f.connect();
        const source = { ...processSource(), readiness: 'connected' as const };
        const starting = run(client, { ...defaults, source }, { owner: true });
        const initial = await status(client, 'main', 'starting');
        await expect(run(client, { ...defaults, source }, { owner: true }).call).rejects.toThrow(/already exists/);
        expect((await status(client, 'main', 'starting')).instanceId).toBe(initial.instanceId);
        await starting.call.cancel();
        await starting.settled;
        await vi.waitFor(async () => expect(await client.list({ namespace: 'test' })).toEqual([]), { timeout: 15_000 });
        expect(() => process.kill(initial.runtime.pid!, 0)).toThrow();
    });

    it('replaces persistent and owned endpoints only when requested', async () => {
        const f = await fixture();
        const client = await f.connect();
        await client.create({ ...defaults, persistent: true, source: processSource() });
        const persistent = await status(client, 'main', 'running');
        await expect(client.create({ ...defaults, source: processSource() })).rejects.toThrow(/already exists/);
        const replaced = await client.create({ ...defaults, source: processSource(), replace: true });
        expect(replaced.instanceId).not.toBe(persistent.instanceId);
        expect(() => process.kill(persistent.runtime.pid!, 0)).toThrow();
        expect(JSON.parse(fs.readFileSync(path.join(f.home.stateDir, 'endpoints.json'), 'utf8'))).toEqual([]);

        const foreground = run(client, { ...defaults, source: processSource() }, { owner: true, replace: true });
        const owned = await vi.waitFor(async () => {
            const current = await status(client, 'main', 'running');
            expect(current.owned).toBe(true);
            return current;
        }, { timeout: 15_000 });
        const replacement = run(client, { ...defaults, source: processSource() }, { replace: true });
        await foreground.settled;
        expect(foreground.events).toContainEqual({ t: 'notice', text: 'Replaced by a new launch of the same endpoint.' });
        const current = await status(client, 'main', 'running');
        expect({ owned: current.owned, replacedOwner: current.instanceId !== owned.instanceId }).toEqual({ owned: false, replacedOwner: true });
        await replacement.call.cancel();
        await replacement.settled;
        expect((await status(client, 'main', 'running')).instanceId).toBe(current.instanceId);
        await client.stop(address);
    });

    it('isolates namespaces, rejects duplicates, and removes ephemeral endpoints on stop', async () => {
        const f = await fixture();
        const client = await f.connect();
        await client.create({ ...defaults, source: processSource() });
        await client.create({ ...defaults, namespace: 'other', source: processSource() });
        await status(client, 'main', 'running');
        await expect(client.create({ ...defaults, source: processSource() })).rejects.toThrow(/already exists/);
        await client.stop(address);
        expect(await client.list({ namespace: 'test' })).toEqual([]);
        expect((await client.list({ namespace: 'other' })).map(value => value.id)).toEqual(['main']);
    });

    it.each([true, false])('shares console output and input, and survives detaching (rpc: %s)', async rpc => {
        const f = await fixture();
        const client = await f.connect();
        const created = await client.create({ ...defaults, source: processSource('process.stdin.on("data", d => process.stdout.write(d))', { rpc }) });
        await status(client, 'main', 'running');
        expect(await client.consoles.info({ params: address })).toMatchObject({ mode: 'pipe', running: true, signals: process.platform === 'win32' ? ['SIGKILL'] : expect.arrayContaining(['SIGINT']) });
        const first = attach(client.consoles, created);
        const second = attach(client.consoles, created, { interactive: false });
        await vi.waitFor(() => expect(second.messages.at(-1)).toEqual({ t: 'live' }));
        await first.call.send({ t: 'input', data: text('roundtrip\n') });
        await vi.waitFor(() => expect(outputText(second.messages)).toBe('roundtrip\n'));
        await first.call.cancel();
        await first.settled;
        await status(client, 'main', 'running');
        await client.stop(address);
        expect(await second.settled).toMatchObject({ exit: expect.anything() });
    });

    it('runs a TTY with resizing, interrupts, and screen replay for late attachments', async () => {
        const f = await fixture();
        const client = await f.connect();
        const script = `
            const size = () => process.stdout.getWindowSize().join('x');
            const probe = "console.log('now=' + process.stdout.getWindowSize().join('x'))";
            console.log('tty=' + process.stdout.isTTY + ' size=' + size());
            process.on('SIGINT', () => { console.log('got SIGINT'); process.exit(3); });
            // A new process reads the current size: Windows Node caches it unless stdin is raw.
            process.stdin.on('data', data => {
                if (String(data).includes('size')) require('child_process').spawnSync(process.execPath, ['-e', probe], { stdio: 'inherit' });
            });`;
        const owner = run(client, { ...defaults, source: processSource(script, { rpc: false, tty: true }) }, { owner: true, size: { cols: 100, rows: 30 } });
        await vi.waitFor(() => expect(screenText(outputText(owner.events, 'tty'))).toContain('tty=true size=100x30'), { timeout: 15_000 });
        const running = await status(client, 'main', 'running');
        expect(running.console?.mode).toBe('tty');

        const late = attach(client.consoles, running, { interactive: false });
        await vi.waitFor(() => expect(late.messages.at(-1)).toEqual({ t: 'live' }));
        expect(late.messages[0]).toMatchObject({ t: 'console', mode: 'tty', size: { cols: 100, rows: 30 }, running: true });
        const screen = late.messages.find(message => message.t === 'screen');
        expect(screen && screenText(new TextDecoder().decode(decodeConsoleData(screen.data)))).toContain('tty=true size=100x30');

        await owner.call.send({ t: 'resize', cols: 70, rows: 20 });
        await vi.waitFor(() => expect(late.messages).toContainEqual({ t: 'resized', cols: 70, rows: 20 }));
        await owner.call.send({ t: 'input', data: text('size\r') });
        await vi.waitFor(() => expect(screenText(outputText(owner.events, 'tty'))).toContain('now=70x20'), { timeout: 10_000 });
        await owner.call.send({ t: 'input', data: text('\x03') });
        expect(await owner.call).toEqual({ exit: { code: 3, signal: null } });
        expect(screenText(outputText(owner.events, 'tty'))).toContain('got SIGINT');
        expect(await late.settled).toEqual({ exit: { code: 3, signal: null } });
    });

    it.each([true, false])('restores desired persistent restart policies but remembers explicit stop (rpc: %s)', async rpc => {
        const startup = vi.spyOn(autostart, 'createAutostartManager').mockImplementation(() => {
            throw new Error('Managed endpoints must not touch OS autostart');
        });
        cleanup.push(() => startup.mockRestore());
        const f = await fixture();
        let client = await f.connect();
        for (const id of ['resume', 'stop', 'never']) {
            await client.create({ ...defaults, id, source: { ...processSource(), rpc }, persistent: true, restart: id === 'never' ? 'never' : 'on-failure' });
            await status(client, id, 'running');
        }
        await client.stop({ namespace: 'test', id: 'stop' });
        client = await f.restart();
        await status(client, 'resume', 'running');
        expect((await client.list({ namespace: 'test' })).map(value => value.rpc)).toEqual([rpc, rpc, rpc]);
        expect((await client.list({ namespace: 'test' })).map(value => [value.id, value.desired, value.runtime.state])).toEqual([
            ['resume', true, 'running'], ['stop', false, 'disabled'], ['never', false, 'disabled'],
        ]);
        await client.start({ namespace: 'test', id: 'never' });
        await status(client, 'never', 'running');
        expect(startup).not.toHaveBeenCalled();
    });

    it('exposes the same API through the Hub and keeps existing management clients across reload', async () => {
        const f = await fixture();
        const client = await f.connect();
        await client.create({ ...defaults, source: processSource() });
        const first = await status(client, 'main', 'running');
        const remote = await connectToHub({ endpoint: f.home.defaultAppEndpoint, token: '' });
        cleanup.push(() => remote.close());
        const routed = remote.connection.get(managedEndpointsInterface, { serviceId: 'hub/daemon' });
        expect((await routed.list({ namespace: 'test' }))[0]?.instanceId).toBe(first.instanceId);
        expect(await routed.consoles.info({ params: address })).toMatchObject({ mode: 'pipe', running: true, pid: first.runtime.pid });
        expect(managedEndpointsInterface.toSchema().tags).toEqual([CONSOLE_INTERFACE_TAG]);
        await expect(routed.consoles.info({ params: { ...address, id: 'missing' } })).rejects.toThrow('Endpoint "missing" not found');
        fs.writeFileSync(f.home.configFile, JSON.stringify({ localEndpoint: { token: 'changed' } }));
        await f.daemon.reload();
        const second = await status(client, 'main', 'running');
        expect(second.runtime.pid).not.toBe(first.runtime.pid);
    });

    it('forwards connections transparently and reconnects after unexpected disconnection', async () => {
        const f = await fixture();
        const client = await f.connect();
        const server = await SocketServer.start();
        cleanup.push(() => server.dispose());
        let current: { dispose(): void } | undefined;
        const echo = defineInterface({ id: 'test.managed.echo' }, { echo: requestType(z.string(), z.string()) });
        const serviceId = `hub/services/${createHash('sha256').update('test').digest('hex')}/main`;
        server.setConnectionHandler(transport => {
            current = transport;
            const connection = LinkRpcConnection.fromTransport(transport);
            connection.register(echo, { echo: value => value }, { serviceId });
        });
        await client.create({
            ...defaults, restart: 'on-failure',
            source: { kind: 'connection', endpoint: formatEndpointUri({ kind: 'socket', path: server.endpoint }) },
        });
        await status(client, 'main', 'running');
        const hub = await connectToHub({ endpoint: f.home.defaultAppEndpoint, token: '' });
        cleanup.push(() => hub.close());
        expect(await hub.connection.get(echo, { serviceId }).echo('forwarded')).toBe('forwarded');
        current!.dispose();
        await vi.waitFor(async () => {
            const endpoint = (await client.list({ namespace: 'test' }))[0]!;
            expect(endpoint.runtime.state).toBe('running');
            expect(endpoint.runtime.restarts).toBe(1);
        }, { timeout: 10_000 });
        await client.stop(address);
        expect(await client.list({ namespace: 'test' })).toEqual([]);
    });
});
