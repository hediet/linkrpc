/**
 * Sleep prevention for the Node.js compute node. Every lease is its own helper
 * process that holds the platform's sleep-prevention request from printing
 * `ready` until its stdin closes. Stopping the helper releases the request, and
 * because the compute node owns the helper's stdin, so does the compute node
 * exiting for any reason, including being killed.
 */
import { spawn } from 'node:child_process';
import type { ComputeNodeKeepAwakeEvent, ComputeNodeKeepAwakeResult } from './index';

export interface SleepInhibitorOptions {
    readonly displayOn: boolean;
    readonly reason: string;
}

/** A helper process that holds a sleep-prevention request from printing `ready` until its stdin closes. */
export interface SleepInhibitorCommand {
    readonly mechanism: string;
    readonly command: string;
    readonly args: readonly string[];
}

/** The helper command that keeps `platform` awake, or an error if the platform has none. */
export function sleepInhibitorCommand(options: SleepInhibitorOptions, platform: NodeJS.Platform = process.platform): SleepInhibitorCommand {
    switch (platform) {
        case 'darwin':
            return {
                mechanism: 'caffeinate',
                command: 'caffeinate',
                args: [options.displayOn ? '-di' : '-i', ...HOLD_UNTIL_STDIN_CLOSES],
            };
        case 'win32':
            return {
                mechanism: 'SetThreadExecutionState',
                command: 'powershell.exe',
                args: [
                    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                    '-EncodedCommand', Buffer.from(windowsHelperScript(options.displayOn), 'utf16le').toString('base64'),
                ],
            };
        case 'linux':
            // `idle` also asks desktops that honor logind inhibitors not to blank the screen,
            // so there is nothing more to request for `displayOn`.
            return {
                mechanism: 'systemd-inhibit',
                command: 'systemd-inhibit',
                args: ['--what=idle:sleep', '--who=LinkRPC compute node', `--why=${options.reason}`, '--mode=block', ...HOLD_UNTIL_STDIN_CLOSES],
            };
        default:
            throw new Error(`Keeping the machine awake is not supported on ${platform}.`);
    }
}

/**
 * Hold `inhibitor` until `signal` aborts or `maxDurationMs` elapses, then stop
 * it and resolve once it has exited. `onActive` is called once the request is
 * in effect. Rejects if the helper cannot be started or exits on its own.
 */
export function holdSleepInhibitor(
    inhibitor: SleepInhibitorCommand,
    maxDurationMs: number | undefined,
    signal: AbortSignal,
    onActive: (event: ComputeNodeKeepAwakeEvent) => void,
): Promise<ComputeNodeKeepAwakeResult> {
    return new Promise((resolve, reject) => {
        const helper = spawn(inhibitor.command, inhibitor.args, { stdio: 'pipe', windowsHide: true });
        let stdout = '';
        let stderr = '';
        let active = false;
        let release: ComputeNodeKeepAwakeResult['reason'] | undefined;
        let expiry: NodeJS.Timeout | undefined;
        let settled = false;

        const stop = (reason: ComputeNodeKeepAwakeResult['reason']): void => {
            release ??= reason;
            helper.stdin.end();
            helper.kill();
        };
        const onAbort = (): void => stop('cancelled');
        const settle = (): void => {
            settled = true;
            clearTimeout(expiry);
            signal.removeEventListener('abort', onAbort);
        };

        helper.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            if (active || release !== undefined) return;
            stdout += chunk;
            if (!/^ready\r?$/m.test(stdout)) return;
            active = true;
            if (maxDurationMs !== undefined) expiry = setTimeout(() => stop('expired'), maxDurationMs);
            onActive({ type: 'active', mechanism: inhibitor.mechanism, helperPid: helper.pid! });
        });
        helper.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            if (stderr.length < MAX_HELPER_STDERR_CHARS) stderr += chunk;
        });
        helper.stdin.on('error', () => { /* the helper exited; its exit is handled below */ });
        helper.once('error', (error: NodeJS.ErrnoException) => {
            if (settled) return;
            settle();
            reject(error.code === 'ENOENT'
                ? new Error(`Keeping the machine awake needs ${inhibitor.command}, which was not found.`)
                : error);
        });
        helper.once('exit', code => {
            if (settled) return;
            settle();
            if (release !== undefined) {
                resolve({ reason: release });
                return;
            }
            const when = active ? 'while holding the sleep-prevention request' : 'before holding the sleep-prevention request';
            const details = stderr.trim();
            reject(new Error(`${inhibitor.mechanism} helper exited ${when} (exit code ${code})${details ? `: ${details}` : '.'}`));
        });

        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
}

const MAX_HELPER_STDERR_CHARS = 4_096;

/** Prints `ready` from inside a parent that holds the request, then waits for stdin to close. */
const HOLD_UNTIL_STDIN_CLOSES = ['/bin/sh', '-c', 'echo ready; exec cat >/dev/null'];

/**
 * SetThreadExecutionState holds the request only while the calling thread
 * lives, so the script blocks that thread reading stdin.
 */
function windowsHelperScript(displayOn: boolean): string {
    const ES_CONTINUOUS = 0x8000_0000;
    const ES_SYSTEM_REQUIRED = 0x1;
    const ES_DISPLAY_REQUIRED = 0x2;
    const flags = ES_CONTINUOUS + ES_SYSTEM_REQUIRED + (displayOn ? ES_DISPLAY_REQUIRED : 0);
    return [
        `$ErrorActionPreference = 'Stop'`,
        `Add-Type -Namespace LinkRpc -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
        `if ([LinkRpc.Power]::SetThreadExecutionState([uint32]${flags}) -eq 0) { throw 'SetThreadExecutionState failed' }`,
        `[Console]::Out.WriteLine('ready')`,
        `[void][Console]::In.ReadToEnd()`,
    ].join('\n');
}
