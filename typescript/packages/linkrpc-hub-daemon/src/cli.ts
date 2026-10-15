#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { createAutostartManager } from './autostart/autostart';
import { nodeDaemonLaunch } from './autostart/launch';
import { connectToHubManagement, type HubManagementConnection } from './client';
import { daemonConfigJsonSchema, parseDaemonConfigText } from './config';
import { queryDaemonStatus, startDaemon, stopDaemon } from './control';
import { HubDaemon } from './daemon';
import type { DaemonStatus } from './managementInterface';
import { HubHome } from './paths';
import { AlreadyRunningError } from './singleInstance';
import { runWithKeepAlive } from './watchdog';

const program = new Command('linkrpc-hub-daemon')
    .description('Run and manage your per-user LinkRPC hub.')
    .option('--home <dir>', 'hub directory (default: the per-user location, or LINKRPC_HUB_HOME)')
    .showHelpAfterError();

function home(): HubHome {
    const dir = program.opts<{ home?: string; }>().home;
    return dir !== undefined ? HubHome.at(path.resolve(dir)) : HubHome.resolve();
}

program.command('run')
    .description('run the daemon in the foreground')
    .option('--keep-alive', 'restart the daemon after crashes (for unsupervised launchers)', false)
    .option('--quiet', 'log only to the log file, not to stderr', false)
    .action(async (opts: { keepAlive: boolean; quiet: boolean; }) => {
        const hubHome = home();
        if (opts.keepAlive) {
            const script = fileURLToPath(import.meta.url);
            const args = [...process.execArgv, script, ...process.argv.slice(2).filter(arg => arg !== '--keep-alive')];
            process.exitCode = await runWithKeepAlive(process.execPath, args, line => {
                fs.appendFileSync(hubHome.logFile, `${new Date().toISOString()} [watchdog] ${line}\n`);
            });
            return;
        }
        let daemon: HubDaemon;
        // Only needed to start Electron's binary as Node.js; services must not inherit it.
        delete process.env.ELECTRON_RUN_AS_NODE;
        try {
            daemon = await HubDaemon.start({ home: hubHome, echoLog: !opts.quiet });
        } catch (error) {
            if (error instanceof AlreadyRunningError) {
                // Exit code 0: no supervisor (launchd, systemd, watchdog) restarts a duplicate.
                console.error(error.message);
                process.exit(0);
            }
            throw error;
        }
        const stop = () => void daemon.shutdown();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        await daemon.done;
        process.exit(0);
    });

program.command('start')
    .description('start the daemon in the background')
    .action(async () => {
        const hubHome = home();
        const result = await startDaemon({
            home: hubHome,
            launch: nodeDaemonLaunch(hubHome),
            autostart: await createAutostartManager({ home: hubHome }),
        });
        console.log(result === 'started' ? 'The hub is running.' : 'The hub is already running.');
    });

program.command('stop')
    .description('stop all services and the daemon')
    .action(async () => {
        const result = await stopDaemon(home());
        console.log(result === 'stopped' ? 'The hub stopped.' : 'The hub is not running.');
    });

program.command('restart')
    .description('stop and start the daemon')
    .action(async () => {
        const hubHome = home();
        await stopDaemon(hubHome);
        await startDaemon({ home: hubHome, launch: nodeDaemonLaunch(hubHome), autostart: await createAutostartManager({ home: hubHome }) });
        console.log('The hub is running.');
    });

program.command('status')
    .description('show the daemon and its services')
    .option('--json', 'print the status as JSON', false)
    .action(async (opts: { json: boolean; }) => {
        const hubHome = home();
        const status = await queryDaemonStatus(hubHome);
        if (opts.json) {
            console.log(JSON.stringify(status ?? null, null, 2));
        } else {
            const autostart = await createAutostartManager({ home: hubHome });
            const enabled = await autostart.isEnabled();
            console.log(_formatStatus(status, hubHome, `${enabled ? 'enabled' : 'disabled'} (${autostart.description})`));
        }
        if (!status) process.exitCode = 1;
    });

