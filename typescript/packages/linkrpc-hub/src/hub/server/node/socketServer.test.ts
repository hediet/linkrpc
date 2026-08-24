import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { defineInterface, requestType, LinkRpcConnection } from '@hediet/linkrpc';
import { z } from 'zod';
import { connectNdjson } from '@hediet/linkrpc/node';
import { SocketServer } from './socketServer';

const pingInterface = defineInterface(
    { id: 'ping', description: 'Liveness.' },
    { ping: requestType(z.object({ n: z.number() }), z.object({ n: z.number() })) },
);

function connectSocket(endpoint: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(endpoint);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

describe('SocketServer (loopback)', () => {
    it('accepts a connection and round-trips a call', async () => {
        const server = await SocketServer.start();
        try {
            server.setConnectionHandler((transport) => {
                const conn = LinkRpcConnection.fromTransport(transport);
                conn.register(pingInterface, { ping: ({ n }) => ({ n: n + 1 }) });
            });

            const socket = await connectSocket(server.endpoint);
            const { transport } = await connectNdjson({
                input: socket,
                output: socket,
                onClose: () => socket.destroy(),
                initialize: { kind: 'client' },
            });
            const client = LinkRpcConnection.fromTransport(transport);

            const result = await client.get(pingInterface).ping({ n: 41 });
            expect(result).toEqual({ n: 42 });

            socket.destroy();
        } finally {
            server.dispose();
        }
    });

    it('reports the accepted IPC endpoint for topology inspection', async () => {
        const server = await SocketServer.start();
        try {
            const seen = new Promise((resolve) => {
                server.setConnectionHandler((transport) => resolve(transport.topologyInfo));
            });
            const socket = await connectSocket(server.endpoint);
            const connected = await connectNdjson({
                input: socket,
                output: socket,
                onClose: () => socket.destroy(),
                initialize: { kind: 'client' },
            });

            expect(await seen).toEqual({
                type: process.platform === 'win32' ? 'named-pipe' : 'unix',
                path: server.endpoint,
            });

            connected.transport.dispose();
            socket.destroy();
        } finally {
            server.dispose();
        }
    });
});

describe('SocketServer (initialize-token gating)', () => {
    const allow = (...tokens: string[]) =>
        async (token: string | undefined) => token !== undefined && tokens.includes(token);

    it('accepts an initialize handshake carrying an allow-listed token', async () => {
        const server = await SocketServer.start({
            isTokenAccepted: allow('secret-1', 'secret-2'),
        });
        try {
            server.setConnectionHandler((transport) => {
                const conn = LinkRpcConnection.fromTransport(transport);
                conn.register(pingInterface, { ping: ({ n }) => ({ n: n + 1 }) });
            });

            const socket = await connectSocket(server.endpoint);
            const { transport } = await connectNdjson({
                input: socket,
                output: socket,
                onClose: () => socket.destroy(),
                initialize: { kind: 'client', token: 'secret-2' },
            });
            const client = LinkRpcConnection.fromTransport(transport);

            const result = await client.get(pingInterface).ping({ n: 41 });
            expect(result).toEqual({ n: 42 });

            socket.destroy();
        } finally {
            server.dispose();
        }
    });

    it('exposes the presented token as the transport initializeToken', async () => {
        const server = await SocketServer.start({
            isTokenAccepted: allow('secret-1'),
        });
        try {
            const seen = new Promise<string | undefined>((resolve) => {
                server.setConnectionHandler((transport) => resolve(transport.initializeToken));
            });

            const socket = await connectSocket(server.endpoint);
            await connectNdjson({
                input: socket,
                output: socket,
                onClose: () => socket.destroy(),
                initialize: { kind: 'client', token: 'secret-1' },
            });

            expect(await seen).toBe('secret-1');
            socket.destroy();
        } finally {
            server.dispose();
        }
    });

    it('rejects a connection whose token is not allow-listed', async () => {
        const server = await SocketServer.start({
            isTokenAccepted: allow('secret-1'),
        });
        let accepted = false;
        try {
            server.setConnectionHandler(() => { accepted = true; });

            const socket = await connectSocket(server.endpoint);
            await expect(connectNdjson({
                input: socket,
                output: socket,
                onClose: () => socket.destroy(),
                initialize: { kind: 'client', token: 'wrong-token' },
            })).rejects.toThrow(/unauthenticated|rejected/);

            expect(accepted).toBe(false);
        } finally {
            server.dispose();
        }
    });

    it('rejects a connection whose handshake carries no token when tokens are required', async () => {
        const server = await SocketServer.start({
            isTokenAccepted: allow('secret-1'),
        });
        let accepted = false;
        try {
            server.setConnectionHandler(() => { accepted = true; });

            const socket = await connectSocket(server.endpoint);
            await expect(connectNdjson({
                input: socket,
                output: socket,
                onClose: () => socket.destroy(),
                initialize: { kind: 'client' },
            })).rejects.toThrow(/unauthenticated|rejected/);

            expect(accepted).toBe(false);
        } finally {
            server.dispose();
        }
    });
});
