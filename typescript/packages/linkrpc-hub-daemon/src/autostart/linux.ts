import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AutostartManager } from './autostart';
import { checkExec, type DaemonLaunch, type Exec, type LaunchCommand } from './launch';

/**
 * Linux login autostart through a systemd user unit. systemd restarts the
 * daemon after crashes (`Restart=on-failure`) but not after an intentional stop.
 */
export class SystemdUserAutostart implements AutostartManager {
    public readonly description = 'systemd user service';

    constructor(
        private readonly _unitName: string,
        private readonly _unitPath: string,
        private readonly _exec: Exec,
    ) { }

    public async isEnabled(): Promise<boolean> {
        const result = await this._exec('systemctl', ['--user', 'is-enabled', this._unitName]);
        return result.code === 0 && result.stdout.trim() === 'enabled';
    }

    /** Registers for the next login; does not start the daemon now. */
    public async enable(launch: DaemonLaunch): Promise<void> {
        fs.mkdirSync(path.dirname(this._unitPath), { recursive: true });
        fs.writeFileSync(this._unitPath, systemdUnit(launch));
        checkExec(await this._exec('systemctl', ['--user', 'daemon-reload']), 'systemctl daemon-reload');
        checkExec(await this._exec('systemctl', ['--user', 'enable', this._unitName]), 'systemctl enable');
    }

    /** Unregisters; a running daemon keeps running. */
    public async disable(): Promise<void> {
        await this._exec('systemctl', ['--user', 'disable', this._unitName]);
        fs.rmSync(this._unitPath, { force: true });
        await this._exec('systemctl', ['--user', 'daemon-reload']);
    }

    public async startManaged(): Promise<boolean> {
        if (!await this.isEnabled()) return false;
        checkExec(await this._exec('systemctl', ['--user', 'start', this._unitName]), 'systemctl start');
        return true;
    }
}

export function systemdUnit(launch: DaemonLaunch): string {
    const { executable, args, env } = launch.foreground;
    const environment = Object.entries(env).map(([key, value]) => `Environment=${_systemdQuote(`${key}=${value}`)}\n`).join('');
    return `[Unit]
Description=LinkRPC user hub

[Service]
Type=simple
ExecStart=${[executable, ...args].map(_systemdQuote).join(' ')}
${environment}Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/**
 * Linux login autostart through an XDG autostart entry, for desktops without
 * a systemd user instance. Also used for the tray app.
 */
export class XdgAutostart implements AutostartManager {
    public readonly description = 'XDG autostart';

    constructor(
        private readonly _desktopFile: string,
        private readonly _displayName: string,
    ) { }

    public async isEnabled(): Promise<boolean> {
        return fs.existsSync(this._desktopFile);
    }

    public async enable(launch: DaemonLaunch): Promise<void> {
        this.enableCommand(launch.keepAlive);
    }

    public enableCommand(command: LaunchCommand): void {
        fs.mkdirSync(path.dirname(this._desktopFile), { recursive: true });
        fs.writeFileSync(this._desktopFile, xdgDesktopEntry(this._displayName, command));
    }

    public async disable(): Promise<void> {
        fs.rmSync(this._desktopFile, { force: true });
    }

    public async startManaged(): Promise<boolean> {
        return false;
    }
}

export function xdgDesktopEntry(name: string, command: LaunchCommand): string {
    const env = Object.entries(command.env).map(([key, value]) => `${key}=${value}`);
    const argv = [...(env.length > 0 ? ['env', ...env] : []), command.executable, ...command.args];
    return `[Desktop Entry]
Type=Application
Name=${name}
Exec=${argv.map(_desktopExecQuote).join(' ')}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

function _systemdQuote(arg: string): string {
    const escaped = arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$');
    return `"${escaped}"`;
}

/** Desktop Entry `Exec` quoting, then string-value escaping of backslashes. */
function _desktopExecQuote(arg: string): string {
    const percentEscaped = arg.replace(/%/g, '%%');
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(percentEscaped)) return percentEscaped;
    const quoted = `"${percentEscaped.replace(/(["`$\\])/g, '\\$1')}"`;
    return quoted.replace(/\\/g, '\\\\');
}
