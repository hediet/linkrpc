#!/usr/bin/env node
import { openHubChannel } from '@hediet/linkrpc/node';
import { HubHome, readEndpointDiscovery } from '@hediet/linkrpc-hub-daemon/client';
import { Command } from 'commander';
import { AzureCliTokenSource, DevTunnelsSdkBackend } from './backend';
import { fromHubChannel } from './forward';
import { DevTunnelMesh } from './mesh';

interface Options {
    readonly host: boolean;
    readonly connect: boolean;
    readonly azureCli: string;
    readonly hubEndpoint?: string;
    readonly discoveryInterval: string;
}

const program = new Command('linkrpc-devtunnel')
    .description('Connect the local LinkRPC hub to the hubs on your other machines through private Dev Tunnels. '
        + 'Run it as a hub daemon service whose serviceId is the namespace shared by your hub IDs '
        + '(e.g. "me" for hubs "me/pc" and "me/laptop"). Signs in through the Azure CLI (`az login`).')
    .option('--no-host', 'do not host this hub\'s tunnel')
    .option('--no-connect', 'do not connect to the other hubs')
    .option('--azure-cli <path>', 'Azure CLI executable', 'az')
    .option('--hub-endpoint <path>', 'the hub\'s application endpoint (default: the local hub daemon\'s)')
    .option('--discovery-interval <seconds>', 'how often to look for peer hubs', '30')
    .action(async (options: Options) => {
        const log = (line: string) => console.log(line);
        const tokens = new AzureCliTokenSource(options.azureCli);
        const mesh = await DevTunnelMesh.start({
            backend: new DevTunnelsSdkBackend(() => tokens.get()),
            openLocal: async () => fromHubChannel(await openHubChannel()),
            appEndpoint: options.hubEndpoint ?? _localAppEndpoint(log),
            host: options.host,
            connect: options.connect,
            log,
            discoveryIntervalMs: Number(options.discoveryInterval) * 1000,
        });
        const stop = () => mesh.dispose();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        await mesh.closed;
        process.exit(0);
    });

function _localAppEndpoint(log: (line: string) => void): string | undefined {
    const discovery = readEndpointDiscovery(HubHome.resolve().discoveryFile);
    if (discovery?.token !== undefined) {
        log('the hub\'s application endpoint requires a token, which remote hubs cannot present; not hosting');
        return undefined;
    }
    return discovery?.endpoint;
}

program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
