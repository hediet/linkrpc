export * from './client';
export {
    classifyServiceChange,
    type DaemonConfig,
    daemonConfigJsonSchema,
    DEFAULT_CONFIG_TEXT,
    type ManagedService,
    ManagedServiceSchema,
    parseDaemonConfig,
    parseDaemonConfigText,
    type ServiceChange,
    setServiceEnabledInText,
} from './config';
export { ConfigConflictError, ConfigFile } from './configFile';
export { HubDaemon, type StartHubDaemonOptions } from './daemon';
export { AlreadyRunningError } from './singleInstance';
export { queryDaemonStatus, startDaemon, type StartDaemonOptions, stopDaemon } from './control';
export { runWithKeepAlive } from './watchdog';
export { cliScript } from './packageInfo';
export { type AutostartManager, type AutostartOptions, createAutostartManager } from './autostart/autostart';
export { type DaemonLaunch, type LaunchCommand, nodeDaemonLaunch, spawnDetached } from './autostart/launch';
export { WindowsRunKeyAutostart } from './autostart/windows';
export { LaunchdAutostart } from './autostart/launchd';
export { SystemdUserAutostart, XdgAutostart } from './autostart/linux';
