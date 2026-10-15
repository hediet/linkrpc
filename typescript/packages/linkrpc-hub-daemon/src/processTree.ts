import { spawn } from 'node:child_process';
import * as path from 'node:path';

/**
 * Whether children get their own process group, so that the whole tree can be
 * signalled. Windows has no process groups; `taskkill /T` walks the tree.
 */
export const SPAWN_DETACHED = process.platform !== 'win32';

/** Ask a service's process tree to exit (POSIX only; Windows has no equivalent). */
export function terminateProcessTree(pid: number): void {
    if (process.platform === 'win32') return;
    _signalGroup(pid, 'SIGTERM');
}

/** Forcefully end a process and all of its descendants. */
export function killProcessTree(pid: number): Promise<void> {
    if (process.platform !== 'win32') {
        _signalGroup(pid, 'SIGKILL');
        return Promise.resolve();
    }
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    return new Promise(resolve => {
        const child = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        child.once('error', () => resolve());
        child.once('exit', () => resolve());
    });
}

function _signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch { /* already gone */ }
    }
}
