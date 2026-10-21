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
        output: (_name, stream, data) => { if (stream === 'stdout') stdout += new TextDecoder().decode(data); },
    }, () => {});
    cleanup.push(() => supervisor.dispose());
    await supervisor.sync();
    await vi.waitFor(() => expect(stdout).toBe('[null,null,null,null,"preserved"]\n'));
    expect(openSocket).not.toHaveBeenCalled();
    expect(supervisor.status()).toMatchObject({ state: 'running', connections: 0, restarts: 0 });
});

it('stops a TTY process promptly and reports its exit', async () => {
    const exits: { code: number | null; signal: string | null }[] = [];
    const supervisor = new ServiceSupervisor('tty', {
        ...ManagedServiceSchema.parse({
            rpc: false,
            tty: true,
            // Raw mode keeps the program reading its console until it is killed.
            command: [process.execPath, '-e', 'process.stdin.setRawMode(true); process.stdin.on("data", () => {}); console.log("ready")'],
            stopTimeoutMs: 20,
        }),
        serviceId: 'test/tty',
    }, {
        openSocket: () => Promise.reject(new Error('No RPC socket should be opened')),
        log: () => {},
        processExited: (_name, exit) => exits.push(exit),
    }, () => {});
    await supervisor.sync();
    await vi.waitFor(() => expect(supervisor.status().state).toBe('running'));
    const pid = supervisor.status().pid!;
    const started = performance.now();
    await supervisor.dispose();
    expect(performance.now() - started).toBeLessThan(3000);
    expect(exits).toHaveLength(1);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
});
