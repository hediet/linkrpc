import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ErrorCode, LinkRpcConnection, RpcError, defineInterface, directoryInterface, requestType } from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import { connectNdjson, startEndpoint, type StartedEndpoint } from '@hediet/linkrpc/node';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubConfigSchema } from './config';
import { runHub } from './engine/runHub';
import { hostParticipant, type ParticipantHostHandle } from './participantHost';

const echo = defineInterface(
    { id: 'participant.echo', description: 'Participant host test' },
    { echo: requestType(z.object({ value: z.string() }), z.object({ value: z.string() })) },
);

function makeHubConfig(path: string) {
    return HubConfigSchema.parse({
        forwardChecking: false,
        listeners: [{
            type: 'socket',
            path,
            handlers: [{ token: 'static', value: 'host-test-token', grantedServiceId: 'host-test' }],
        }],
    });
}

function socketPath(): string {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\host-${randomUUID()}`
        : join(process.cwd(), `host-${randomUUID()}.sock`);
}

const hosts: ParticipantHostHandle[] = [];
const endpoints: StartedEndpoint[] = [];

async function openPeer(setup: (connection: LinkRpcConnection) => void = () => {}) {
    let connected!: (connection: LinkRpcConnection) => void;
    const connection = new Promise<LinkRpcConnection>(resolve => { connected = resolve; });
    const endpoint = await startEndpoint({
        endpoint: 'listen:ws://127.0.0.1:0/rpc',
        token: 'secret',
        onConnection: peer => {
            const rpc = new LinkRpcConnection(peer.channel);
            setup(rpc);
            connected(rpc);
        },
    });
    endpoints.push(endpoint);
    return { endpoint: { endpoint: endpoint.endpoint, token: 'secret' }, connection };
}

afterEach(async () => {
    await Promise.all(hosts.splice(0).map(host => host.dispose()));
    for (const endpoint of endpoints.splice(0)) {
        endpoint.dispose();
        await endpoint.closed;
    }
    vi.unstubAllEnvs();
});

describe('hostParticipant', () => {
    it.each(['all', 'root', 'grantedServiceId'] as const)(
        'registers exactly the addresses selected by %s and disposes them together',
        async registrationMode => {
            const get = vi.fn(() => ({ grantedServiceIdNamespace: 'test/service' }));
            const register = vi.fn((_params: { serviceId: string }) => ({}));
            const peer = await openPeer(connection => connection.register(hubGrantedServiceIdInterface, {
                get, register, getHubServiceId: () => ({ hubServiceId: 'hub' }),
            }));
            let unregister!: () => void;
            let count = 0;
            const host = await hostParticipant({
                endpoint: peer.endpoint,
                registrationMode,
                setup: ({ services, serviceId }) => {
                    expect(serviceId).toBe(registrationMode === 'root' ? undefined : 'test/service');
                    const registration = services.register(echo, {
                        echo: ({ value }) => ({ value: `${value}:${++count}` }),
                    });
                    unregister = () => registration.dispose();
                },
            });
            hosts.push(host);
            const connection = await peer.connection;
            const root = connection.get(echo);
            const named = connection.get(echo, { serviceId: 'test/service' });
            if (registrationMode === 'grantedServiceId') {
                await expect(root.echo({ value: 'root' })).rejects.toMatchObject({ code: ErrorCode.methodNotFound });
            } else {
                expect(await root.echo({ value: 'root' })).toEqual({ value: 'root:1' });
            }
            if (registrationMode === 'root') {
                expect(get).not.toHaveBeenCalled();
                expect(register).not.toHaveBeenCalled();
                await expect(named.echo({ value: 'named' })).rejects.toMatchObject({ code: ErrorCode.methodNotFound });
            } else {
                expect(register).toHaveBeenCalledOnce();
                expect(register.mock.calls[0]?.[0]).toEqual({ serviceId: 'test/service' });
                expect(await named.echo({ value: 'named' })).toEqual({
                    value: `named:${registrationMode === 'all' ? 2 : 1}`,
                });
            }
            unregister();
            unregister();
            await expect(root.echo({ value: 'root' })).rejects.toMatchObject({ code: ErrorCode.methodNotFound });
            await expect(named.echo({ value: 'named' })).rejects.toMatchObject({ code: ErrorCode.methodNotFound });
        },
    );

    it.each(['missing', 'empty'] as const)('handles a %s grant according to policy', async grant => {
        const peer = await openPeer(connection => {
            if (grant === 'empty') connection.register(hubGrantedServiceIdInterface, {
                get: () => ({ grantedServiceIdNamespace: '' }),
                getHubServiceId: () => ({ hubServiceId: 'hub' }),
                register: () => { throw new Error('must not claim'); },
            });
        });
        hosts.push(await hostParticipant({
            endpoint: peer.endpoint, registrationMode: 'all',
            setup: ({ services, serviceId }) => {
                expect(serviceId).toBeUndefined();
                services.register(echo, { echo: value => value });
            },
        }));
        expect(await (await peer.connection).get(echo).echo({ value: 'direct' })).toEqual({ value: 'direct' });
        const setup = vi.fn();
        await expect(hostParticipant({
            endpoint: peer.endpoint, registrationMode: 'grantedServiceId', setup,
        })).rejects.toThrow('did not grant');
        expect(setup).not.toHaveBeenCalled();
    });

    it.each(['query', 'claim'] as const)('propagates %s errors instead of falling back to root', async failure => {
        const peer = await openPeer(connection => connection.register(hubGrantedServiceIdInterface, {
            get: () => {
                if (failure === 'query') throw new RpcError('query denied', -32001);
                return { grantedServiceIdNamespace: 'test' };
            },
            getHubServiceId: () => ({ hubServiceId: 'hub' }),
            register: () => { throw new RpcError('claim denied', ErrorCode.methodNotFound); },
        }));
        const setup = vi.fn();
        await expect(hostParticipant({
            endpoint: peer.endpoint, registrationMode: 'all', setup,
        })).rejects.toThrow(`${failure} denied`);
        expect(setup).not.toHaveBeenCalled();
    });

    it('rejects malformed namespace responses', async () => {
        const endpoint = await startEndpoint({
            endpoint: 'listen:ws://127.0.0.1:0', token: 'secret',
            onConnection: peer => peer.channel.setRequestHandler({
                handleRequest: async () => ({ result: { grantedServiceIdNamespace: 123 } }),
                handleNotification: () => {},
            }),
        });
        endpoints.push(endpoint);
        const setup = vi.fn();
        await expect(hostParticipant({
            endpoint: { endpoint: endpoint.endpoint, token: 'secret' },
            registrationMode: 'all', setup,
        })).rejects.toThrow();
        expect(setup).not.toHaveBeenCalled();
    });

    it.each([undefined, { type: 'fromEnv' } as const])('reads endpoint and token from the environment (%j)', async selection => {
        const peer = await openPeer();
        vi.stubEnv('LINKRPC_ENDPOINT', peer.endpoint.endpoint);
        vi.stubEnv('LINKRPC_TOKEN', peer.endpoint.token);
        hosts.push(await hostParticipant({
            endpoint: selection, registrationMode: 'all',
            setup: ({ services }) => { services.register(echo, { echo: value => value }); },
        }));
        expect(await (await peer.connection).get(echo).echo({ value: 'env' })).toEqual({ value: 'env' });
    });

    it('fails without endpoint configuration and rejects a service ID in root mode', async () => {
        vi.stubEnv('LINKRPC_ENDPOINT', '');
        // @ts-expect-error registrationMode is required for every caller.
        await expect(hostParticipant({ setup: () => {} })).rejects.toThrow('registrationMode must be');
        await expect(hostParticipant({ registrationMode: 'root', setup: () => {} })).rejects.toThrow('LINKRPC_ENDPOINT');
        await expect(hostParticipant({
            registrationMode: 'root', serviceId: 'ignored', setup: () => {},
        })).rejects.toThrow('serviceId requires');
    });

    it.each(['websocket', 'socket'])('accepts multiple %s peers with independent setup and cleanup', async kind => {
        const contexts: AbortSignal[] = [];
        let cleaned = 0;
        const host = await hostParticipant({
            endpoint: {
                endpoint: kind === 'websocket' ? 'listen:ws://127.0.0.1:0' : `listen:${socketPath()}`,
                token: 'secret',
            },
            registrationMode: 'all',
            setup: ({ services, signal }) => {
                contexts.push(signal);
                let count = 0;
                services.register(echo, { echo: ({ value }) => ({ value: `${value}:${++count}` }) });
                return { [Symbol.asyncDispose]: async () => { cleaned++; } };
            },
        });
        hosts.push(host);
        let finished = false;
        void host.done.then(() => { finished = true; });
        for (let i = 0; i < 2; i++) {
            let connection!: LinkRpcConnection;
            const client = await hostParticipant({
                endpoint: { endpoint: host.endpoint, token: 'secret' },
                registrationMode: 'all',
                setup: context => { connection = context.connection; },
            });
            hosts.push(client);
            expect(await connection.get(echo).echo({ value: 'peer' })).toEqual({ value: 'peer:1' });
            await client.dispose();
            await vi.waitFor(() => expect(cleaned).toBe(i + 1));
            expect(contexts[i].aborted).toBe(true);
        }
        expect(finished).toBe(false);
        await host.dispose();
        expect(finished).toBe(true);
    });

    it('rolls back named registration when root registration conflicts', async () => {
        const peer = await openPeer(connection => connection.register(hubGrantedServiceIdInterface, {
            get: () => ({ grantedServiceIdNamespace: 'test' }),
            getHubServiceId: () => ({ hubServiceId: 'hub' }),
            register: () => ({}),
        }));
        hosts.push(await hostParticipant({
            endpoint: peer.endpoint, registrationMode: 'all',
            setup: ({ connection, services }) => {
                connection.register(echo, { echo: () => ({ value: 'original' }) });
                expect(() => services.register(echo, { echo: value => value })).toThrow('already registered');
            },
        }));
        const connection = await peer.connection;
        expect(await connection.get(echo).echo({ value: '' })).toEqual({ value: 'original' });
        await expect(connection.get(echo, { serviceId: 'test' }).echo({ value: '' }))
            .rejects.toMatchObject({ code: ErrorCode.methodNotFound });
    });

    it('cancels pending setup and awaits its async cleanup', async () => {
        const peer = await openPeer();
        const abort = new AbortController();
        let cleaned = false;
        let entered!: () => void;
        const setupStarted = new Promise<void>(resolve => { entered = resolve; });
        const starting = hostParticipant({
            endpoint: peer.endpoint, registrationMode: 'all', signal: abort.signal,
            setup: async ({ signal }) => {
                entered();
                await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
                return { [Symbol.asyncDispose]: async () => { cleaned = true; } };
            },
        });
        const rejected = expect(starting).rejects.toThrow();
        await setupStarted;
        abort.abort();
        await rejected;
        expect(cleaned).toBe(true);
    });

    it('keeps immediate service calls queued while discovering the namespace and setting up', async () => {
        let result!: Promise<{ value: string }>;
        const peer = await openPeer(connection => {
            connection.register(hubGrantedServiceIdInterface, {
                get: () => ({ grantedServiceIdNamespace: 'test' }),
                getHubServiceId: () => ({ hubServiceId: 'hub' }),
                register: () => ({}),
            });
            result = connection.get(echo, { serviceId: 'test' }).echo({ value: 'early' });
        });
        hosts.push(await hostParticipant({
            endpoint: peer.endpoint, registrationMode: 'all',
            setup: async ({ services }) => {
                await new Promise(resolve => setTimeout(resolve, 10));
                services.register(echo, { echo: value => value });
            },
        }));
        expect(await result).toEqual({ value: 'early' });
    });

    it('reflects both addresses and removes both when disposed', async () => {
        const peer = await openPeer(connection => connection.register(hubGrantedServiceIdInterface, {
            get: () => ({ grantedServiceIdNamespace: 'test' }),
            getHubServiceId: () => ({ hubServiceId: 'hub' }),
            register: () => ({}),
        }));
        let unregister!: () => void;
        hosts.push(await hostParticipant({
            endpoint: peer.endpoint, registrationMode: 'all',
            setup: ({ services, connection }) => {
                connection.enableReflection();
                const registration = services.register(echo, { echo: value => value }, { serviceDescription: 'Test' });
                unregister = () => registration.dispose();
            },
        }));
        const directory = (await peer.connection).get(directoryInterface);
        const result = await directory.list({ interfaceId: echo.info.id });
        expect(result.items).toEqual([
            expect.objectContaining({ serviceId: 'test', serviceDescription: 'Test' }),
            expect.objectContaining({ serviceId: '' }),
        ]);
        expect(result.items[1].serviceDescription).toBeUndefined();
        unregister();
        expect(await directory.list({ interfaceId: echo.info.id })).toEqual({ items: [] });
    });

    it('isolates failed listener setup and cleans up healthy peers', async () => {
        const failure = new Error('setup failed');
        const onError = vi.fn();
        let attempts = 0;
        const host = await hostParticipant({
            endpoint: { endpoint: 'listen:ws://127.0.0.1:0', token: 'secret' },
            registrationMode: 'all', onError,
            setup: ({ services }) => {
                services.register(echo, { echo: value => value });
                if (++attempts === 1) throw failure;
            },
        });
        hosts.push(host);
        for (let i = 0; i < 2; i++) {
            let connection!: LinkRpcConnection;
            const client = await startEndpoint({
                endpoint: host.endpoint, token: 'secret',
                onConnection: peer => { connection = new LinkRpcConnection(peer.channel); },
            });
            endpoints.push(client);
            if (i === 0) {
                await client.closed;
                expect(onError).toHaveBeenCalledWith(failure);
            } else {
                expect(await connection.get(echo).echo({ value: 'healthy' })).toEqual({ value: 'healthy' });
            }
        }
        expect(onError).toHaveBeenCalledOnce();
    });

    it('reports async cleanup failures and rejects shutdown', async () => {
        const peer = await openPeer();
        const onError = vi.fn();
        const failure = new Error('cleanup failed');
        const host = await hostParticipant({
            endpoint: peer.endpoint, registrationMode: 'root', onError,
            setup: () => ({ [Symbol.asyncDispose]: async () => { throw failure; } }),
        });
        await expect(host.dispose()).rejects.toMatchObject({ errors: [failure] });
        await expect(host.done).rejects.toThrow('Participant cleanup failed');
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    });

    it('rejects managed signing without a provisioned identity instead of running unsigned', async () => {
        const peer = await openPeer();
        const setup = vi.fn();
        await expect(hostParticipant({
            endpoint: peer.endpoint, registrationMode: 'root', managedIdentity: true, setup,
        })).rejects.toThrow();
        expect(setup).not.toHaveBeenCalled();
    });

    it.each([false, true])('aborts a pending bootstrap (managedIdentity=%s)', async managedIdentity => {
        const abort = new AbortController();
        let requested!: () => void;
        const requestStarted = new Promise<void>(resolve => { requested = resolve; });
        const endpoint = await startEndpoint({
            endpoint: 'listen:ws://127.0.0.1:0', token: 'secret',
            onConnection: peer => peer.channel.setRequestHandler({
                handleRequest: async () => {
                    requested();
                    await peer.closed;
                    return { result: null };
                },
                handleNotification: () => {},
            }),
        });
        endpoints.push(endpoint);
        const setup = vi.fn();
        const starting = hostParticipant({
            endpoint: { endpoint: endpoint.endpoint, token: 'secret' },
            registrationMode: 'all', managedIdentity, signal: abort.signal, setup,
        });
        const rejected = expect(starting).rejects.toThrow();
        await requestStarted;
        abort.abort();
        await rejected;
        expect(setup).not.toHaveBeenCalled();
    });

    it('claims a hub namespace, serves calls, and disposes on cancellation', async () => {
        const path = socketPath();
        const hub = await runHub({ config: makeHubConfig(path), log: () => { } });
        const abort = new AbortController();
        let cleaned = 0;
        let signal: AbortSignal | undefined;
        try {
            const host = await hostParticipant({
                endpoint: { endpoint: path, token: 'host-test-token' },
                registrationMode: 'all',
                signal: abort.signal,
                setup: ({ services, serviceId, signal: peerSignal }) => {
                    signal = peerSignal;
                    expect(serviceId).toBe('host-test');
                    const registration = services.register(echo, {
                        echo: ({ value }) => ({ value }),
                    });
                    return { dispose: () => { registration.dispose(); cleaned++; } };
                },
            });
            const peer = hub.hub.attachOut();
            const connection = LinkRpcConnection.fromTransport(peer.transport);
            try {
                expect(await connection.get(echo, { serviceId: 'host-test' }).echo({ value: 'hello' }))
                    .toEqual({ value: 'hello' });
            } finally {
                connection.close();
                peer.dispose();
            }
            abort.abort();
            await host.done;
            await host.dispose();
            expect(signal?.aborted).toBe(true);
            expect(cleaned).toBe(1);
        } finally {
            hub.dispose();
        }
    });

    it('rejects explicit namespaces outside the hub grant before setup', async () => {
        const path = socketPath();
        const hub = await runHub({ config: makeHubConfig(path), log: () => { } });
        try {
            await expect(hostParticipant({
                endpoint: {
                    endpoint: path,
                    token: 'host-test-token',
                },
                registrationMode: 'grantedServiceId',
                serviceId: 'unrelated',
                setup: () => { throw new Error('setup must not run'); },
            })).rejects.toThrow(/outside the hub-granted namespace/);
            const childHost = await hostParticipant({
                endpoint: {
                    endpoint: path,
                    token: 'host-test-token',
                },
                registrationMode: 'grantedServiceId',
                serviceId: 'host-test/child',
                setup: ({ serviceId }) => { expect(serviceId).toBe('host-test/child'); },
            });
            await childHost.dispose();
            await childHost.done;
        } finally {
            hub.dispose();
        }
    });

    it('releases setup resources when the hub disconnects', async () => {
        const path = socketPath();
        const hub = await runHub({ config: makeHubConfig(path), log: () => { } });
        let cleaned = 0;
        let signal: AbortSignal | undefined;
        try {
            const host = await hostParticipant({
                endpoint: { endpoint: path, token: 'host-test-token' },
                registrationMode: 'all',
                setup: ({ signal: peerSignal }) => {
                    signal = peerSignal;
                    return { [Symbol.asyncDispose]: async () => { cleaned++; } };
                },
            });
            hub.dispose();
            await host.done;
            expect(signal?.aborted).toBe(true);
            expect(cleaned).toBe(1);
        } finally {
            hub.dispose();
        }
    });

    it.each(['explicit', 'fromEnv', 'default'])('serves %s stdio and shuts down when stdin closes', async mode => {
        const script = `
            import { hostParticipant } from './src/participantHost.ts';
            import { defineInterface, requestType } from '@hediet/linkrpc';
            import { z } from 'zod';
            const echo = defineInterface(
                { id: 'participant.echo', description: 'Participant host test' },
                { echo: requestType(z.object({ value: z.string() }), z.object({ value: z.string() })) },
            );
            const host = await hostParticipant({
                ${mode === 'default' ? '' : `endpoint: { type: '${mode === 'explicit' ? 'stdio' : 'fromEnv'}' },`}
                registrationMode: 'all',
                setup: ({ services, serviceId }) => {
                    if (serviceId !== undefined) throw Error('stdio must use root');
                    return services.register(echo, { echo: ({ value }) => ({ value }) });
                },
            });
            await host.done;
        `;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
            cwd: process.cwd(),
            env: { ...process.env, LINKRPC_ENDPOINT: mode === 'explicit' ? 'invalid:override' : 'stdio:' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        try {
            const { transport } = await connectNdjson({ input: child.stdout, output: child.stdin });
            const connection = LinkRpcConnection.fromTransport(transport);
            expect(await connection.get(echo).echo({ value: 'root' })).toEqual({ value: 'root' });
            child.stdin.end();
            await new Promise<void>((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
            });
            connection.close();
        } finally {
            if (child.exitCode === null) child.kill();
        }
    });

    it.each(['dispose', 'abort'] as const)(
        'lets a stdio child exit after %s while its parent keeps stdin open',
        async (stop) => {
            const script = `
                import { hostParticipant } from './src/participantHost.ts';
                const abort = new AbortController();
                const events = ['data', 'end', 'close', 'error'];
                const baseline = events.map(event => process.stdin.listenerCount(event));
                const host = await hostParticipant({
                    endpoint: { type: 'stdio' },
                    registrationMode: 'root',
                    signal: abort.signal,
                    setup: () => {},
                });
                process.send('ready');
                await new Promise(resolve => process.once('message', resolve));
                process.disconnect();
                if (${JSON.stringify(stop)} === 'abort') abort.abort();
                else await host.dispose();
                await host.done;
                if (events.some((event, i) => process.stdin.listenerCount(event) !== baseline[i])) {
                    throw new Error('host left stdin listeners behind');
                }
            `;
            const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
                cwd: process.cwd(),
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            });
            try {
                await new Promise<void>((resolve, reject) => {
                    let ready = false;
                    let deadline: NodeJS.Timeout | undefined;
                    child.once('error', reject);
                    child.once('message', message => {
                        if (message !== 'ready') {
                            reject(new Error(`Unexpected stdio child handshake: ${String(message)}`));
                            return;
                        }
                        ready = true;
                        deadline = setTimeout(
                            () => reject(new Error('stdio child remained alive after shutdown')),
                            2_000,
                        );
                        deadline.unref();
                        child.send('shutdown', error => { if (error) reject(error); });
                    });
                    child.once('exit', code => {
                        clearTimeout(deadline);
                        if (!ready) reject(new Error(`stdio child exited before readiness (${code})`));
                        else if (code !== 0) reject(new Error(`child exited ${code}`));
                        else resolve();
                    });
                });
            } finally {
                if (child.exitCode === null) child.kill();
                child.stdin?.destroy();
                child.stdout?.destroy();
                child.stderr?.destroy();
            }
        },
        15_000,
    );
});
