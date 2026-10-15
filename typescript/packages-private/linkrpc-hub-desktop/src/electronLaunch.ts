import { app } from 'electron';
import { cliScript, type DaemonLaunch, HubHome, spawnDetached } from '@hediet/linkrpc-hub-daemon';

/** Makes the desktop executable start the hub daemon instead of the tray. */
export const DAEMON_FLAG = '--linkrpc-hub-daemon';

const RUN_AS_NODE = { ELECTRON_RUN_AS_NODE: '1' };

/** Arguments that select this app when running from source (`electron <app>`). */
export function appArgs(): string[] {
    return app.isPackaged ? [] : [app.getAppPath()];
}

/** The `--home` the app was started with; registrations pass it on. */
export function homeFromArgs(argv: readonly string[]): HubHome {
    const index = argv.indexOf('--home');
    const dir = index >= 0 ? argv[index + 1] : undefined;
    return dir !== undefined ? HubHome.at(dir) : HubHome.resolve();
}

/**
 * Run the daemon with Electron's own binary in Node.js mode, so installations
 * need no separate runtime. Windows login entries cannot set the required
 * environment variable, so there the keep-alive launch goes through
 * {@link runDaemonTrampoline} (a GUI binary, hence no console window).
 */
export function electronDaemonLaunch(home: HubHome): DaemonLaunch {
    const run = [cliScript(), ...homeArgs(home), 'run', '--quiet'];
    const foreground = { executable: process.execPath, args: run, env: RUN_AS_NODE };
    if (process.platform === 'win32') {
        return {
            foreground,
            keepAlive: { executable: process.execPath, args: [...appArgs(), DAEMON_FLAG, ...homeArgs(home)], env: {} },
            windowless: true,
        };
    }
    return { foreground, keepAlive: { ...foreground, args: [...run, '--keep-alive'] }, windowless: false };
}

/** `<app> --linkrpc-hub-daemon [--home <dir>]`: start the keep-alive daemon and exit. */
export function runDaemonTrampoline(): void {
    const home = homeFromArgs(process.argv);
    spawnDetached({
        executable: process.execPath,
        args: [cliScript(), ...homeArgs(home), 'run', '--quiet', '--keep-alive'],
        env: RUN_AS_NODE,
    });
    app.exit(0);
}

/** `--home <dir>` for a custom home, so that registered launches use the same home. */
export function homeArgs(home: HubHome): string[] {
    return home.customDir !== undefined ? ['--home', home.customDir] : [];
}
