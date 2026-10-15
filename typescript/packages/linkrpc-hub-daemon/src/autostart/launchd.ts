import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AutostartManager } from './autostart';
import { checkExec, type DaemonLaunch, type Exec } from './launch';

/**
 * macOS login autostart through a per-user LaunchAgent. launchd restarts the
 * daemon after crashes but not after an intentional (exit code 0) stop.
 */
export class LaunchdAutostart implements AutostartManager {
    public readonly description = 'macOS LaunchAgent';

    constructor(
        private readonly _label: string,
        private readonly _plistPath: string,
        private readonly _exec: Exec,
        private readonly _uid: number,
    ) { }

    public async isEnabled(): Promise<boolean> {
        return fs.existsSync(this._plistPath);
    }

    /** Registers for the next login; does not start the daemon now. */
    public async enable(launch: DaemonLaunch): Promise<void> {
        fs.mkdirSync(path.dirname(this._plistPath), { recursive: true });
        fs.writeFileSync(this._plistPath, launchdPlist(this._label, launch));
    }

    /** Unregisters; a running daemon keeps running. */
    public async disable(): Promise<void> {
        fs.rmSync(this._plistPath, { force: true });
    }

    public async startManaged(): Promise<boolean> {
        if (!fs.existsSync(this._plistPath)) return false;
        const domain = `gui/${this._uid}`;
        const kickstart = await this._exec('launchctl', ['kickstart', `${domain}/${this._label}`]);
        if (kickstart.code === 0) return true;
        checkExec(await this._exec('launchctl', ['bootstrap', domain, this._plistPath]), 'launchctl bootstrap');
        return true;
    }
}

export function launchdPlist(label: string, launch: DaemonLaunch): string {
    const { executable, args, env } = launch.foreground;
    const strings = (values: readonly string[]) => values.map(v => `        <string>${_xml(v)}</string>`).join('\n');
    const envEntries = Object.entries(env)
        .map(([key, value]) => `        <key>${_xml(key)}</key>\n        <string>${_xml(value)}</string>`)
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${_xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${strings([executable, ...args])}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`;
}

function _xml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
