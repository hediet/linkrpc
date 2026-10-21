/**
 * The contract between the main process and the sandboxed management window.
 * Types only: the renderer bundle must not pull in Node.js code.
 */
import type { CallFilter, CallLogLevel, CallRecord, ConfigDocument, DaemonStatus, LogLine } from '@hediet/linkrpc-hub-daemon/client';
import type { CallsViewSettings } from './desktopSettings';

export type { CallsViewSettings } from './desktopSettings';

export type { CallFilter, CallLogLevel, CallRecord, ConfigDocument, DaemonStatus, LogLine, ServiceStatus } from '@hediet/linkrpc-hub-daemon/client';

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
    /** Persisted in the daemon config; `off` stops recording. */
    setCallLogLevel(params: { level: CallLogLevel; }): void;
    /** Recorded calls from the call-log files, newest first. */
    queryCalls(params: { filter: CallFilter; limit: number; }): { calls: CallRecord[]; truncated: boolean; };
    /** Push matching calls to the window ({@link IPC_CALLS}) as they are recorded; replaces the previous watch. */
    watchCalls(params: { filter: CallFilter; }): void;
    unwatchCalls(): void;
    openCallLogFolder(): void;
    /** The Calls view filter, saved in the tray app's settings file. */
    getCallsViewSettings(): CallsViewSettings;
    setCallsViewSettings(params: CallsViewSettings): void;
}

export type DesktopActionName = keyof DesktopActions;

/** Exposed to the window as `window.hubDesktop` by the preload script. */
export interface HubDesktopBridge {
    invoke<K extends DesktopActionName>(
        action: K,
        ...params: Parameters<DesktopActions[K]>
    ): Promise<ReturnType<DesktopActions[K]>>;
    onState(listener: (state: DesktopState) => void): () => void;
    onCall(listener: (call: CallRecord) => void): () => void;
}

export const IPC_INVOKE = 'hub-desktop:invoke';
export const IPC_STATE = 'hub-desktop:state';
export const IPC_CALLS = 'hub-desktop:calls';
