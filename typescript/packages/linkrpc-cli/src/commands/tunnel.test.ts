import { describe, expect, it } from 'vitest';
import type { CliConnection } from '@hediet/linkrpc-client-internal';
import { proxyCommand } from './tunnel';

function fakeConnection() {
    const calls: Array<{ method: string; params: unknown }> = [];
    const connection = {
        setRequestHandler: () => { },
        channel: {
            sendRequest: async (method: string, params: unknown) => {
                calls.push({ method, params });
                return method === 'hubGrantedServiceId::get' ? { grantedServiceIdNamespace: 'hediet' } : {};
            },
        },
    } as unknown as CliConnection;
    return { connection, calls };
}

describe('proxy', () => {
    it('claims every requested service id', async () => {
        const hub = fakeConnection();
        await proxyCommand({
            hub: hub.connection,
            participant: fakeConnection().connection,
            claimServiceIds: ['hediet/pc2', 'hediet/devbox/compute'],
            outbound: 'verbatim',
            stop: Promise.resolve(),
            log: () => { },
        });
        expect(hub.calls.filter(call => call.method === 'hubGrantedServiceId::register')).toMatchInlineSnapshot(`
          [
            {
              "method": "hubGrantedServiceId::register",
              "params": {
                "serviceId": "hediet/pc2",
              },
            },
            {
              "method": "hubGrantedServiceId::register",
              "params": {
                "serviceId": "hediet/devbox/compute",
              },
            },
          ]
        `);
    });
});
