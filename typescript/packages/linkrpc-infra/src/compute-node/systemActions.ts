/**
 * Locking the session and sleeping, restarting, or shutting down the machine
 * for the Node.js compute node. Each action is one platform command, run
 * without a shell and without elevation, as the OS user running the node.
 */
import { spawn } from 'node:child_process';

export type SystemAction = 'lock' | 'sleep' | 'restart' | 'shutdown';

/** The platform command that performs a {@link SystemAction}. */
export interface SystemActionCommand {
    readonly mechanism: string;
    readonly command: string;
    readonly args: readonly string[];
}

/** The command that performs `action` on `platform`, or an error if the platform has none. */
export function systemActionCommand(action: SystemAction, platform: NodeJS.Platform = process.platform): SystemActionCommand {
    const command = PLATFORM_COMMANDS[platform as keyof typeof PLATFORM_COMMANDS]?.[action];
    if (!command) throw new Error(`Action ${action} is not supported on ${platform}.`);
    return command;
}

/**
 * Starts `command` and resolves once it exits successfully, or once it is still
 * running after `settleMs` (Windows sleep, for example, returns only after the
 * machine resumes). Rejects if it cannot start or exits unsuccessfully first.
 */
export function runSystemActionCommand(command: SystemActionCommand, settleMs = 2_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command.command, command.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
        });
        const settle = setTimeout(() => {
            child.stderr.destroy();
            child.unref();
            resolve();
        }, settleMs);
        child.once('error', (error: NodeJS.ErrnoException) => {
            clearTimeout(settle);
            reject(error.code === 'ENOENT' ? new Error(`${command.mechanism} needs ${command.command}, which was not found.`) : error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(settle);
            if (code === 0) {
                resolve();
                return;
            }
            const details = stderr.trim();
            reject(new Error(`${command.mechanism} failed (${code !== null ? `exit code ${code}` : `signal ${signal}`})${details ? `: ${details}` : '.'}`));
        });
    });
}

const MAX_STDERR_CHARS = 4_096;

/**
 * `SACLockScreenImmediate` is what the macOS menu bar's Lock Screen item calls.
 * Calling it through JXA needs no Accessibility or Automation permission.
 */
const MACOS_LOCK_SCRIPT = [
    `ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']]);`,
    `$.dlopen('/System/Library/PrivateFrameworks/login.framework/Versions/Current/login', 10);`,
    `ObjC.bindFunction('SACLockScreenImmediate', ['int', []]);`,
    `$.SACLockScreenImmediate();`,
].join('\n');

function windowsPowerShell(mechanism: string, script: string): SystemActionCommand {
    return {
        mechanism,
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    };
}

const PLATFORM_COMMANDS: Record<'darwin' | 'win32' | 'linux', Record<SystemAction, SystemActionCommand>> = {
    darwin: {
        lock: { mechanism: 'SACLockScreenImmediate', command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', MACOS_LOCK_SCRIPT] },
        sleep: { mechanism: 'pmset sleepnow', command: '/usr/bin/pmset', args: ['sleepnow'] },
        // Asks loginwindow, like the Apple menu does: applications can still ask to save or cancel.
        restart: { mechanism: 'loginwindow restart', command: '/usr/bin/osascript', args: ['-e', 'tell application "loginwindow" to «event aevtrrst»'] },
        shutdown: { mechanism: 'loginwindow shutdown', command: '/usr/bin/osascript', args: ['-e', 'tell application "loginwindow" to «event aevtrsdn»'] },
    },
    win32: {
        lock: { mechanism: 'LockWorkStation', command: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
        sleep: windowsPowerShell('SetSuspendState', [
            `Add-Type -AssemblyName System.Windows.Forms`,
            `if (-not [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)) { throw 'SetSuspendState failed' }`,
        ].join('; ')),
        // Without /f, applications with unsaved work can still block the restart.
        restart: { mechanism: 'shutdown /r', command: 'shutdown.exe', args: ['/r', '/t', '0'] },
        shutdown: { mechanism: 'shutdown /s', command: 'shutdown.exe', args: ['/s', '/t', '0'] },
    },
    linux: {
        lock: { mechanism: 'loginctl lock-session', command: 'loginctl', args: ['lock-session'] },
        sleep: { mechanism: 'systemctl suspend', command: 'systemctl', args: ['suspend'] },
        restart: { mechanism: 'systemctl reboot', command: 'systemctl', args: ['reboot'] },
        shutdown: { mechanism: 'systemctl poweroff', command: 'systemctl', args: ['poweroff'] },
    },
};
