import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { cliScript } from '../packageInfo';
import type { HubHome } from '../paths';

/** A process to start: executable, arguments, and extra environment. */
export interface LaunchCommand {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
}

/** How to run the daemon, as registered with the OS. */
export interface DaemonLaunch {
    /** The daemon in the foreground, for OS managers that restart it on failure (launchd, systemd). */
    readonly foreground: LaunchCommand;
    /** The daemon under its own crash-restart watchdog, for launchers without supervision. */
    readonly keepAlive: LaunchCommand;
    /** The keep-alive executable opens no console window (a GUI-subsystem binary on Windows). */
    readonly windowless: boolean;
}

/**
 * Run the daemon with this Node.js runtime and the package's CLI script. The
 * executable is resolved through symlinks: version managers (fnm, nvm, volta)
 * expose per-shell paths that do not survive a logout.
 */
export function nodeDaemonLaunch(home: HubHome, executable: string = fs.realpathSync(process.execPath), env: Readonly<Record<string, string>> = {}): DaemonLaunch {
    const run = [cliScript(), ...(home.customDir !== undefined ? ['--home', home.customDir] : []), 'run', '--quiet'];
    return {
        foreground: { executable, args: run, env },
        keepAlive: { executable, args: [...run, '--keep-alive'], env },
        windowless: false,
    };
}

/** Start `command` detached from this process, without a console window. */
export function spawnDetached(command: LaunchCommand): void {
    const child = spawn(command.executable, command.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ...command.env },
    });
    child.on('error', () => { /* surfaced by the readiness wait */ });
    child.unref();
}

export interface ExecResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>;

/** Run a short-lived command and capture its output. Never rejects. */
export const execCommand: Exec = (file, args) => new Promise(resolve => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', error => resolve({ code: -1, stdout, stderr: error.message }));
    child.once('close', code => resolve({ code: code ?? -1, stdout, stderr }));
});

export function checkExec(result: ExecResult, what: string): void {
    if (result.code !== 0) throw new Error(`${what} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
}
