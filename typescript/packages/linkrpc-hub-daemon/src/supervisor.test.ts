import { afterEach, expect, it, vi } from 'vitest';
import { ManagedServiceSchema } from './config';
import { ServiceSupervisor, type ServiceHost } from './supervisor';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    try { for (const dispose of cleanup.splice(0).reverse()) await dispose(); }
    finally { vi.unstubAllEnvs(); }
});

it('runs plain stdio without provisioning RPC or inheriting ambient connection credentials', async () => {
    for (const key of ['LINKRPC_ENDPOINT', 'LINKRPC_TOKEN', 'HUBRPC_ENDPOINT', 'HUBRPC_TOKEN']) {
        vi.stubEnv(key, 'must-not-inherit');
    }
    const openSocket = vi.fn<ServiceHost['openSocket']>().mockRejectedValue(new Error('No RPC socket should be opened'));
    let stdout = '';
    const supervisor = new ServiceSupervisor('plain', {
        ...ManagedServiceSchema.parse({
            rpc: false,
            command: [process.execPath, '-e', `
                setTimeout(() => console.log(JSON.stringify([
                    process.env.LINKRPC_ENDPOINT, process.env.LINKRPC_TOKEN,
                    process.env.HUBRPC_ENDPOINT, process.env.HUBRPC_TOKEN,
                    process.env.EXPLICIT_VALUE,
                ])), 100);
                setInterval(() => {}, 1000);
            `],
            env: { EXPLICIT_VALUE: 'preserved' },
            startTimeoutMs: 20,
            stopTimeoutMs: 20,
        }),
        serviceId: 'test/plain',
    }, {
        openSocket,
        log: () => {},
        output: (_name, stream, text) => { if (stream === 'stdout') stdout += text; },
    }, () => {});
    cleanup.push(() => supervisor.dispose());
    await supervisor.sync();
    await vi.waitFor(() => expect(stdout).toBe('[null,null,null,null,"preserved"]\n'));
    expect(openSocket).not.toHaveBeenCalled();
    expect(supervisor.status()).toMatchObject({ state: 'running', connections: 0, restarts: 0 });
});
