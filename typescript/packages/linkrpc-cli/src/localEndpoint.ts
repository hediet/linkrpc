import { HubHome, readEndpointDiscovery } from '@hediet/linkrpc-hub-daemon/client';
import type { SocketEndpoint } from '@hediet/linkrpc/node';

export function resolveLocalEndpoint(): SocketEndpoint {
    const home = HubHome.resolve();
    const discovery = readEndpointDiscovery(home.discoveryFile);
    if (!discovery) throw new Error(`The local LinkRPC hub is not running (no ${home.discoveryFile}).`);
    return { kind: 'socket', path: discovery.endpoint, token: discovery.token };
}
