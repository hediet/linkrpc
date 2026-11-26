/**
 * Whether the desktop session of the compute node's user is locked. Every
 * watch is its own helper process that prints `locked` or `unlocked` on a line
 * of its own each time it checks. Stopping the helper ends the watch; if the
 * compute node dies, the helper exits as soon as its output pipe or stdin closes.
 */
import { spawn } from 'node:child_process';
import type { ComputeNodeSessionState } from './index';

/** A helper process that prints `locked` or `unlocked` on its own line every {@link SESSION_STATE_INTERVAL_MS}. */
export interface SessionStateMonitorCommand {
    readonly mechanism: string;
    readonly command: string;
    readonly args: readonly string[];
}

export const SESSION_STATE_INTERVAL_MS = 2_000;

/** The helper command that reports the lock state on `platform`, or an error if the platform has none. */
export function sessionStateMonitorCommand(platform: NodeJS.Platform = process.platform): SessionStateMonitorCommand {
    switch (platform) {
        case 'darwin':
            return { mechanism: 'CGSessionCopyCurrentDictionary', command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', MACOS_MONITOR_SCRIPT] };
        case 'win32':
            return {
                mechanism: 'WTSSessionInfoEx',
                command: 'powershell.exe',
                args: [
                    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                    '-EncodedCommand', Buffer.from(WINDOWS_MONITOR_SCRIPT, 'utf16le').toString('base64'),
                ],
            };
        case 'linux':
            return { mechanism: 'loginctl', command: '/bin/sh', args: ['-c', LINUX_MONITOR_SCRIPT] };
        default:
            throw new Error(`Reading the session lock state is not supported on ${platform}.`);
    }
}

/**
 * Runs `monitor` until `signal` aborts and calls `onState` with the first
 * state and every change. Rejects if the helper cannot be started, prints
 * something unexpected, or exits on its own.
 */
export function watchSessionState(
    monitor: SessionStateMonitorCommand,
    signal: AbortSignal,
    onState: (state: ComputeNodeSessionState) => void,
): Promise<{ reason: 'cancelled'; }> {
    return new Promise((resolve, reject) => {
        const helper = spawn(monitor.command, monitor.args, { stdio: 'pipe', windowsHide: true });
        let pending = '';
        let stderr = '';
        let locked: boolean | undefined;
        let failure: Error | undefined;
        let stopped = false;
        let settled = false;

        const stop = (): void => {
            stopped = true;
            helper.stdin.end();
            helper.kill();
        };
        const fail = (error: Error): void => {
            failure ??= error;
            stop();
        };
        const settle = (): void => {
            settled = true;
            signal.removeEventListener('abort', stop);
        };

        helper.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            if (stopped) return;
            pending += chunk;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop()!;
            for (const line of lines) {
                if (line !== 'locked' && line !== 'unlocked') {
                    fail(new Error(`${monitor.mechanism} helper printed an unexpected line: ${line.slice(0, 200)}`));
                    return;
                }
                if ((line === 'locked') === locked) continue;
                locked = line === 'locked';
                onState({ locked, mechanism: monitor.mechanism });
            }
        });
        helper.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            if (stderr.length < MAX_HELPER_STDERR_CHARS) stderr += chunk;
        });
        helper.stdin.on('error', () => { /* the helper exited; its exit is handled below */ });
        helper.once('error', (error: NodeJS.ErrnoException) => {
            if (settled) return;
            settle();
            reject(error.code === 'ENOENT'
                ? new Error(`Reading the session lock state needs ${monitor.command}, which was not found.`)
                : error);
        });
        helper.once('exit', code => {
            if (settled) return;
            settle();
            if (failure !== undefined) reject(failure);
            else if (stopped) resolve({ reason: 'cancelled' });
            else {
                const details = stderr.trim();
                reject(new Error(`${monitor.mechanism} helper exited (exit code ${code})${details ? `: ${details}` : '.'}`));
            }
        });

        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
    });
}

