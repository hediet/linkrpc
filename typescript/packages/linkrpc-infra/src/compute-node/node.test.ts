import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LinkRpcConnection, TransportPair } from '@hediet/linkrpc';
import { afterEach, describe, expect, it } from 'vitest';
import {
    type ComputeNodeCommandOutput,
    computeNodeCommandInterface,
    computeNodeFileSystemInterface,
    computeNodeHttpInterface,
    type ComputeNodeMultiplexedTcpServerFrame,
    computeNodeStatusInterface,
    computeNodeTcpForwardInterface,
} from './index';
import { registerComputeNode } from './node';

const temporaryDirectories: string[] = [];
const serviceId = 'test.compute';

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('compute node', () => {
    it('reports status', async () => {
        const { client, close } = createClient();
        try {
            const status = await client.service(serviceId).get(computeNodeStatusInterface).getStatus({});
            expect(status.hostname).not.toBe('');
            expect(status.username).not.toBe('');
            expect(status.cpu.logicalCores).toBeGreaterThan(0);
            expect(status.memory.totalBytes).toBeGreaterThan(0);
            expect(status.storage.length).toBeGreaterThan(0);
        } finally {
            close();
        }
    });

    it('runs a command without a shell and streams its output', async () => {
        const { client, close } = createClient();
        try {
            const streamed: ComputeNodeCommandOutput[] = [];
            const result = await client.service(serviceId).get(computeNodeCommandInterface).run(
                { command: process.execPath, args: ['-e', "process.stdout.write('out'); process.stderr.write('err')"], stdin: '' },
                { onMessage: output => streamed.push(output) },
            );
            expect(result).toMatchObject({ exitCode: 0, stdout: 'out', stderr: 'err', timedOut: false });
            expect(streamed.map(o => `${o.stream}:${o.text}`).sort()).toEqual(['stderr:err', 'stdout:out']);
        } finally {
            close();
        }
    });

    it('passes stdin and terminates a command after its timeout', async () => {
        const { client, close } = createClient();
        try {
            const command = client.service(serviceId).get(computeNodeCommandInterface);
            const echoed = await command.run({ command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], stdin: 'piped' });
            expect(echoed.stdout).toBe('piped');
            const timedOut = await command.run({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10_000)'], timeoutMs: 10 });
            expect(timedOut.timedOut).toBe(true);
        } finally {
            close();
        }
    });

    it('reads and writes files', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'compute-node-'));
        temporaryDirectories.push(directory);
        const filePath = path.join(directory, 'hello.txt');
        const { client, close } = createClient();
        try {
            const fs = client.service(serviceId).get(computeNodeFileSystemInterface);
            await expect(fs.writeFile({ path: filePath, contentBase64: Buffer.from('hello').toString('base64') }))
                .resolves.toMatchObject({ bytesWritten: 5 });
            await expect(fs.writeFile({ path: filePath, contentBase64: '', createNew: true })).rejects.toThrow();
            await expect(fs.stat({ path: filePath })).resolves.toMatchObject({ kind: 'file', sizeBytes: 5 });
            await expect(fs.readDirectory({ path: directory })).resolves.toMatchObject({
                entries: [{ name: 'hello.txt', kind: 'file' }],
                truncated: false,
            });
            const content = await fs.readFile({ path: filePath, offset: 1, length: 3 });
            expect({ text: Buffer.from(content.contentBase64, 'base64').toString(), eof: content.eof }).toEqual({ text: 'ell', eof: false });
            expect(await readFile(filePath, 'utf8')).toBe('hello');
        } finally {
            close();
        }
    });

    it('performs an HTTP request against loopback', async () => {
        const server = createHttpServer((request, response) => {
            response.statusCode = 201;
            response.setHeader('x-request-path', request.url ?? '');
            request.pipe(response);
        });
        const port = await listen(server);
        const { client, close } = createClient();
        try {
            const response = await client.service(serviceId).get(computeNodeHttpInterface).request({
                port,
                host: '127.0.0.1',
                method: 'POST',
                path: '/echo?value=1',
                bodyBase64: Buffer.from('body').toString('base64'),
            });
            expect(response.statusCode).toBe(201);
            expect(response.headers['x-request-path']).toBe('/echo?value=1');
            expect(Buffer.from(response.bodyBase64, 'base64').toString()).toBe('body');
        } finally {
            close();
            server.close();
        }
    });

    it('forwards a duplex byte stream to loopback', async () => {
        const server = createTcpServer(socket => socket.pipe(socket));
        const port = await listen(server);
        const { client, close } = createClient();
        try {
            const messages: string[] = [];
            const call = client.service(serviceId).get(computeNodeTcpForwardInterface).connect(
                { port, host: '127.0.0.1' },
                { onMessage: message => { if (message.type === 'data') messages.push(Buffer.from(message.dataBase64, 'base64').toString()); } },
            );
            await call.send({ type: 'data', dataBase64: Buffer.from('hello').toString('base64') });
            await waitUntil(() => messages.length === 1);
            expect(messages).toEqual(['hello']);
            await call.send({ type: 'end' });
            await expect(call).resolves.toEqual({ reason: 'clientEnded' });
        } finally {
            close();
            server.close();
        }
    });

    it('multiplexes concurrent TCP connections over one call', async () => {
        let acceptedConnections = 0;
        const server = createTcpServer(socket => {
            acceptedConnections++;
            socket.pipe(socket);
        });
        const port = await listen(server);
        const { client, close } = createClient();
        try {
            const messages: ComputeNodeMultiplexedTcpServerFrame[] = [];
            const call = client.service(serviceId).get(computeNodeTcpForwardInterface)
                .multiplex({ host: '127.0.0.1', port }, { onMessage: message => messages.push(message) });
            await waitUntil(() => messages.some(message => message.type === 'ready'));
            await Promise.all([
                call.send({ type: 'open', connectionId: 'first' }),
                call.send({ type: 'open', connectionId: 'second' }),
            ]);
            await waitUntil(() => messages.filter(message => message.type === 'opened').length === 2);
            await Promise.all([
                call.send({ type: 'data', connectionId: 'first', dataBase64: Buffer.from('one').toString('base64') }),
                call.send({ type: 'data', connectionId: 'second', dataBase64: Buffer.from('two').toString('base64') }),
            ]);
            await waitUntil(() => messages.filter(message => message.type === 'data').length === 2);
            expect(messages
                .flatMap(message => message.type === 'data' ? [`${message.connectionId}:${Buffer.from(message.dataBase64, 'base64').toString()}`] : [])
                .sort()).toEqual(['first:one', 'second:two']);
            expect(acceptedConnections).toBe(2);
            await Promise.all([
                call.send({ type: 'close', connectionId: 'first' }),
                call.send({ type: 'close', connectionId: 'second' }),
            ]);
            await waitUntil(() => messages.filter(message => message.type === 'closed').length === 2);
            call.cancel('test complete');
            await Promise.resolve(call).catch(() => undefined);
        } finally {
            close();
            server.close();
        }
    });
});

function createClient(): { client: LinkRpcConnection; close(): void; } {
    const pair = new TransportPair();
    const server = LinkRpcConnection.fromTransport(pair.a);
    const client = LinkRpcConnection.fromTransport(pair.b);
    registerComputeNode(server.service(serviceId));
    return { client, close: () => { client.close(); server.close(); } };
}

async function listen(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return address.port;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
