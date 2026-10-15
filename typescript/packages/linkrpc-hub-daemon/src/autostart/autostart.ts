import * as os from 'node:os';
import * as path from 'node:path';
import type { HubHome } from '../paths';
import { type DaemonLaunch, type Exec, execCommand } from './launch';
import { LaunchdAutostart } from './launchd';
import { SystemdUserAutostart, XdgAutostart } from './linux';
import { WindowsRunKeyAutostart } from './windows';

/**
 * Registers the daemon to start at user login. Enabling or disabling never
 * starts or stops a running daemon.
 */
export interface AutostartManager {
    /** Human-readable mechanism, e.g. "systemd user service". */
    readonly description: string;
    isEnabled(): Promise<boolean>;
    enable(launch: DaemonLaunch): Promise<void>;
    disable(): Promise<void>;
    /**
     * Start the daemon through the OS manager, so that it supervises this
     * instance too. Resolves `false` when the mechanism cannot (or is not
     * registered to) start it; the caller then starts it directly.
     */
    startManaged(): Promise<boolean>;
}

export interface AutostartOptions {
    readonly home: HubHome;
    readonly platform?: NodeJS.Platform;
    readonly exec?: Exec;
    readonly homedir?: string;
    readonly env?: NodeJS.ProcessEnv;
}

/** The login-autostart mechanism of this platform. */
export async function createAutostartManager(options: AutostartOptions): Promise<AutostartManager> {
    const platform = options.platform ?? process.platform;
    const exec = options.exec ?? execCommand;
    const homedir = options.homedir ?? os.homedir();
    const env = options.env ?? process.env;
    const name = options.home.instanceName;
    if (platform === 'win32') return new WindowsRunKeyAutostart(name, exec);
    if (platform === 'darwin') {
        const label = `dev.hediet.${name}`;
        const uid = process.getuid?.() ?? 0;
        return new LaunchdAutostart(label, path.posix.join(homedir, 'Library', 'LaunchAgents', `${label}.plist`), exec, uid);
    }
    const configHome = env.XDG_CONFIG_HOME || path.posix.join(homedir, '.config');
    if ((await exec('systemctl', ['--user', 'show-environment'])).code === 0) {
        return new SystemdUserAutostart(`${name}.service`, path.posix.join(configHome, 'systemd', 'user', `${name}.service`), exec);
    }
    return new XdgAutostart(path.posix.join(configHome, 'autostart', `${name}.desktop`), 'LinkRPC Hub');
}
