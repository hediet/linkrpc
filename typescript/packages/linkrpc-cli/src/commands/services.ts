import { Command, Option } from 'commander';
import { directoryInterface, ErrorCode, RpcError, type InterfaceClient, type LinkRpcConnection } from '@hediet/linkrpc';
import { connectToHub } from '@hediet/linkrpc/node';
import { consoleInterface, type ConsoleServerMessage } from '@hediet/linkrpc-infra/console';
import { managedEndpointsInterface, HubHome, readEndpointDiscovery, type EndpointStatus, type RunEvent } from '@hediet/linkrpc-hub-daemon/client';
import type { ContextReference, ContextValues } from '../contexts';
import { localTerminalSize, runConsoleSession } from './consoleSession';

export type EndpointClient = InterfaceClient<typeof managedEndpointsInterface>;
export interface ServicesHost {
    namespace(): string;
    attachCommand(id: string): string;
    restart(): Promise<void>;
    use<T>(startLocal: boolean, action: (client: EndpointClient, context: ManagementContext) => Promise<T>): Promise<T>;
}

/** Where the management client lives; consoles are served on the same connection. */
export interface ManagementContext {
    readonly local: boolean;
    readonly connection: LinkRpcConnection;
}

export function serviceAttachCommand(options: {
    context: string; namespace: string; id: string; overrides: ContextValues; useEnv: boolean;
}, platform: NodeJS.Platform = process.platform): string {
    const args = ['hub', 'services', 'attach', '--id', options.id,
        '--context', options.context, '--namespace', options.namespace, options.useEnv ? '--use-env' : '--no-use-env'];
    for (const key of Object.keys(options.overrides) as (keyof ContextValues)[]) {
        if (key === 'namespace') continue;
        const value = options.overrides[key];
        if (value === undefined) continue;
        const flag = '--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
        if (key === 'endpointCmdEnv' && typeof value === 'object') {
            for (const name of Object.keys(value)) args.push(flag, `${name}=<same value>`);
        } else if (typeof value === 'boolean') {
            if (value) args.push(flag);
            else if (key === 'sign') args.push('--no-sign');
        } else if (typeof value === 'string' || typeof value === 'number') {
            args.push(flag, key === 'endpointToken' ? '<same endpoint token>' : String(value).replace(/([?&]token=)[^&]+/g, '$1<same token>'));
        }
    }
    return args.map(arg => /^[A-Za-z0-9_./:-]+$/.test(arg) ? arg
        : "'" + arg.replace(/'/g, platform === 'win32' ? "''" : "'\\''") + "'").join(' ');
}

const requiredInterfaces = [
    { id: managedEndpointsInterface.info.id, hash: managedEndpointsInterface.schemaHash },
];

export async function checkDaemonInterfaces(connection: LinkRpcConnection, serviceId?: string): Promise<void> {
    const recovery = serviceId === undefined
        ? 'Run `hub services restart` to stop the local daemon via RPC and start this CLI\'s bundled daemon.'
        : 'Update/restart the daemon on its execution host. To replace the default local daemon, run `hub --context :empty --no-use-env services restart`.';
    for (const required of requiredInterfaces) {
        let cursor: string | undefined;
        let supported = false;
        const hashes = new Set<string>();
        try {
            do {
                const page = await connection.get(directoryInterface, { serviceId }).list({
                    interfaceId: required.id, serviceId: serviceId ?? '', cursor,
                });
                for (const item of page.items) {
                    if (item.interfaceId !== required.id || item.serviceId !== (serviceId ?? '')) continue;
                    hashes.add(item.interfaceHash);
                    supported ||= item.interfaceHash === required.hash;
                }
                if (page.truncated) throw new Error('Daemon interface discovery was truncated; compatibility could not be checked.');
                cursor = page.nextCursor;
            } while (!supported && cursor !== undefined);
        } catch (error) {
            if (!(error instanceof RpcError) || error.code !== ErrorCode.methodNotFound) throw error;
            throw new Error(`The selected daemon cannot report its interfaces. ${recovery}`, { cause: error });
        }
        if (!supported) {
            throw new Error(`The selected daemon does not support required interface ${required.id}@${required.hash} (reported: ${[...hashes].join(', ') || 'missing'}). ${recovery}`);
        }
    }
}

export function contextNamespace(reference: ContextReference): string {
    switch (reference.kind) {
        case 'path': return process.platform === 'win32' ? reference.path.toLowerCase() : reference.path;
        case 'id': return `id:${reference.id}`;
        case 'root': return ':root';
        case 'empty': throw new Error('No context selected. Create one with --new-context . or select one with --context <selector>.');
    }
}

export async function useLocalManagement<T>(start: boolean, action: (client: EndpointClient, context: ManagementContext) => Promise<T>): Promise<T> {
    const home = HubHome.resolve();
    if (start) {
        const { startDaemon, nodeDaemonLaunch } = await import('@hediet/linkrpc-hub-daemon');
        const result = await startDaemon({ home, launch: nodeDaemonLaunch(home) });
        if (result === 'started') process.stderr.write('linkrpc: local daemon started.\n');
    }
    const discovery = readEndpointDiscovery(home.managementFile);
    if (!discovery) throw new Error('No endpoint configured through flags, environment, or context, and no local services are running.');
    const handle = await connectToHub({ endpoint: discovery.endpoint, token: discovery.token ?? '' });
    try {
        await checkDaemonInterfaces(handle.connection);
        return await action(handle.connection.get(managedEndpointsInterface), { local: true, connection: handle.connection });
    }
    finally { handle.close(); }
}

export async function restartLocalDaemon(): Promise<void> {
    const { startDaemon, stopDaemon, nodeDaemonLaunch } = await import('@hediet/linkrpc-hub-daemon');
    const home = HubHome.resolve();
    process.stderr.write('Restarting the local Hub daemon: clients will disconnect and managed workloads will stop. OS autostart settings are unchanged.\n');
    await stopDaemon(home);
    await startDaemon({ home, launch: nodeDaemonLaunch(home) });
    await useLocalManagement(false, async () => {});
    process.stderr.write('The bundled daemon is running and supports the required interfaces.\n');
}

export function registerServices(program: Command, host: ServicesHost): void {
    const createEndpoint = async (id: string, action: (client: EndpointClient, context: ManagementContext) => Promise<void>) => {
        try { await host.use(true, action); }
        catch (error) {
            if (error instanceof RpcError && error.message === `Endpoint "${id}" already exists in ${host.namespace()}`) {
                throw new RpcError(
                    `${error.message}\nAttach to it: ${host.attachCommand(id)}\nOr replace it: rerun this command with --force`,
                    error.code, error.data, error.origin, error.hasData,
                );
            }
            throw error;
        }
    };
    const services = program.command('services').description('Manage context-scoped endpoints through the selected daemon.')
        .option('--namespace <name>', 'managed endpoint namespace (defaults to selected context)');
    services.command('restart')
        .description('Stop the local daemon via RPC and start the bundled daemon; does not change OS autostart.')
        .action(() => host.restart());
    const addressed = (command: Command) => command.option('--id <id>', 'endpoint name in this context', 'main');
    const policy = (command: Command) => command.option('--persistent', 'retain definition across stop and daemon restart')
        .addOption(new Option('--restart <policy>', 'restart process or reconnect after failure').choices(['never', 'on-failure', 'always']).default('never'))
        .option('--force', 'stop and replace an existing endpoint with the same ID, even one owned by another terminal');
    policy(addressed(services.command('run <command...>').description('Start a process on the daemon; arguments follow --.')))
        .option('--detach', 'return after readiness')
        .addOption(new Option('--foreground', 'stop and remove the service when this CLI disconnects').conflicts(['detach', 'persistent']))
        .option('-t, --tty', 'run in a pseudoterminal; keys go to the program and Ctrl+P, Ctrl+Q detaches')
        .option('-x, --no-rpc', 'run a plain stdio process without an RPC connection; ready on spawn')
        .option('--cwd <directory>', 'working directory on the execution host')
        .option('--env <key=value...>', 'explicit child environment')
        .addOption(new Option('--readiness <mode>', 'wait for Hub connection or process spawn (default: connected, or spawned with --no-rpc)').choices(['connected', 'spawned']))
        .action(async (command: string[], options: {
            id: string; persistent?: boolean; restart: 'never' | 'on-failure' | 'always'; force?: boolean;
            detach?: boolean; foreground?: boolean; tty?: boolean; rpc: boolean; cwd?: string; env?: string[]; readiness?: 'connected' | 'spawned';
        }) => {
            if (!options.rpc && options.readiness === 'connected') throw new Error('--no-rpc cannot use --readiness connected; plain processes are ready on spawn.');
            const namespace = host.namespace();
            const env: Record<string, string> = {};
            for (const value of options.env ?? []) {
                const index = value.indexOf('=');
                if (index <= 0) throw new Error('--env requires KEY=value');
                env[value.slice(0, index)] = value.slice(index + 1);
            }
            await createEndpoint(options.id, async (client, context) => {
                const info = await client.info({});
                const cwd = options.cwd ?? (context.local ? process.cwd() : undefined);
                if (!cwd) throw new Error('Remote execution requires --cwd with a path on the execution host.');
                process.stderr.write(`Execution host: ${info.hostname}\nNamespace: ${namespace}\nEndpoint: ${options.id}\nCommand: ${JSON.stringify(command)}\nWorking directory: ${cwd}\n`);
                const tty = options.tty === true;
                const size = tty ? localTerminalSize() : undefined;
                const detach = new AbortController();
                let status: EndpointStatus | undefined;
                let timedOut = false;
                const timeout = options.detach ? setTimeout(() => { timedOut = true; detach.abort(); }, 30_000) : undefined;
                try {
                    const result = await runConsoleSession<Exclude<RunEvent, ConsoleServerMessage>>(onMessage => client.run({
                        definition: {
                            namespace, id: options.id, persistent: options.persistent ?? false, restart: options.restart,
                            source: { kind: 'process', command, cwd, env, rpc: options.rpc, tty, readiness: options.readiness ?? (options.rpc ? 'connected' : 'spawned') },
                        },
                        owner: options.foreground === true,
                        replace: options.force === true,
                        console: { interactive: !options.detach, ...(size ? { size } : {}) },
                    }, { onMessage }), {
                        interactive: !options.detach,
                        owner: options.foreground === true,
                        reattachCommand: host.attachCommand(options.id),
                        signal: detach.signal,
                    }, event => {
                        status = event.status;
                        if (options.detach && status.runtime.state === 'running') detach.abort();
                    });
                    if (options.detach) {
                        if (timedOut) throw new Error('Endpoint did not become ready within 30 seconds. It remains daemon-owned; use services list or logs to inspect it.');
                        if (status?.runtime.state !== 'running') throw new Error(status?.runtime.error ?? 'Endpoint exited before readiness');
                        print(status);
                    } else if (!result.closedLocally && result.exit?.code) {
                        process.exitCode = result.exit.code;
                    } else if (!result.closedLocally && status?.runtime.state === 'failed' && !result.exit) {
                        throw new Error(status.runtime.error ?? 'Endpoint failed');
                    }
                } finally {
                    clearTimeout(timeout);
                }
            });
        });
    policy(addressed(services.command('connect').description('Connect an existing LinkRPC endpoint; never owns its external process.')))
        .requiredOption('--target-endpoint <uri>', 'endpoint resolved on the daemon machine')
        .action(async (options: { id: string; targetEndpoint: string; persistent?: boolean; restart: 'never' | 'on-failure' | 'always'; force?: boolean }) => {
            const namespace = host.namespace();
            await createEndpoint(options.id, async client => {
                const info = await client.info({});
                process.stderr.write(`Execution host: ${info.hostname}\nNamespace: ${namespace}\nEndpoint: ${options.id}\n`);
                const status = await client.create({
                    namespace, id: options.id, persistent: options.persistent ?? false, restart: options.restart, replace: options.force === true,
                    source: { kind: 'connection', endpoint: options.targetEndpoint },
                });
                print(await waitUntilReady(client, status));
            });
        });
    services.command('list').option('--all-contexts', 'include every namespace visible to this caller')
        .action(async (options: { allContexts?: boolean }) => {
            const namespace = options.allContexts ? undefined : host.namespace();
            await host.use(false, async client => print(await client.list({ namespace })));
        });
    for (const operation of ['start', 'stop', 'remove'] as const) {
        addressed(services.command(operation)).action(async (options: { id: string }) => {
            const namespace = host.namespace();
            await host.use(operation === 'start', async client => {
                if (operation === 'start') print(await waitUntilReady(client, await client.start({ namespace, id: options.id })));
                else print(await client[operation]({ namespace, id: options.id }));
            });
        });
    }
    addressed(services.command('configure'))
        .option('--persistent', 'retain this endpoint')
        .option('--no-persistent', 'remove it when stopped')
        .addOption(new Option('--restart <policy>').choices(['never', 'on-failure', 'always']))
        .action(async (options: { id: string; persistent?: boolean; restart?: 'never' | 'on-failure' | 'always' }, command: Command) => {
            const namespace = host.namespace();
            await host.use(false, async client => print(await client.configure({
                namespace, id: options.id, restart: options.restart,
                persistent: command.getOptionValueSource('persistent') === 'cli' ? options.persistent : undefined,
            })));
        });
    for (const operation of ['attach', 'logs'] as const) {
        const subcommand = addressed(services.command(operation));
        if (operation === 'attach') subcommand.option('--read-only', 'observe without sending input');
        else subcommand.option('--follow', 'follow new output');
        subcommand.action(async (options: { id: string; follow?: boolean; readOnly?: boolean }) => {
            const namespace = host.namespace();
            await host.use(false, async (client, { connection }) => {
                const status = (await client.list({ namespace })).find(value => value.id === options.id);
                if (!status) throw new Error(`Endpoint "${options.id}" not found in ${namespace}`);
                if (!status.console) throw new Error(`Endpoint "${options.id}" is a connection and has no console`);
                const interactive = operation === 'attach' && options.readOnly !== true;
                const console = connection.get(consoleInterface, { serviceId: status.console.serviceId });
                const size = interactive ? localTerminalSize() : undefined;
                const result = await runConsoleSession(onMessage => console.attach({ interactive, ...(size ? { size } : {}) }, { onMessage }), {
                    interactive,
                    owner: false,
                    untilLive: operation === 'logs' && !options.follow,
                    reattachCommand: host.attachCommand(options.id),
                });
                if (operation === 'attach' && !result.closedLocally && result.exit?.code) process.exitCode = result.exit.code;
            });
        });
    }
}

/** Wait until an endpoint runs; fail if it stops, fails, or is removed first. */
async function waitUntilReady(client: EndpointClient, initial: EndpointStatus): Promise<EndpointStatus> {
    if (initial.runtime.state === 'running') return initial;
    let current = initial;
    let outcome: 'ready' | 'finished' | 'removed' | 'timeout' | undefined;
    const call = client.watch({ namespace: initial.namespace, id: initial.id }, {
        onMessage: event => {
            if (event.t === 'removed') outcome = 'removed';
            else {
                current = event.status;
                if (current.runtime.state === 'running') outcome = 'ready';
                else if (['failed', 'stopped', 'disabled'].includes(current.runtime.state)) outcome = 'finished';
            }
            if (outcome) void call.cancel().catch(() => {});
        },
    });
    const timeout = setTimeout(() => { outcome ??= 'timeout'; void call.cancel().catch(() => {}); }, 30_000);
    try {
        await call;
    } catch (error) {
        if (!outcome) throw error;
    } finally {
        clearTimeout(timeout);
    }
    switch (outcome) {
        case 'ready': return current;
        case 'timeout': throw new Error('Endpoint did not become ready within 30 seconds. It remains daemon-owned; use services list or logs to inspect it.');
        default: throw new Error(current.runtime.error ?? 'Endpoint exited before readiness');
    }
}

function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
