import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LinkRpcConnection, defineInterface, requestType } from '@hediet/linkrpc';
import { connectNdjson } from '@hediet/linkrpc/node';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { HubConfigSchema } from './config';
import { runHub } from './engine/runHub';
import { hostParticipant } from './participantHost';

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

describe('hostParticipant', () => {
    it('claims a hub namespace, serves calls, and disposes on cancellation', async () => {
        const socketPath = join(process.cwd(), `host-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
        const hub = await runHub({ config: makeHubConfig(socketPath), log: () => { } });
        const abort = new AbortController();
        let cleaned = 0;
        try {
            const host = await hostParticipant({
                transport: { type: 'hub', endpoint: socketPath, token: 'host-test-token' },
                signal: abort.signal,
                setup: ({ connection, serviceId }) => {
                    expect(serviceId).toBe('host-test');
                    const registration = connection.register(echo, {
                        echo: ({ value }) => ({ value }),
                    }, { serviceId });
                    return { dispose: () => { registration.dispose(); cleaned++; } };
                },
            });
            expect(host.serviceId).toBe('host-test');
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
            expect(host.signal.aborted).toBe(true);
            expect(cleaned).toBe(1);
        } finally {
            hub.dispose();
        }
    });

    it('rejects explicit namespaces outside the hub grant before setup', async () => {
        const socketPath = join(process.cwd(), `host-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
        const hub = await runHub({ config: makeHubConfig(socketPath), log: () => { } });
        try {
            await expect(hostParticipant({
                transport: {
                    type: 'hub',
                    endpoint: socketPath,
                    token: 'host-test-token',
                    serviceId: 'unrelated',
                },
                setup: () => { throw new Error('setup must not run'); },
            })).rejects.toThrow(/outside the hub-granted namespace/);
            const childHost = await hostParticipant({
                transport: {
                    type: 'hub',
                    endpoint: socketPath,
                    token: 'host-test-token',
                    serviceId: 'host-test/child',
                },
                setup: ({ serviceId }) => { expect(serviceId).toBe('host-test/child'); },
            });
            await childHost.dispose();
            await childHost.done;
        } finally {
            hub.dispose();
        }
    });

    it('releases setup resources when the hub disconnects', async () => {
        const socketPath = join(process.cwd(), `host-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
        const hub = await runHub({ config: makeHubConfig(socketPath), log: () => { } });
        let cleaned = 0;
        try {
            const host = await hostParticipant({
                transport: { type: 'hub', endpoint: socketPath, token: 'host-test-token' },
                setup: () => ({ [Symbol.asyncDispose]: async () => { cleaned++; } }),
            });
            hub.dispose();
            await host.done;
            expect(host.signal.aborted).toBe(true);
            expect(cleaned).toBe(1);
        } finally {
            hub.dispose();
        }
    });

    it('serves at the stdio root and shuts down when stdin closes', async () => {
        const script = `
            import { hostParticipant } from './src/participantHost.ts';
            import { defineInterface, requestType } from '@hediet/linkrpc';
            import { z } from 'zod';
            const echo = defineInterface(
                { id: 'participant.echo', description: 'Participant host test' },
                { echo: requestType(z.object({ value: z.string() }), z.object({ value: z.string() })) },
            );
            const host = await hostParticipant({
                transport: { type: 'stdio' },
                setup: ({ connection, serviceId }) => {
                    if (serviceId !== undefined) throw Error('stdio must use root');
                    return connection.register(echo, { echo: ({ value }) => ({ value }) });
                },
            });
            await host.done;
        `;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
            cwd: process.cwd(),
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
                    transport: { type: 'stdio' },
                    signal: abort.signal,
                    setup: () => {},
                });
                if (${JSON.stringify(stop)} === 'abort') abort.abort();
                else await host.dispose();
                await host.done;
                if (events.some((event, i) => process.stdin.listenerCount(event) !== baseline[i])) {
                    throw new Error('host left stdin listeners behind');
                }
            `;
            const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
                cwd: process.cwd(),
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            try {
                await Promise.race([
                    new Promise<void>((resolve, reject) => {
                        child.once('error', reject);
                        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
                    }),
                    new Promise<never>((_resolve, reject) => {
                        setTimeout(() => reject(new Error('stdio child remained alive after shutdown')), 2_000).unref();
                    }),
                ]);
            } finally {
                if (child.exitCode === null) child.kill();
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
            }
        },
    );
});
