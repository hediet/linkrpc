import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { defineInterface } from '../connection/interfaceDefinition';
import { parseEndpointUri } from '../connection/endpointUri';
import { LinkRpcConnection } from '../connection/linkRpcConnection';
import { requestType } from '../schema/memberTypes';
import { startEndpoint, type EndpointConnection, type StartedEndpoint } from './endpoint';
import { runInitializeHandshake } from './initialize';
import { WebSocketTransport } from './webSocketClientTransport';

const echo = defineInterface({ id: 'endpoint.echo' }, {
    ping: requestType(z.string(), z.string()),
});
const endpoints: StartedEndpoint[] = [];
const streams: PassThrough[] = [];

afterEach(async () => {
    for (const endpoint of endpoints.splice(0)) {
        endpoint.dispose();
        await endpoint.closed;
    }
    for (const stream of streams.splice(0)) stream.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function serve(connection: EndpointConnection): void {
    new LinkRpcConnection(connection.channel).register(echo, { ping: value => value.toUpperCase() });
}

async function listen(endpoint: string, onConnection = serve): Promise<StartedEndpoint> {
    const result = await startEndpoint({ endpoint, token: 'secret', onConnection, onError: () => {} });
    endpoints.push(result);
    return result;
}

function socketEndpoint(): string {
    return process.platform === 'win32'
        ? `npipe://./pipe/linkrpc-test-${randomUUID()}`
        : `unix:${path.join(process.cwd(), `${randomUUID()}.sock`)}`;
}

describe('startEndpoint', () => {
    it.each(['websocket', 'socket'])('round-trips and closes %s connections', async kind => {
        let accepted!: EndpointConnection;
        const server = await listen(kind === 'websocket' ? 'listen:ws://127.0.0.1:0/rpc' : `listen:${socketEndpoint()}`, peer => {
            accepted = peer;
            serve(peer);
        });
        let client!: EndpointConnection;
        const endpoint = await startEndpoint({
            endpoint: server.endpoint, token: 'secret', onConnection: peer => { client = peer; },
        });
        endpoints.push(endpoint);
        const rpc = new LinkRpcConnection(client.channel);
        expect(await rpc.get(echo).ping('hello')).toBe('HELLO');
        expect(server.endpoint).not.toContain('secret');
        expect(server.endpoint).not.toContain(':0/');
        endpoint.dispose();
        endpoint.dispose();
        await endpoint.closed;
        await accepted.closed;
        await expect(rpc.get(echo).ping('closed')).rejects.toThrow(/closed/i);
    });

    it.each(['websocket', 'socket'])('authenticates %s before exposing connections', async kind => {
        const onConnection = vi.fn(serve);
        const onError = vi.fn();
        const server = await startEndpoint({
            endpoint: kind === 'websocket' ? 'listen:ws://127.0.0.1:0' : `listen:${socketEndpoint()}`,
            token: 'secret', onConnection, onError,
        });
        endpoints.push(server);
        await expect(startEndpoint({
            endpoint: server.endpoint, token: 'wrong', onConnection: () => {},
        })).rejects.toThrow(/unauthenticated|closed/);
        expect(onConnection).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(onError).toHaveBeenCalled());
        await expect(startEndpoint({
            endpoint: server.endpoint, token: '', onConnection: () => {},
        })).rejects.toThrow(/unauthenticated|closed/);
        endpoints.push(await startEndpoint({
            endpoint: server.endpoint, token: 'secret', onConnection: () => {},
        }));
        await vi.waitFor(() => expect(onConnection).toHaveBeenCalledOnce());
    });

    it('uses environment defaults and gives explicit options precedence over URI/environment tokens', async () => {
        const server = await listen('listen:ws://127.0.0.1:0');
        vi.stubEnv('LINKRPC_ENDPOINT', server.endpoint);
        vi.stubEnv('LINKRPC_TOKEN', 'secret');
        endpoints.push(await startEndpoint({ onConnection: serve }));
        vi.stubEnv('LINKRPC_ENDPOINT', 'unsupported:');
        vi.stubEnv('LINKRPC_TOKEN', 'wrong');
        endpoints.push(await startEndpoint({ endpoint: `${server.endpoint}?token=secret`, onConnection: serve }));
        endpoints.push(await startEndpoint({
            endpoint: `${server.endpoint}?token=wrong`, token: 'secret', onConnection: serve,
        }));
        endpoints.push(await startEndpoint({
            endpoint: 'listen:ws://127.0.0.1:0?token=secret', onConnection: serve,
        }));
    });

    it('dials legacy bare socket paths', async () => {
        const server = await listen(`listen:${socketEndpoint()}`);
        const target = parseEndpointUri(server.endpoint);
        if (target.kind !== 'socket') throw new Error('Expected a socket');
        let peer!: EndpointConnection;
        endpoints.push(await startEndpoint({
            endpoint: target.path, token: 'secret', onConnection: connection => { peer = connection; },
        }));
        expect(await new LinkRpcConnection(peer.channel).get(echo).ping('bare')).toBe('BARE');
    });

    it('supports multiple peers and rejects their pending calls on server disposal', async () => {
        const server = await listen('listen:ws://127.0.0.1:0', peer => {
            new LinkRpcConnection(peer.channel).register(echo, { ping: () => new Promise(() => {}) });
        });
        const peers: EndpointConnection[] = [];
        for (let i = 0; i < 2; i++) {
            endpoints.push(await startEndpoint({
                endpoint: server.endpoint, token: 'secret', onConnection: peer => { peers.push(peer); },
            }));
        }
        const pending = peers.map(peer => expect(
            new LinkRpcConnection(peer.channel).get(echo).ping('pending'),
        ).rejects.toThrow(/closed/i));
        server.dispose();
        await server.closed;
        await Promise.all(pending);
    });

    it('cleans up failed single-connection callbacks and reports listener callback failures', async () => {
        let accepted!: EndpointConnection;
        const server = await listen('listen:ws://127.0.0.1:0', peer => { accepted = peer; });
        await expect(startEndpoint({
            endpoint: server.endpoint, token: 'secret',
            onConnection: async () => { throw new Error('setup failed'); },
        })).rejects.toThrow('setup failed');
        await accepted.closed;
        const onError = vi.fn();
        const failing = await startEndpoint({
            endpoint: 'listen:ws://127.0.0.1:0', token: 'secret', onError,
            onConnection: async () => { throw new Error('listener setup failed'); },
        });
        endpoints.push(failing);
        const client = await startEndpoint({
            endpoint: failing.endpoint, token: 'secret', onConnection: () => {},
        });
        endpoints.push(client);
        await client.closed;
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener setup failed' }));
    });

    it.each(['websocket', 'socket'])('disposes pending %s handshakes and permits immediate rebinding', async kind => {
        const endpoint = kind === 'websocket' ? 'listen:ws://127.0.0.1:0' : `listen:${socketEndpoint()}`;
        const server = await listen(endpoint);
        const target = parseEndpointUri(server.endpoint);
        const address = target.kind === 'ws' ? new URL(target.url) : undefined;
        const raw = target.kind === 'socket'
            ? net.connect(target.path)
            : net.connect(Number(address!.port), address!.hostname);
        await new Promise<void>((resolve, reject) => {
            raw.once('connect', resolve);
            raw.once('error', reject);
        });
        const closed = new Promise<void>(resolve => raw.once('close', () => resolve()));
        raw.resume();
        if (kind === 'websocket') raw.write('GET / HTTP/1.1\r\n');
        server.dispose();
        await server.closed;
        await closed;
        await listen(`listen:${server.endpoint}`);
    });

    it('cancels an accepted WebSocket awaiting initialize on disposal', async () => {
        const server = await listen('listen:ws://127.0.0.1:0');
        const socket = new WebSocket(server.endpoint);
        await new Promise<void>((resolve, reject) => {
            socket.once('open', resolve);
            socket.once('error', reject);
        });
        const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
        server.dispose();
        await server.closed;
        await closed;
    });

    it('rejects missing configuration, unsupported modes, unauthenticated listeners, and bind failures', async () => {
        vi.stubEnv('LINKRPC_ENDPOINT', '');
        vi.stubEnv('LINKRPC_TOKEN', '');
        await expect(startEndpoint({ onConnection: serve })).rejects.toThrow('LINKRPC_ENDPOINT');
        for (const endpoint of ['cmd-stdio:?command=node', 'ws-no-init://localhost']) {
            await expect(startEndpoint({ endpoint, onConnection: serve })).rejects.toThrow('supports');
        }
        await expect(startEndpoint({ endpoint: 'listen:ws://127.0.0.1:0', onConnection: serve })).rejects.toThrow('nonempty token');
        await expect(listen('listen:wss://127.0.0.1:0')).rejects.toThrow('terminate TLS');
        const server = await listen('listen:ws://127.0.0.1:0');
        await expect(listen(`listen:${server.endpoint}`)).rejects.toThrow(/EADDRINUSE/);
        const socket = await listen(`listen:${socketEndpoint()}`);
        if (process.platform !== 'win32') {
            await expect(listen(`listen:${socket.endpoint}`)).rejects.toThrow(/EADDRINUSE/);
        }
    });

    it.each(['stdio', 'stdio:'])('starts %s through environment and releases process streams on disposal', async endpoint => {
        const input = new PassThrough();
        const output = new PassThrough();
        streams.push(input, output);
        vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
        vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as unknown as typeof process.stdout);
        vi.stubEnv('LINKRPC_ENDPOINT', endpoint);
        const server = await startEndpoint({ onConnection: serve });
        endpoints.push(server);
        expect(server.endpoint).toBe('stdio:');
        expect(input.listenerCount('data')).toBe(1);
        server.dispose();
        await server.closed;
        expect(input.listenerCount('data')).toBe(0);
        expect(input.listenerCount('end')).toBe(0);
        expect(input.isPaused()).toBe(true);
        expect(output.destroyed).toBe(false);
    });

    it('closes stdio and rejects outstanding calls when stdin ends', async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        streams.push(input, output);
        vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
        vi.spyOn(process, 'stdout', 'get').mockReturnValue(output as unknown as typeof process.stdout);
        let peer!: EndpointConnection;
        const endpoint = await startEndpoint({ endpoint: 'stdio:', onConnection: connection => { peer = connection; } });
        endpoints.push(endpoint);
        const pending = expect(new LinkRpcConnection(peer.channel).get(echo).ping('pending')).rejects.toThrow(/closed/i);
        input.end();
        await endpoint.closed;
        await pending;
    });

    it('releases the initialize timer/listener when an AbortSignal fires', async () => {
        const server = await listen('listen:ws://127.0.0.1:0');
        const socket = new WebSocket(server.endpoint);
        await new Promise<void>(resolve => socket.once('open', resolve));
        const transport = new WebSocketTransport(socket);
        const abort = new AbortController();
        const handshake = runInitializeHandshake(transport, {
            kind: 'server', isTokenAccepted: async () => true,
        }, { signal: abort.signal });
        abort.abort(new Error('cancelled'));
        await expect(handshake).rejects.toThrow('cancelled');
        transport.dispose();
    });
});
