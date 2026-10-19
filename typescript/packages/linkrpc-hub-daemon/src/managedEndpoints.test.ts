import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineInterface, requestType, LinkRpcConnection, type InterfaceClient } from '@hediet/linkrpc';
import { connectToHub, formatEndpointUri } from '@hediet/linkrpc/node';
import { SocketServer } from '@hediet/linkrpc-hub/hub/server/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubDaemon } from './daemon';
import { HubHome } from './paths';
import { readEndpointDiscovery } from './discovery';
import { managedEndpointsInterface, type EndpointEvent, type EndpointStatus } from './endpointInterface';
import * as autostart from './autostart/autostart';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-endpoints-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
    const home = HubHome.at(dir);
    let daemon = await HubDaemon.start({ home });
    cleanup.push(() => daemon.shutdown());
    const connect = async () => {
        const discovery = readEndpointDiscovery(home.managementFile)!;
        const handle = await connectToHub({ endpoint: discovery.endpoint, token: discovery.token! });
        cleanup.push(() => handle.close());
        return handle.connection.get(managedEndpointsInterface);
    };
    const restart = async () => {
        await daemon.shutdown();
        daemon = await HubDaemon.start({ home });
        return connect();
    };
    return { home, connect, restart, daemon };
}

async function status(client: InterfaceClient<typeof managedEndpointsInterface>, id: string, state: EndpointStatus['runtime']['state']) {
    let result: EndpointStatus | undefined;
    await vi.waitFor(async () => {
        result = (await client.list({ namespace: 'test' })).find(value => value.id === id);
        expect(result?.runtime.state).toBe(state);
    }, { timeout: 15_000 });
    return result!;
}

const processSource = (script = 'setInterval(() => {}, 1000)') => ({
    kind: 'process' as const, command: [process.execPath, '-e', script], readiness: 'spawned' as const, env: {},
});
const defaults = { namespace: 'test', id: 'main', persistent: false as const, restart: 'never' as const };
const address = { namespace: 'test', id: 'main' };

