import { Command, Option } from 'commander';
import { directoryInterface, ErrorCode, RpcError, type InterfaceClient, type LinkRpcConnection } from '@hediet/linkrpc';
import { connectToHub } from '@hediet/linkrpc/node';
import { managedEndpointsInterface, HubHome, readEndpointDiscovery, type EndpointStatus } from '@hediet/linkrpc-hub-daemon/client';
import type { ContextReference } from '../contexts';

export type EndpointClient = InterfaceClient<typeof managedEndpointsInterface>;
export interface ServicesHost {
    namespace(): string;
    restart(): Promise<void>;
    use<T>(startLocal: boolean, action: (client: EndpointClient, local: boolean) => Promise<T>): Promise<T>;
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

export async function useLocalManagement<T>(start: boolean, action: (client: EndpointClient) => Promise<T>): Promise<T> {
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
        return await action(handle.connection.get(managedEndpointsInterface));
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
    const services = program.command('services').description('Manage context-scoped endpoints through the selected daemon.');
    services.command('restart')
        .description('Stop the local daemon via RPC and start the bundled daemon; does not change OS autostart.')
        .action(() => host.restart());
    const addressed = (command: Command) => command.option('--id <id>', 'endpoint name in this context', 'main');
    const policy = (command: Command) => command.option('--persistent', 'retain definition across stop and daemon restart')
        .addOption(new Option('--restart <policy>', 'restart process or reconnect after failure').choices(['never', 'on-failure', 'always']).default('never'));
    policy(addressed(services.command('run <command...>').description('Start a process on the daemon; arguments follow --.')))
        .option('--detach', 'return after readiness')
        .option('--cwd <directory>', 'working directory on the execution host')
        .option('--env <key=value...>', 'explicit child environment')
        .addOption(new Option('--readiness <mode>', 'wait for Hub connection or process spawn').choices(['connected', 'spawned']).default('connected'))
        .action(async (command: string[], options: {
            id: string; persistent?: boolean; restart: 'never' | 'on-failure' | 'always';
            detach?: boolean; cwd?: string; env?: string[]; readiness: 'connected' | 'spawned';
        }) => {
            const namespace = host.namespace();
            const env: Record<string, string> = {};
            for (const value of options.env ?? []) {
                const index = value.indexOf('=');
                if (index <= 0) throw new Error('--env requires KEY=value');
                env[value.slice(0, index)] = value.slice(index + 1);
            }
            await host.use(true, async (client, local) => {
                const info = await client.info({});
                const cwd = options.cwd ?? (local ? process.cwd() : undefined);
                if (!cwd) throw new Error('Remote execution requires --cwd with a path on the execution host.');
                process.stderr.write(`Execution host: ${info.hostname}\nNamespace: ${namespace}\nEndpoint: ${options.id}\nCommand: ${JSON.stringify(command)}\nWorking directory: ${cwd}\n`);
                const status = await client.create({
                    namespace, id: options.id, persistent: options.persistent ?? false, restart: options.restart,
                    source: { kind: 'process', command, cwd, env, readiness: options.readiness },
                });
                await attach(client, status, { untilReady: options.detach, interactive: !options.detach });
            });
        });
    policy(addressed(services.command('connect').description('Connect an existing LinkRPC endpoint; never owns its external process.')))
        .requiredOption('--target-endpoint <uri>', 'endpoint resolved on the daemon machine')
        .action(async (options: { id: string; targetEndpoint: string; persistent?: boolean; restart: 'never' | 'on-failure' | 'always' }) => {
            const namespace = host.namespace();
            await host.use(true, async client => {
                const info = await client.info({});
                process.stderr.write(`Execution host: ${info.hostname}\nNamespace: ${namespace}\nEndpoint: ${options.id}\n`);
                const status = await client.create({
                    namespace, id: options.id, persistent: options.persistent ?? false, restart: options.restart,
                    source: { kind: 'connection', endpoint: options.targetEndpoint },
                });
                await attach(client, status, { untilReady: true });
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
                if (operation === 'start') {
                    await attach(client, await client.start({ namespace, id: options.id }), { untilReady: true });
                } else print(await client[operation]({ namespace, id: options.id }));
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
        addressed(services.command(operation)).option('--follow', 'follow new output')
            .action(async (options: { id: string; follow?: boolean }) => {
                const namespace = host.namespace();
                await host.use(false, async client => {
                    const status = (await client.list({ namespace })).find(value => value.id === options.id);
                    if (!status) throw new Error(`Endpoint "${options.id}" not found in ${namespace}`);
                    await attach(client, status, {
                        interactive: operation === 'attach',
                        snapshot: operation === 'logs' && !options.follow,
                        readOnly: operation === 'logs',
                    });
                });
            });
    }
}

async function attach(client: EndpointClient, initial: EndpointStatus, options: {
    untilReady?: boolean; interactive?: boolean; snapshot?: boolean; readOnly?: boolean;
}): Promise<void> {
    const address = { namespace: initial.namespace, id: initial.id, instanceId: initial.instanceId };
    let current = initial;
    let cancelled = false;
    let ready = false;
    let failure: Error | undefined;
    const call = client.attach({ ...address, after: 0 }, {
        onMessage: event => {
            if (event.type === 'output') {
                (event.stream === 'stdout' ? process.stdout : process.stderr).write(event.text);
            } else if (event.type === 'status') {
                current = event.status;
                ready ||= current.runtime.state === 'running';
                if (options.snapshot || (options.untilReady && ready)) cancel();
            }
        },
    });
    function cancel(): void {
        cancelled = true;
        void call.cancel().catch(error => { failure = error instanceof Error ? error : new Error(String(error)); });
    }
    const input = (data: Buffer) => {
        if (data.includes(29)) { cancel(); return; }
        void client.input({ ...address, input: { type: 'stdin', data: data.toString('utf8') } })
            .catch(error => { failure = error instanceof Error ? error : new Error(String(error)); cancel(); });
    };
    const interrupt = () => {
        if (!options.interactive) { cancel(); return; }
        void client.input({ ...address, input: { type: 'signal', signal: 'SIGINT' } })
            .catch(error => { failure = error instanceof Error ? error : new Error(String(error)); cancel(); });
    };
    process.on('SIGINT', interrupt);
    const timeout = options.untilReady ? setTimeout(() => {
        failure = new Error('Endpoint did not become ready within 30 seconds. It remains daemon-owned; use services list or logs to inspect it.');
        cancel();
    }, 30_000) : undefined;
    if (options.interactive) {
        process.stdin.on('data', input);
        process.stdin.resume();
        process.stderr.write('Attached (pipe console). Ctrl+C interrupts; Ctrl+] then Enter detaches.\n');
    }
    try {
        try { await call; } catch (error) { if (!cancelled) throw error; }
        if (failure) throw failure;
        if (options.untilReady && !ready) throw new Error(current.runtime.error ?? 'Endpoint exited before readiness');
        if (current.runtime.state === 'failed' && !options.readOnly && !current.runtime.lastExit?.code) {
            throw new Error(current.runtime.error ?? 'Endpoint failed');
        }
        if (options.untilReady && ready) print(current);
        if (!options.untilReady && !options.readOnly && !cancelled && current.runtime.lastExit?.code) process.exitCode = current.runtime.lastExit.code;
    } finally {
        clearTimeout(timeout);
        process.removeListener('SIGINT', interrupt);
        if (options.interactive) { process.stdin.removeListener('data', input); process.stdin.pause(); }
    }
}

function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
