import * as path from 'node:path';
import { checkExec, type DaemonLaunch, type Exec } from './launch';
import type { AutostartManager } from './autostart';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** Where Task Manager's "Startup apps" toggle records disabled entries. */
const STARTUP_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

/**
 * Windows login autostart through the per-user `Run` key: no elevation, and
 * listed under Task Manager's startup apps. The daemon runs under its own
 * keep-alive watchdog; console executables are hosted by a headless conhost so
 * that no window appears.
 */
export class WindowsRunKeyAutostart implements AutostartManager {
    public readonly description = 'Windows login (HKCU Run key)';
    private readonly _reg: string;
    private readonly _conhost: string;

    constructor(
        private readonly _valueName: string,
        private readonly _exec: Exec,
        systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows',
    ) {
        this._reg = path.win32.join(systemRoot, 'System32', 'reg.exe');
        this._conhost = path.win32.join(systemRoot, 'System32', 'conhost.exe');
    }

    public async isEnabled(): Promise<boolean> {
        const registered = await this._exec(this._reg, ['query', RUN_KEY, '/v', this._valueName]);
        if (registered.code !== 0) return false;
        const approval = await this._exec(this._reg, ['query', STARTUP_APPROVED_KEY, '/v', this._valueName]);
        if (approval.code !== 0) return true;
        const flags = /REG_BINARY\s+([0-9A-F]{2})/i.exec(approval.stdout)?.[1];
        return flags === undefined || (parseInt(flags, 16) & 1) === 0;
    }

    public async enable(launch: DaemonLaunch): Promise<void> {
        checkExec(
            await this._exec(this._reg, ['add', RUN_KEY, '/v', this._valueName, '/t', 'REG_SZ', '/d', this.commandLine(launch), '/f']),
            'registering the login entry',
        );
        await this._exec(this._reg, ['delete', STARTUP_APPROVED_KEY, '/v', this._valueName, '/f']);
    }

    public async disable(): Promise<void> {
        await this._exec(this._reg, ['delete', RUN_KEY, '/v', this._valueName, '/f']);
    }

    public async startManaged(): Promise<boolean> {
        return false;
    }

    /** The `Run` value: keep-alive command line, windowless. */
    public commandLine(launch: DaemonLaunch): string {
        const { executable, args, env } = launch.keepAlive;
        if (Object.keys(env).length > 0) {
            throw new Error('Windows login entries cannot set environment variables; use a launch without env');
        }
        const command = [executable, ...args].map(quoteWindowsArg);
        return (launch.windowless ? command : [quoteWindowsArg(this._conhost), '--headless', ...command]).join(' ');
    }
}

/** Quote one argument for `CommandLineToArgvW`/MSVCRT parsing. */
export function quoteWindowsArg(arg: string): string {
    if (arg !== '' && !/[\s"]/.test(arg)) return arg;
    let quoted = '"';
    let backslashes = 0;
    for (const char of arg) {
        if (char === '\\') {
            backslashes++;
            continue;
        }
        quoted += char === '"' ? '\\'.repeat(backslashes * 2 + 1) + '"' : '\\'.repeat(backslashes) + char;
        backslashes = 0;
    }
    return quoted + '\\'.repeat(backslashes * 2) + '"';
}
