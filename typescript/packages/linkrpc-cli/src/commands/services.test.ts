import { directoryInterface, directoryWatchNever, ErrorCode, LinkRpcConnection, RpcError } from '@hediet/linkrpc';
import { connectToHub } from '@hediet/linkrpc/node';
import { SocketServer } from '@hediet/linkrpc-hub/hub/server/node';
import { managedEndpointsInterface } from '@hediet/linkrpc-hub-daemon/client';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDaemonInterfaces } from './services';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

async function connection(setup: (connection: LinkRpcConnection) => void) {
    const server = await SocketServer.start();
    cleanup.push(() => server.dispose());
    server.setConnectionHandler(transport => setup(LinkRpcConnection.fromTransport(transport)));
    const client = await connectToHub({ endpoint: server.endpoint, token: '' });
    cleanup.push(() => client.close());
    return client.connection;
}

describe('daemon required interfaces', () => {
    it.each([undefined, 'remote/daemon'])('accepts the required interface hash at %s', async serviceId => {
        const client = await connection(server => server.register(directoryInterface, {
            list: () => ({ items: [{ serviceId: serviceId ?? '', interfaceId: managedEndpointsInterface.info.id, interfaceHash: managedEndpointsInterface.schemaHash }] }),
            watch: directoryWatchNever,
        }, { serviceId }));
        await expect(checkDaemonInterfaces(client, serviceId)).resolves.toBeUndefined();
    });

    it.each(['missing', 'different hash'])('rejects %s with explicit restart guidance', async reported => {
        const client = await connection(server => server.register(directoryInterface, {
            list: () => ({ items: reported === 'missing' ? [] : [{ serviceId: '', interfaceId: managedEndpointsInterface.info.id, interfaceHash: 'old' }] }),
            watch: directoryWatchNever,
        }));
        await expect(checkDaemonInterfaces(client)).rejects.toThrow(/required interface linkrpc.managedEndpoints@.*hub services restart/);
    });

    it('diagnoses legacy daemons without reflection', async () => {
        const client = await connection(() => {});
        await expect(checkDaemonInterfaces(client)).rejects.toThrow(/cannot report its interfaces.*hub services restart/);
    });

    it('preserves authorization failures rather than suggesting a local fallback', async () => {
        const client = await connection(server => server.register(directoryInterface, {
            list: () => { throw new RpcError('Access denied', ErrorCode.invalidRequest); },
            watch: directoryWatchNever,
        }, { serviceId: 'remote/daemon' }));
        await expect(checkDaemonInterfaces(client, 'remote/daemon')).rejects.toThrow('Access denied');
    });

    it('checks all pages and ignores other services', async () => {
        const client = await connection(server => server.register(directoryInterface, {
            list: ({ cursor }) => ({
                items: [{
                    serviceId: cursor ? '' : 'unrelated',
                    interfaceId: managedEndpointsInterface.info.id, interfaceHash: managedEndpointsInterface.schemaHash,
                }],
                ...(cursor ? {} : { nextCursor: 'next' }),
            }),
            watch: directoryWatchNever,
        }));
        await expect(checkDaemonInterfaces(client)).resolves.toBeUndefined();
    });
});