describe('managed endpoint RPC', { timeout: 30_000 }, () => {
    it.each([false, true])('removes foreground work when the owner disconnects (routed: %s)', async routed => {
        const f = await fixture();
        const observer = await f.connect();
        const discovery = readEndpointDiscovery(routed ? f.home.discoveryFile : f.home.managementFile)!;
        const owner = await connectToHub({ endpoint: discovery.endpoint, token: discovery.token ?? '' });
        cleanup.push(() => owner.close());
        const client = owner.connection.get(managedEndpointsInterface, routed ? { serviceId: 'hub/daemon' } : {});
        const run = client.runForeground({ ...defaults, source: processSource(), restart: 'always' }, { onMessage: () => {} });
        const ended = run.catch(() => {});
        const running = await status(observer, 'main', 'running');
        await expect(observer.configure({ ...address, persistent: true })).rejects.toThrow(/foreground/);
        const attach = observer.attach({ ...address, after: 0 }, { onMessage: () => {} });
        const attachedEnded = attach.catch(() => {});
        await attach.cancel();
        await attachedEnded;
        expect((await status(observer, 'main', 'running')).runtime.pid).toBe(running.runtime.pid);
        owner.close();
        await ended;
        await vi.waitFor(async () => expect(await observer.list({ namespace: 'test' })).toEqual([]), { timeout: 15_000 });
        expect(() => process.kill(running.runtime.pid!, 0)).toThrow();
    });

    it('cancels foreground work explicitly and streams natural completion', async () => {
        const f = await fixture();
        const client = await f.connect();
        const run = client.runForeground({ ...defaults, source: processSource() }, { onMessage: () => {} });
        const ended = run.catch(() => {});
        await status(client, 'main', 'running');
        await run.cancel();
        await ended;
        await vi.waitFor(async () => expect(await client.list({ namespace: 'test' })).toEqual([]), { timeout: 15_000 });
        const events: EndpointEvent[] = [];
        await client.runForeground({ ...defaults, source: processSource('console.log("foreground-done"); process.exitCode = 7') }, {
            onMessage: event => { events.push(event); },
        });
        expect(events.flatMap(event => event.type === 'output' && event.stream === 'stdout' ? [event.text] : []).join('')).toBe('foreground-done\n');
        expect(events.filter(event => event.type === 'status').at(-1)?.status.runtime.lastExit?.code).toBe(7);
        expect(await client.list({ namespace: 'test' })).toEqual([]);
    });

    it('does not restore foreground endpoints during Hub replacement', async () => {
        const f = await fixture();
        const client = await f.connect();
        const run = client.runForeground({ ...defaults, source: processSource() }, { onMessage: () => {} });
        const ended = run.catch(() => {});
        await status(client, 'main', 'running');
        fs.writeFileSync(f.home.configFile, JSON.stringify({ localEndpoint: { token: 'changed' } }));
        await f.daemon.reload();
        await ended;
        expect(await client.list({ namespace: 'test' })).toEqual([]);
    });

    it('handles cancellation during startup without removing a duplicate named endpoint', async () => {
        const f = await fixture();
        const client = await f.connect();
        const source = { ...processSource(), readiness: 'connected' as const };
        const run = client.runForeground({ ...defaults, source }, { onMessage: () => {} });
        const ended = run.catch(() => {});
        const starting = await status(client, 'main', 'starting');
        await expect(client.runForeground({ ...defaults, source }, { onMessage: () => {} })).rejects.toThrow(/already exists/);
        expect((await status(client, 'main', 'starting')).instanceId).toBe(starting.instanceId);
        await run.cancel();
        await ended;
        await vi.waitFor(async () => expect(await client.list({ namespace: 'test' })).toEqual([]), { timeout: 15_000 });
        expect(() => process.kill(starting.runtime.pid!, 0)).toThrow();
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

    it('streams output and stdin, survives attach cancellation, and guards stale input', async () => {
        const f = await fixture();
        const client = await f.connect();
        const created = await client.create({ ...defaults, source: processSource('process.stdin.on("data", d => process.stdout.write(d))') });
        await status(client, 'main', 'running');
        const events: EndpointEvent[] = [];
        const watch = client.attach({ ...address, after: 0, instanceId: created.instanceId }, { onMessage: event => { events.push(event); } });
        const ended = watch.catch(() => {});
        await client.input({ ...address, instanceId: created.instanceId, input: { type: 'stdin', data: 'roundtrip\n' } });
        await vi.waitFor(() => expect(events.some(event => event.type === 'output' && event.text.includes('roundtrip'))).toBe(true));
        await watch.cancel();
        await ended;
        await status(client, 'main', 'running');
        await expect(client.input({ ...address, instanceId: 'stale', input: { type: 'stdin', data: 'no' } })).rejects.toThrow(/changed/);
    });

    it('retains final output for a fast ephemeral process by instance ID', async () => {
        const f = await fixture();
        const client = await f.connect();
        const created = await client.create({ ...defaults, source: processSource('console.log("final output")') });
        await vi.waitFor(async () => expect(await client.list({ namespace: 'test' })).toEqual([]));
        const events: EndpointEvent[] = [];
        await client.attach({ ...address, after: 0, instanceId: created.instanceId }, { onMessage: event => { events.push(event); } });
        expect(events.flatMap(event => event.type === 'output' && event.stream === 'stdout' ? [event.text] : []).join('')).toBe('final output\n');
        expect(events.at(-1)).toEqual({ type: 'removed' });
    });

    it('restores desired persistent restart policies but remembers explicit stop', async () => {
        const startup = vi.spyOn(autostart, 'createAutostartManager').mockImplementation(() => {
            throw new Error('Managed endpoints must not touch OS autostart');
        });
        cleanup.push(() => startup.mockRestore());
        const f = await fixture();
        let client = await f.connect();
        for (const id of ['resume', 'stop', 'never']) {
            await client.create({ ...defaults, id, source: processSource(), persistent: true, restart: id === 'never' ? 'never' : 'on-failure' });
            await status(client, id, 'running');
        }
        await client.stop({ namespace: 'test', id: 'stop' });
        client = await f.restart();
        await status(client, 'resume', 'running');
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
