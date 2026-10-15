import { connectToHubManagement } from './client';
import type { AutostartManager } from './autostart/autostart';
import { type DaemonLaunch, spawnDetached } from './autostart/launch';
import { readEndpointDiscovery } from './discovery';
import type { DaemonStatus } from './managementInterface';
import type { HubHome } from './paths';

const POLL_MS = 200;

/** The running daemon's status, or `undefined` when it does not answer. */
export async function queryDaemonStatus(home: HubHome, timeoutMs = 3_000): Promise<DaemonStatus | undefined> {
    let connection: Awaited<ReturnType<typeof connectToHubManagement>> | undefined;
    const attempt = (async () => {
        connection = await connectToHubManagement(home);
        return await connection.management.getStatus({});
    })();
    const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), timeoutMs).unref());
    try {
        return await Promise.race([attempt, timeout]);
    } catch {
        return undefined;
    } finally {
        attempt.catch(() => undefined).finally(() => connection?.close());
    }
}

export interface StartDaemonOptions {
    readonly home: HubHome;
    readonly launch: DaemonLaunch;
    /** Start through the OS manager when it is registered there. */
    readonly autostart?: AutostartManager;
    readonly timeoutMs?: number;
}

/** Start the daemon in the background and wait until it answers. */
export async function startDaemon(options: StartDaemonOptions): Promise<'started' | 'already-running'> {
    if (await queryDaemonStatus(options.home)) return 'already-running';
    if (!await options.autostart?.startManaged()) spawnDetached(options.launch.keepAlive);
    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    while (Date.now() < deadline) {
        if (await queryDaemonStatus(options.home)) return 'started';
        await _sleep(POLL_MS);
    }
    throw new Error(`the hub daemon did not start; see ${options.home.logFile}`);
}

/** Ask the daemon to stop all services and exit, and wait until its process is gone. */
export async function stopDaemon(home: HubHome, timeoutMs = 30_000): Promise<'stopped' | 'not-running'> {
    const pid = readEndpointDiscovery(home.managementFile)?.pid;
    let connection: Awaited<ReturnType<typeof connectToHubManagement>>;
    try {
        connection = await connectToHubManagement(home);
    } catch {
        return 'not-running';
    }
    try {
        await connection.management.shutdown({});
    } finally {
        connection.close();
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pid === undefined ? !await queryDaemonStatus(home) : !_isProcessAlive(pid)) return 'stopped';
        await _sleep(POLL_MS);
    }
    throw new Error(`the hub daemon did not stop within ${timeoutMs} ms`);
}

function _isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
