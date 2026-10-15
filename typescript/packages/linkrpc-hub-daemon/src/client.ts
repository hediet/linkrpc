/**
 * Client entry point: connect applications and management tools to the
 * user's local hub daemon. Free of hub-server dependencies.
 */
import type { InterfaceClient } from '@hediet/linkrpc';
import { connectToHub, LINKRPC_ENDPOINT_VAR, type ConnectToHubOptions, type HubClientHandle } from '@hediet/linkrpc/node';
import { readEndpointDiscovery } from './discovery';
import { hubDaemonManagementInterface } from './managementInterface';
import { HubHome } from './paths';

export * from './managementInterface';
export { type EndpointDiscovery, readEndpointDiscovery } from './discovery';
export { HubHome, LINKRPC_HUB_HOME_VAR } from './paths';

export interface ConnectToLocalHubOptions extends ConnectToHubOptions {
    readonly home?: HubHome;
}

/**
 * Connect to the local hub. Resolution order: explicit `endpoint`,
 * `LINKRPC_ENDPOINT` (set for services the daemon manages), then the running
 * daemon's discovery file.
 */
export async function connectToLocalHub(options: ConnectToLocalHubOptions = {}): Promise<HubClientHandle> {
    const { home, ...connectOptions } = options;
    if (connectOptions.endpoint !== undefined || process.env[LINKRPC_ENDPOINT_VAR]) {
        return connectToHub(connectOptions);
    }
    const resolvedHome = home ?? HubHome.resolve();
    const discovery = readEndpointDiscovery(resolvedHome.discoveryFile);
    if (!discovery) {
        throw new Error(`The local LinkRPC hub is not running (no ${resolvedHome.discoveryFile}).`);
    }
    return connectToHub({ ...connectOptions, endpoint: discovery.endpoint, token: discovery.token ?? '' });
}

export interface HubManagementConnection {
    readonly management: InterfaceClient<typeof hubDaemonManagementInterface>;
    onClose(listener: () => void): { dispose(): void; };
    close(): void;
}

/** Connect to the daemon's management API. Rejects when the daemon is not running. */
export async function connectToHubManagement(home: HubHome = HubHome.resolve()): Promise<HubManagementConnection> {
    const discovery = readEndpointDiscovery(home.managementFile);
    if (!discovery) {
        throw new Error(`The local LinkRPC hub is not running (no ${home.managementFile}).`);
    }
    const handle = await connectToHub({ endpoint: discovery.endpoint, token: discovery.token ?? '' });
    return {
        management: handle.connection.get(hubDaemonManagementInterface),
        onClose: listener => handle.onClose(listener),
        close: () => handle.close(),
    };
}
