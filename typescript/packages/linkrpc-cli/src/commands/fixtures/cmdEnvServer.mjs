import { startEndpoint, LinkRpcConnection, defineInterface, requestType } from '@hediet/linkrpc/node';
import { hubFromConnection } from '@hediet/linkrpc/hub/client';
import { z } from 'zod';

const iface = defineInterface({ id: 'test.cmdEnv' }, {
    echo: requestType(z.string(), z.object({ value: z.string(), pid: z.number() })),
});
const endpoint = await startEndpoint({
    async onConnection(peer) {
        const connection = new LinkRpcConnection(peer.channel);
        const options = process.argv[2] === 'claim'
            ? await hubFromConnection(connection).claimGrantedServiceIdNamespace()
            : {};
        connection.register(iface, {
            echo: value => ({ value, pid: process.pid }),
        }, options);
        connection.enableReflection();
    },
});
await endpoint.closed;