program.command('reload')
    .description('re-read the config file and apply what changed')
    .action(() => _withManagement(async management => {
        const status = await management.reloadConfig({});
        console.log(status.config.error ? `The config is invalid: ${status.config.error}` : 'Config applied.');
    }));

const autostart = program.command('autostart').description('start the hub at login');
autostart.command('enable').description('start the hub at login').action(async () => {
    const hubHome = home();
    const manager = await createAutostartManager({ home: hubHome });
    await manager.enable(nodeDaemonLaunch(hubHome));
    console.log(`The hub starts at login (${manager.description}).`);
});
autostart.command('disable').description('do not start the hub at login').action(async () => {
    const manager = await createAutostartManager({ home: home() });
    await manager.disable();
    console.log('The hub no longer starts at login.');
});
autostart.command('status').description('show whether the hub starts at login').action(async () => {
    const manager = await createAutostartManager({ home: home() });
    console.log(`${await manager.isEnabled() ? 'enabled' : 'disabled'} (${manager.description})`);
});

const service = program.command('service').description('control configured services');
service.command('enable <name>').description('enable a service (persisted in the config)')
    .action((name: string) => _withManagement(m => m.setServiceEnabled({ name, enabled: true })));
service.command('disable <name>').description('disable a service (persisted in the config)')
    .action((name: string) => _withManagement(m => m.setServiceEnabled({ name, enabled: false })));
service.command('restart <name>').description('restart a service')
    .action((name: string) => _withManagement(m => m.restartService({ name })));
service.command('logs <name>').description('print recent output of a service')
    .option('-n, --lines <n>', 'number of lines', '100')
    .action((name: string, opts: { lines: string; }) => _withManagement(async m => {
        const { lines } = await m.getServiceLogs({ name, limit: Number(opts.lines) });
        for (const line of lines) {
            console.log(`${new Date(line.at).toISOString()} ${line.stream.padEnd(6)} ${line.text}`);
        }
    }));

const config = program.command('config').description('inspect the config file');
config.command('path').description('print the config file path').action(() => console.log(home().configFile));
config.command('schema').description('print the config JSON Schema').action(() => {
    console.log(JSON.stringify(daemonConfigJsonSchema(), null, 2));
});
config.command('validate [file]').description('validate a config file (default: the active one)')
    .action((file: string | undefined) => {
        const target = file ?? home().configFile;
        parseDaemonConfigText(fs.readFileSync(target, 'utf8'));
        console.log(`${target} is valid.`);
    });

async function _withManagement(action: (management: HubManagementConnection['management']) => Promise<unknown>): Promise<void> {
    const connection = await connectToHubManagement(home());
    try {
        await action(connection.management);
    } finally {
        connection.close();
    }
}

function _formatStatus(status: DaemonStatus | undefined, hubHome: HubHome, autostart: string): string {
    if (!status) {
        return [`LinkRPC hub: not running`, `Config:      ${hubHome.configFile}`, `Autostart:   ${autostart}`].join('\n');
    }
    const lines = [
        `LinkRPC hub: running (pid ${status.pid}, ${status.version}, up ${_duration(Date.now() - status.startedAt)})`,
        `Endpoint:    ${status.endpoint}`,
        `Config:      ${status.configFile}${status.config.error ? `\n  error: ${status.config.error}` : ''}`,
        ...(status.hub.error ? [`Hub error:   ${status.hub.error}`] : []),
        `Log:         ${status.logFile}`,
        `Autostart:   ${autostart}`,
    ];
    if (status.services.length === 0) return [...lines, 'Services:    none configured'].join('\n');
    const rows = status.services.map(s => [
        s.name,
        s.state,
        s.pid?.toString() ?? '-',
        String(s.restarts),
        s.error ?? '',
    ]);
    const header = ['SERVICE', 'STATE', 'PID', 'RESTARTS', 'INFO'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i]!.length)));
    const format = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd();
    return [...lines, '', format(header), ...rows.map(format)].join('\n');
}

function _duration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
