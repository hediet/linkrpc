import { describe, expect, it } from 'vitest';
import { TransportPair } from '@hediet/linkrpc';
import { createHubServiceInterfaces, Hub } from '@hediet/linkrpc-hub/hub/server';
import { connectViaTransport } from '@hediet/linkrpc-client-internal';
import { pingCommand } from './ping';

describe('pingCommand against a hub', () => {
    it('succeeds against the hub root', async () => {
        const hub = new Hub();
        const services = createHubServiceInterfaces(hub);
        const pair = new TransportPair();
        const hubLink = hub.attach(pair.b);
        const client = connectViaTransport(pair.a);

        try {
            await expect(pingCommand(client.channel)).resolves.toMatch(/^pong  /);
        } finally {
            client.close();
            hubLink.dispose();
            services.dispose();
        }
    });
});
