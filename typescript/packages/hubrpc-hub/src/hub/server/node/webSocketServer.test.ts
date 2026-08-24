import { runInitializeHandshake } from '@vscode/hubrpc/node';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { NodeWebSocketTransport, WebSocketServer } from './webSocketServer';

const servers: WebSocketServer[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.dispose();
});

describe('WebSocketServer topology information', () => {
    it('reports socket endpoints, route path, origin, and forwarded address', async () => {
        const server = await WebSocketServer.start({
            host: '127.0.0.1',
            path: '/hub',
            allowAnonymous: true,
        });
        servers.push(server);
        const seen = new Promise((resolve) => {
            server.setConnectionHandler((transport) => resolve(transport.topologyInfo));
        });
        const socket = await openWebSocket(`ws://127.0.0.1:${server.port}/hub`, {
            origin: 'https://example.test',
            'x-forwarded-for': '198.51.100.4, 203.0.113.2',
        });
        const transport = new NodeWebSocketTransport(socket);

        await runInitializeHandshake(transport, { kind: 'client' });

        expect(await seen).toMatchObject({
            type: 'websocket',
            path: '/hub',
            local: {
                address: '127.0.0.1',
                port: server.port,
            },
            remote: {
                address: '127.0.0.1',
            },
            metadata: {
                origin: 'https://example.test',
                forwardedFor: '198.51.100.4',
            },
        });

        transport.dispose();
    });
});

function openWebSocket(url: string, headers: Record<string, string>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
    });
}
