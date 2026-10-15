import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, nativeImage, Tray } from 'electron';
import { autorun } from '@vscode/observables';
import { z } from 'zod';
import { DesktopModel } from './desktopModel';
import { homeFromArgs } from './electronLaunch';
import { type DesktopActionName, type DesktopState, IPC_INVOKE, IPC_STATE } from './protocol';
import { type TrayIconState, trayIconPng } from './trayIcon';

const distDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Validates window-supplied parameters; the window is untrusted input. */
const ACTION_PARAMS: Record<DesktopActionName, z.ZodType> = {
    getState: z.undefined(),
    startHub: z.undefined(),
    stopHub: z.undefined(),
    restartHub: z.undefined(),
    setHubAutostart: z.object({ enabled: z.boolean() }),
    setTrayAutostart: z.object({ enabled: z.boolean() }),
    setServiceEnabled: z.object({ name: z.string(), enabled: z.boolean() }),
    restartService: z.object({ name: z.string() }),
    getServiceLogs: z.object({ name: z.string() }),
    getConfig: z.undefined(),
    saveConfig: z.object({ text: z.string(), expectedRevision: z.string() }),
    reloadConfig: z.undefined(),
    openConfigFile: z.undefined(),
    openLogFile: z.undefined(),
};

/** The tray icon, its menu, and the single management window. */
export async function startTrayApp(): Promise<void> {
    if (!app.requestSingleInstanceLock()) {
        app.quit();
        return;
    }
    await app.whenReady();
    app.dock?.hide();
    const model = await DesktopModel.create(homeFromArgs(process.argv));
    const ui = new TrayApp(model);
    app.on('second-instance', () => ui.showWindow());
    app.on('window-all-closed', () => { /* keep running in the tray */ });
    app.on('before-quit', () => model.dispose());
}

class TrayApp {
    private readonly _tray: Tray;
    private _window: BrowserWindow | undefined;

    constructor(private readonly _model: DesktopModel) {
        this._tray = new Tray(_trayImage('stopped'));
        this._tray.on('click', () => this.showWindow());
        ipcMain.handle(IPC_INVOKE, (event, action: unknown, params: unknown) => {
            if (event.sender !== this._window?.webContents) throw new Error('unexpected sender');
            if (typeof action !== 'string' || !Object.hasOwn(ACTION_PARAMS, action)) throw new Error(`unknown action ${String(action)}`);
            const name = action as DesktopActionName;
            const parsed = ACTION_PARAMS[name].parse(params);
            const handler = this._model.actions[name] as (params: unknown) => Promise<unknown>;
            return handler(parsed);
        });
        autorun(reader => {
            const state = this._model.state.read(reader);
            this._window?.webContents.send(IPC_STATE, state);
            this._updateMenu(state);
        });
        autorun(reader => {
            this._tray.setImage(_trayImage(this._model.iconState.read(reader)));
        });
    }

    public showWindow(): void {
        if (!this._window) this._window = this._createWindow();
        if (this._window.isMinimized()) this._window.restore();
        this._window.show();
        this._window.focus();
        app.dock?.show();
    }

    private _createWindow(): BrowserWindow {
        const window = new BrowserWindow({
            width: 980,
            height: 720,
            minWidth: 640,
            minHeight: 420,
            title: 'LinkRPC Hub',
            show: false,
            autoHideMenuBar: true,
            icon: _trayImage('running', 64),
            webPreferences: {
                preload: path.join(distDir, 'preload', 'preload.cjs'),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.webContents.on('did-finish-load', () => window.webContents.send(IPC_STATE, this._model.state.get()));
        window.on('closed', () => {
            this._window = undefined;
            app.dock?.hide();
        });
        void window.loadFile(path.join(distDir, 'renderer', 'index.html'));
        return window;
    }

    private _updateMenu(state: DesktopState): void {
        const running = state.connection === 'connected' && state.status !== undefined;
        const services = state.status?.services ?? [];
        const healthy = services.filter(s => s.state === 'running').length;
        const summary = state.busy
            ?? (running ? `Running · ${healthy}/${services.length} services` : state.connection === 'connecting' ? 'Connecting…' : 'Stopped');
        const actions = this._model.actions;
        const template: MenuItemConstructorOptions[] = [
            { label: `LinkRPC Hub: ${summary}`, enabled: false },
            ...(state.error ? [{ label: `⚠ ${_truncate(state.error, 60)}`, enabled: false }] : []),
            { label: 'Open Hub Manager', click: () => this.showWindow() },
            { type: 'separator' },
            running
                ? { label: 'Stop Hub', enabled: !state.busy, click: () => void actions.stopHub() }
                : { label: 'Start Hub', enabled: !state.busy, click: () => void actions.startHub() },
            { label: 'Restart Hub', enabled: running && !state.busy, click: () => void actions.restartHub() },
            { type: 'separator' },
            {
                label: 'Start Hub at Login',
                type: 'checkbox',
                checked: state.startup.hub,
                click: item => void actions.setHubAutostart({ enabled: item.checked }),
            },
            {
                label: 'Start Tray at Login',
                type: 'checkbox',
                checked: state.startup.tray,
                click: item => void actions.setTrayAutostart({ enabled: item.checked }),
            },
            { type: 'separator' },
            { label: 'Quit Tray (Hub Keeps Running)', click: () => app.quit() },
        ];
        this._tray.setContextMenu(Menu.buildFromTemplate(template));
        this._tray.setToolTip(`LinkRPC Hub — ${summary}`);
    }
}

function _trayImage(state: TrayIconState, size?: number): Electron.NativeImage {
    const template = process.platform === 'darwin' && size === undefined;
    const base = size ?? (process.platform === 'darwin' ? 18 : 16);
    const image = nativeImage.createEmpty();
    for (const scaleFactor of [1, 2]) {
        image.addRepresentation({ scaleFactor, buffer: trayIconPng(state, base * scaleFactor, template) });
    }
    if (template) image.setTemplateImage(true);
    return image;
}

function _truncate(text: string, length: number): string {
    return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
