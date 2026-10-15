import * as net from 'node:net';
import { connectNdjson } from '@hediet/linkrpc/node';
import { readEndpointDiscovery } from './discovery';
import type { HubHome } from './paths';

export interface StdioBridgeOptions {
    readonly home: HubHome;
    readonly input: NodeJS.ReadableStream;
    readonly output: NodeJS.WritableStream;
}

/**
 * Connect a stream pair speaking newline-delimited JSON-RPC (without an
 * initialize handshake) to the local hub as a client: its requests are routed
 * by the hub and responses come back unchanged. Lets hosts that can only spawn
 * stdio services (e.g. the VS Code team-tools hub) route a service ID to this
 * hub. Resolves when either side closes.
 */
export async function bridgeStdioToLocalHub(options: StdioBridgeOptions): Promise<void> {
    const discovery = readEndpointDiscovery(options.home.discoveryFile);
    if (!discovery) throw new Error(`The local LinkRPC hub is not running (no ${options.home.discoveryFile}).`);
    const socket = net.connect(discovery.endpoint);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    socket.on('error', () => close());
    const { transport: hub } = await connectNdjson({
        input: socket,
        output: socket,
        onClose: () => close(),
        initialize: { kind: 'client', token: discovery.token },
    });
    const { transport: stdio } = await connectNdjson({
        input: options.input,
        output: options.output,
        onClose: () => close(),
    });
    hub.setListener(message => {
        // Nothing routes service calls to the bridge itself; requests from the hub
        // are participant probes (e.g. inspection), not traffic for the stdio side.
        if ('method' in message) {
            if ('id' in message && message.id !== undefined && message.id !== null) {
                void hub.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
            }
            return;
        }
        void stdio.send(message);
    });
    stdio.setListener(message => void hub.send(message));
    await closed;
    hub.dispose();
    stdio.dispose();
    socket.destroy();
}
