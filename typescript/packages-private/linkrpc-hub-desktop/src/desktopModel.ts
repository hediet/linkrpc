import * as os from 'node:os';
import * as path from 'node:path';
import { app, shell } from 'electron';
import { derived, type IObservable, observableValue } from '@vscode/observables';
import {
    type AutostartManager,
    connectToHubManagement,
    createAutostartManager,
    type DaemonLaunch,
    type DaemonStatus,
    type HubHome,
    type HubManagementConnection,
    startDaemon,
    stopDaemon,
    XdgAutostart,
} from '@hediet/linkrpc-hub-daemon';
import { appArgs, electronDaemonLaunch, homeArgs } from './electronLaunch';
import type { DesktopActions, DesktopState, StartupState } from './protocol';
import type { TrayIconState } from './trayIcon';

const RECONNECT_MS = 1_500;

/**
 * The tray app's view of the local hub: a management connection that
 * reconnects while the daemon starts and stops, startup registrations, and
 * the actions the tray menu and the window invoke.
 */
export class DesktopModel {
    public static async create(home: HubHome): Promise<DesktopModel> {
        const model = new DesktopModel(home, await createAutostartManager({ home }), electronDaemonLaunch(home));
        await model._refreshStartup();
        void model._connectLoop();
        return model;
    }

    public readonly connection = observableValue<DesktopState['connection']>(this, 'connecting');
    public readonly status = observableValue<DaemonStatus | undefined>(this, undefined);
    public readonly startup = observableValue<StartupState>(this, { hub: false, tray: false, hubMechanism: '' });
    public readonly busy = observableValue<string | undefined>(this, undefined);
    public readonly error = observableValue<string | undefined>(this, undefined);

    public readonly state: IObservable<DesktopState> = derived(this, reader => ({
        connection: this.connection.read(reader),
        status: this.status.read(reader),
        startup: this.startup.read(reader),
        busy: this.busy.read(reader),
        error: this.error.read(reader),
    }));

    public readonly iconState: IObservable<TrayIconState> = derived(this, reader => {
        const status = this.status.read(reader);
        if (this.connection.read(reader) !== 'connected' || !status) return 'stopped';
        const unhealthy = status.config.error || status.hub.error
            || status.services.some(s => s.state === 'failed' || s.state === 'backoff');
        return unhealthy ? 'warning' : 'running';
    });

    private readonly _trayLogin: TrayLoginItem;
    private _management: HubManagementConnection | undefined;
    private _wake: (() => void) | undefined;
    private _disposed = false;

    private constructor(
        public readonly home: HubHome,
        private readonly _autostart: AutostartManager,
        private readonly _launch: DaemonLaunch,
    ) {
        this._trayLogin = new TrayLoginItem([...appArgs(), ...homeArgs(home)]);
    }

    /** Handlers for every {@link DesktopActions} member, used by IPC and the tray menu. */
    public readonly actions: { [K in keyof DesktopActions]: (...params: Parameters<DesktopActions[K]>) => Promise<ReturnType<DesktopActions[K]>> } = {
        getState: async () => this.state.get(),
        startHub: () => this._run('Starting the hub…', async () => {
            await startDaemon({ home: this.home, launch: this._launch, autostart: this._autostart });
            this._wake?.();
        }),
        stopHub: () => this._run('Stopping the hub…', async () => {
            await stopDaemon(this.home);
        }),
        restartHub: () => this._run('Restarting the hub…', async () => {
            await stopDaemon(this.home);
            await startDaemon({ home: this.home, launch: this._launch, autostart: this._autostart });
            this._wake?.();
        }),
        setHubAutostart: ({ enabled }) => this._run(undefined, async () => {
            if (enabled) await this._autostart.enable(this._launch);
            else await this._autostart.disable();
            await this._refreshStartup();
        }),
        setTrayAutostart: ({ enabled }) => this._run(undefined, async () => {
            await this._trayLogin.set(enabled);
            await this._refreshStartup();
        }),
        setServiceEnabled: ({ name, enabled }) => this._run(undefined, async () => {
            await this._requireManagement().setServiceEnabled({ name, enabled });
        }),
        restartService: ({ name }) => this._run(undefined, async () => {
            await this._requireManagement().restartService({ name });
        }),
        getServiceLogs: async ({ name }) => (await this._requireManagement().getServiceLogs({ name, limit: 500 })).lines,
        getConfig: () => this._requireManagement().getConfig({}),
        saveConfig: params => this._requireManagement().setConfig(params),
        reloadConfig: () => this._run(undefined, async () => {
            await this._requireManagement().reloadConfig({});
        }),
        openConfigFile: async () => {
            const error = await shell.openPath(this.home.configFile);
            if (error) throw new Error(error);
        },
        openLogFile: async () => {
            const error = await shell.openPath(this.home.logFile);
            if (error) throw new Error(error);
        },
    };

    public dispose(): void {
        this._disposed = true;
        this._wake?.();
        this._management?.close();
    }

    private _requireManagement(): HubManagementConnection['management'] {
        if (!this._management) throw new Error('The hub is not running.');
        return this._management.management;
    }

    /** Run a user action, reporting progress and failures in the state. */
    private async _run(busy: string | undefined, action: () => Promise<void>): Promise<void> {
        this.error.set(undefined, undefined);
        if (busy) this.busy.set(busy, undefined);
        try {
            await action();
        } catch (error) {
            this.error.set(error instanceof Error ? error.message : String(error), undefined);
        } finally {
            if (busy) this.busy.set(undefined, undefined);
        }
    }

    private async _refreshStartup(): Promise<void> {
        this.startup.set({
            hub: await this._autostart.isEnabled(),
            tray: await this._trayLogin.get(),
            hubMechanism: this._autostart.description,
        }, undefined);
    }

    private async _connectLoop(): Promise<void> {
        while (!this._disposed) {
            try {
                const connection = await connectToHubManagement(this.home);
                const closed = new Promise<void>(resolve => connection.onClose(resolve));
                this._management = connection;
                this.connection.set('connected', undefined);
                connection.management.watchStatus({}, { onMessage: status => this.status.set(status, undefined) })
                    .catch(() => { /* ends with the connection */ });
                await closed;
            } catch {
                /* not running; retry below */
            }
            this._management = undefined;
            this.status.set(undefined, undefined);
            this.connection.set('stopped', undefined);
            await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, RECONNECT_MS);
                this._wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
            this._wake = undefined;
        }
    }
}

/** Starts the tray app at login: Electron login items, or XDG autostart on Linux. */
class TrayLoginItem {
    private readonly _xdg = process.platform === 'linux'
        ? new XdgAutostart(
            path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'linkrpc-hub-tray.desktop'),
            'LinkRPC Hub Tray',
        )
        : undefined;

    constructor(private readonly _args: string[]) { }

    public async get(): Promise<boolean> {
        if (this._xdg) return this._xdg.isEnabled();
        return app.getLoginItemSettings({ args: this._args }).openAtLogin;
    }

    public async set(enabled: boolean): Promise<void> {
        if (this._xdg) {
            if (enabled) this._xdg.enableCommand({ executable: process.execPath, args: this._args, env: {} });
            else await this._xdg.disable();
            return;
        }
        app.setLoginItemSettings({ openAtLogin: enabled, args: this._args });
    }
}
