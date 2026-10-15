import { spawn } from 'node:child_process';

const MIN_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;
/** A run this long resets the restart delay. */
const STABLE_RUN_MS = 60_000;

/**
 * Run the daemon as a child and restart it after crashes, for launchers that
 * do not supervise (Windows login entries, detached starts). Exit code 0 is an
 * intentional stop (or a duplicate daemon) and ends the watchdog too.
 */
export async function runWithKeepAlive(
    executable: string,
    args: readonly string[],
    log: (line: string) => void,
): Promise<number> {
    let delay = MIN_RESTART_DELAY_MS;
    let stopping = false;
    let current: ReturnType<typeof spawn> | undefined;
    const stop = (signal: NodeJS.Signals) => {
        stopping = true;
        current?.kill(signal);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        while (true) {
            const startedAt = Date.now();
            const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true });
            current = child;
            const code = await new Promise<number>(resolve => {
                child.once('error', error => {
                    log(`cannot start the daemon: ${error.message}`);
                    resolve(1);
                });
                child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
            });
            current = undefined;
            if (stopping || code === 0) return code;
            if (Date.now() - startedAt > STABLE_RUN_MS) delay = MIN_RESTART_DELAY_MS;
            log(`the daemon exited with code ${code}; restarting in ${delay} ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
            if (stopping) return code;
            delay = Math.min(delay * 2, MAX_RESTART_DELAY_MS);
        }
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}
