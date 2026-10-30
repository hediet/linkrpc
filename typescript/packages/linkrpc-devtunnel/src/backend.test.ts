import { TunnelRelayTunnelHost } from '@microsoft/dev-tunnels-connections';
import type { Tunnel } from '@microsoft/dev-tunnels-contracts';
import type { TunnelManagementClient, TunnelRequestOptions } from '@microsoft/dev-tunnels-management';
import { expect, it } from 'vitest';
import { isSdkCancellation, keepPortsOnTunnelRefresh } from './backend';

it('recognizes the Dev Tunnels SDK cancellation error, and only it', () => {
    // Mirrors `@microsoft/dev-tunnels-ssh`'s `CancellationError`, a plain Error subclass.
    class CancellationError extends Error { }
    expect(isSdkCancellation(new CancellationError('Operation cancelled.'))).toBe(true);
    expect(isSdkCancellation(new Error('Operation cancelled.'))).toBe(false);
    expect(isSdkCancellation('Operation cancelled.')).toBe(false);
});

it('keeps the hub port when the SDK refreshes an expired host token', async () => {
    async function refreshAfterUnauthorized(keepPorts: boolean) {
        const requests: TunnelRequestOptions[] = [];
        const management = {
            reportEvent: () => { },
            getTunnel: async (tunnel: Tunnel, options: TunnelRequestOptions = {}): Promise<Tunnel> => {
                requests.push(options);
                return { tunnelId: tunnel.tunnelId, clusterId: tunnel.clusterId, ports: options.includePorts ? tunnel.ports : undefined };
            },
        } as Partial<TunnelManagementClient> as TunnelManagementClient;
        const host = new TunnelRelayTunnelHost(management);
        if (keepPorts) keepPortsOnTunnelRefresh(host, management);
        // What the SDK's relay connector does after a 401 (`refreshTunnelAccessToken` is SDK-internal).
        const session = host as unknown as { tunnel: Tunnel; startConnecting(): void; refreshTunnelAccessToken(): Promise<boolean>; };
        session.tunnel = { tunnelId: 't', clusterId: 'c', ports: [{ portNumber: 31547 }] };
        session.startConnecting();
        const refreshed = await session.refreshTunnelAccessToken();
        return { refreshed, ports: host.tunnel?.ports?.map(port => port.portNumber), requests };
    }

    expect(await refreshAfterUnauthorized(false)).toMatchInlineSnapshot(`
      {
        "ports": undefined,
        "refreshed": true,
        "requests": [
          {
            "includePorts": false,
            "tokenScopes": [
              "host",
            ],
          },
        ],
      }
    `);
    expect(await refreshAfterUnauthorized(true)).toMatchInlineSnapshot(`
      {
        "ports": [
          31547,
        ],
        "refreshed": true,
        "requests": [
          {
            "includePorts": true,
            "tokenScopes": [
              "host",
            ],
          },
        ],
      }
    `);
});