const MAX_HELPER_STDERR_CHARS = 4_096;

/**
 * A session counts as unlocked only while its screen is unlocked and it is the
 * session on the console; without a login session it counts as locked.
 * Writing to a closed stdout ends the script.
 */
const MACOS_MONITOR_SCRIPT = [
    `ObjC.import('CoreGraphics');`,
    `ObjC.import('Foundation');`,
    `ObjC.bindFunction('CFRelease', ['void', ['void *']]);`,
    `const stdout = $.NSFileHandle.fileHandleWithStandardOutput;`,
    `function isLocked() {`,
    `    const ref = $.CGSessionCopyCurrentDictionary();`,
    `    if (!ref) return true;`,
    `    try {`,
    `        const session = ObjC.castRefToObject(ref);`,
    `        return ObjC.unwrap(session.objectForKey('CGSSessionScreenIsLocked')) === true`,
    `            || ObjC.unwrap(session.objectForKey('kCGSSessionOnConsoleKey')) !== true;`,
    `    } finally {`,
    `        $.CFRelease(ref);`,
    `    }`,
    `}`,
    `for (;;) {`,
    `    stdout.writeData($((isLocked() ? 'locked' : 'unlocked') + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));`,
    `    delay(${SESSION_STATE_INTERVAL_MS / 1_000});`,
    `}`,
].join('\n');

/**
 * Reads `WTSINFOEXW` for the node's own session. Its union is 8-byte aligned,
 * so `SessionState` is at offset 12 and `SessionFlags` at 16. The session
 * counts as unlocked only while it is `WTSActive` (0) and its flags are
 * `WTS_SESSIONSTATE_UNLOCK` (1), so an unknown state counts as locked. The
 * loop ends when stdin closes; `[Console]::In.ReadToEndAsync()` would block,
 * because `Console.In` reads synchronously.
 */
const WINDOWS_MONITOR_SCRIPT = [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -Namespace LinkRpc -Name Wts -MemberDefinition '[DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQuerySessionInformationW(System.IntPtr server, int sessionId, int infoClass, out System.IntPtr buffer, out int bytes); [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(System.IntPtr memory);'`,
    `function Test-Locked {`,
    `    $buffer = [IntPtr]::Zero`,
    `    $bytes = 0`,
    `    if (-not [LinkRpc.Wts]::WTSQuerySessionInformationW([IntPtr]::Zero, -1, 25, [ref]$buffer, [ref]$bytes)) {`,
    `        throw "WTSQuerySessionInformation failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)"`,
    `    }`,
    `    try {`,
    `        $state = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 12)`,
    `        $flags = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 16)`,
    `    } finally {`,
    `        [LinkRpc.Wts]::WTSFreeMemory($buffer)`,
    `    }`,
    `    return $state -ne 0 -or $flags -ne 1`,
    `}`,
    `$stdinClosed = [Console]::OpenStandardInput().ReadAsync((New-Object byte[] 1), 0, 1)`,
    `do {`,
    `    [Console]::Out.WriteLine($(if (Test-Locked) { 'locked' } else { 'unlocked' }))`,
    `} while (-not $stdinClosed.Wait(${SESSION_STATE_INTERVAL_MS}))`,
].join('\n');

/** `auto` is the caller's own session, or its user's graphical session. Writing to a closed stdout ends the loop. */
const LINUX_MONITOR_SCRIPT = [
    `while :; do`,
    `    hint=$(loginctl show-session auto -p LockedHint --value) || exit 1`,
    `    active=$(loginctl show-session auto -p Active --value) || exit 1`,
    `    if [ "$hint" = no ] && [ "$active" = yes ]; then echo unlocked; else echo locked; fi || exit 1`,
    `    sleep ${SESSION_STATE_INTERVAL_MS / 1_000}`,
    `done`,
].join('\n');
