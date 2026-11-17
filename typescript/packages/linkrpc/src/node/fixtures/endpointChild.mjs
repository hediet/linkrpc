// A plain `startEndpoint` application spawned by a Rust `cmd:` parent in endpointInterop.test.ts.
// It reads LINKRPC_ENDPOINT / LINKRPC_TOKEN, dials back, and answers `endpoint.echo::ping`.
import { startEndpoint } from '@hediet/linkrpc/node';

const endpoint = await startEndpoint({
    onConnection: peer => peer.channel.setRequestHandler({
        handleRequest: async call => call.method === 'endpoint.echo::ping'
            ? { result: `${call.params} via ts` }
            : { error: { code: -32601, message: `unknown method ${call.method}` } },
        handleNotification: () => {},
    }),
});
await endpoint.closed;
