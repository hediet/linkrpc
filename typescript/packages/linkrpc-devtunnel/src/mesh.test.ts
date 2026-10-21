import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Duplex, duplexPair } from 'node:stream';
import type { JsonValue } from '@hediet/linkrpc';
import { openHubChannel } from '@hediet/linkrpc/node';
import { parseHubConfig, runHub, type RunningHub } from '@hediet/linkrpc-hub';
import { SocketServer } from '@hediet/linkrpc-hub/hub/server/node';
import { afterEach, describe, expect, it } from 'vitest';
import type { MeshTunnel, TunnelBackend, TunnelConnection, TunnelHosting } from './backend';
import { fromHubChannel } from './forward';
import { DevTunnelMesh } from './mesh';

/** An in-memory tunnel service shared by the meshes of one test. */
class FakeTunnelService {
    private readonly _hosts = new Map<string, { tunnelId: string; onStream: (stream: Duplex) => void; }>();
    private _nextId = 1;

    public readonly backend: TunnelBackend = {
        list: async () => [...this._hosts].map(([hubServiceId, host]): MeshTunnel => ({
            tunnelId: host.tunnelId, clusterId: 'test', hubServiceId, online: true,
        })),
        host: async (hubServiceId, onStream): Promise<TunnelHosting> => {
            const tunnelId = `tunnel-${this._nextId++}`;
            this._hosts.set(hubServiceId, { tunnelId, onStream });
            let close!: (error: Error | undefined) => void;
            return {
                tunnelId,
                closed: new Promise(resolve => { close = resolve; }),
                dispose: () => {
                    if (this._hosts.get(hubServiceId)?.tunnelId === tunnelId) this._hosts.delete(hubServiceId);
                    close(undefined);
                },
            };
        },
        connect: async (tunnel): Promise<TunnelConnection> => ({
            openStream: async () => {
                const host = [...this._hosts.values()].find(h => h.tunnelId === tunnel.tunnelId);
                if (!host) throw new Error(`${tunnel.tunnelId} is offline`);
                const [local, remote] = duplexPair();
                host.onStream(remote);
                return local;
            },
            closed: new Promise(() => { /* stays open */ }),
            dispose: () => { },
        }),
    };
}

interface TestHub {
    readonly hub: RunningHub;
    readonly mesh: DevTunnelMesh;
    call(method: string): Promise<{ result: JsonValue; stream: JsonValue[]; }>;
}

describe('DevTunnelMesh', () => {
    const cleanup: Array<() => void> = [];
    afterEach(() => {
        for (const dispose of cleanup.splice(0).reverse()) dispose();
    });

    async function startHub(service: FakeTunnelService, hubServiceId: string): Promise<TestHub> {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrdt-'));
        const appEndpoint = SocketServer.allocSocketPath();
        const hub = await runHub({
            config: parseHubConfig({
                hubServiceId,
                forwardChecking: false,
                listeners: [{ type: 'socket', path: appEndpoint, handlers: [{ token: 'anonymous' }] }],
            }),
            identityStoreDir: dir,
            log: () => { },
        });
        cleanup.push(() => {
            hub.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        });

        const echoSocket = await hub.openParticipantSocket({ provision: { grantedServiceId: `${hubServiceId}/echo` } });
        const echo = await openHubChannel({ endpoint: echoSocket.path, token: echoSocket.token });
        echo.setRequestHandler({
            handleRequest: async call => {
                await call.stream.send({ from: hubServiceId });
                return { result: { hub: hubServiceId, method: call.method } };
            },
            handleNotification: () => { },
        });
        await echo.sender.sendRequest('hubGrantedServiceId::register', { serviceId: `${hubServiceId}/echo` });
        cleanup.push(() => echo.close());

        const meshSocket = await hub.openParticipantSocket({ provision: { grantedServiceId: 'me' } });
        const mesh = await DevTunnelMesh.start({
            backend: service.backend,
            openLocal: async () => fromHubChannel(await openHubChannel({ endpoint: meshSocket.path, token: meshSocket.token })),
            appEndpoint,
            host: true,
            connect: true,
            log: () => { },
            discoveryIntervalMs: 100,
        });
        cleanup.push(() => mesh.dispose());

        const clientSocket = await hub.openParticipantSocket({ provision: {} });
        const client = await openHubChannel({ endpoint: clientSocket.path, token: clientSocket.token });
        cleanup.push(() => client.close());
        return {
            hub,
            mesh,
            call: async method => {
                const stream: JsonValue[] = [];
                const call = client.sender.sendRequestWithStream(method, {}, { onStreamMessage: payload => { stream.push(payload); } });
                return { result: await call.result, stream };
            },
        };
    }

    it('routes calls to the hubs on the other machines, including streams', async () => {
        const service = new FakeTunnelService();
        const pc = await startHub(service, 'me/pc');
        const devbox = await startHub(service, 'me/devbox');

        await waitFor(() => pc.mesh.connectedPeers().includes('me/devbox') && devbox.mesh.connectedPeers().includes('me/pc'), 'both links');
        expect(await pc.call('me/devbox/echo::test::echo')).toEqual({
            result: { hub: 'me/devbox', method: 'me/devbox/echo::test::echo' },
            stream: [{ from: 'me/devbox' }],
        });
        expect((await devbox.call('me/pc/echo::test::echo')).result).toEqual({ hub: 'me/pc', method: 'me/pc/echo::test::echo' });
        expect((await pc.call('me/pc/echo::test::echo')).result).toMatchObject({ hub: 'me/pc' });
    });

    it('releases the route when a peer goes offline', async () => {
        const service = new FakeTunnelService();
        const pc = await startHub(service, 'me/pc');
        const devbox = await startHub(service, 'me/devbox');
        await waitFor(() => pc.mesh.connectedPeers().includes('me/devbox'), 'the link');

        devbox.mesh.dispose();
        await waitFor(() => pc.mesh.connectedPeers().length === 0, 'the peer to be dropped');
        await waitFor(async () => {
            try {
                await pc.call('me/devbox/echo::test::echo');
                return false;
            } catch (error) {
                return /no route/.test(String(error));
            }
        }, 'the route to be released');
    });
});

async function waitFor(probe: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probe()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
}
