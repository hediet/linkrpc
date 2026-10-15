/**
 * The contract between the main process and the sandboxed management window.
 * Types only: the renderer bundle must not pull in Node.js code.
 */
import type { ConfigDocument, DaemonStatus, LogLine } from '@hediet/linkrpc-hub-daemon/client';

export type { ConfigDocument, DaemonStatus, LogLine, ServiceStatus } from '@hediet/linkrpc-hub-daemon/client';

export interface DesktopState {
    /** `connecting` until the first connection attempt settles. */
    readonly connection: 'connecting' | 'connected' | 'stopped';
    readonly status: DaemonStatus | undefined;
    readonly startup: StartupState;
    /** The action in progress, e.g. "Starting the hub…". */
    readonly busy: string | undefined;
    /** The last failed action. */
    readonly error: string | undefined;
}

export interface StartupState {
    readonly hub: boolean;
    readonly tray: boolean;
    /** How the hub is started at login, e.g. "systemd user service". */
    readonly hubMechanism: string;
}

/** Actions the window may invoke; each maps parameters to a result. */
export interface DesktopActions {
    getState(): DesktopState;
    startHub(): void;
    stopHub(): void;
    restartHub(): void;
    setHubAutostart(params: { enabled: boolean; }): void;
    setTrayAutostart(params: { enabled: boolean; }): void;
    setServiceEnabled(params: { name: string; enabled: boolean; }): void;
    restartService(params: { name: string; }): void;
    getServiceLogs(params: { name: string; }): LogLine[];
    getConfig(): ConfigDocument;
    saveConfig(params: { text: string; expectedRevision: string; }): { revision: string; };
    reloadConfig(): void;
    openConfigFile(): void;
    openLogFile(): void;
}

export type DesktopActionName = keyof DesktopActions;

/** Exposed to the window as `window.hubDesktop` by the preload script. */
export interface HubDesktopBridge {
    invoke<K extends DesktopActionName>(
        action: K,
        ...params: Parameters<DesktopActions[K]>
    ): Promise<ReturnType<DesktopActions[K]>>;
    onState(listener: (state: DesktopState) => void): () => void;
}

export const IPC_INVOKE = 'hub-desktop:invoke';
export const IPC_STATE = 'hub-desktop:state';
