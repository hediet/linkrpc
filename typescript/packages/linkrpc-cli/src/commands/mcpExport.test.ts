import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { LinkRpcConnection, TransportPair, type JsonValue } from '@hediet/linkrpc';
import { connectViaTransport, type CliChannel } from '@hediet/linkrpc-client-internal';
import { mcpForwardInterface, registerMcpToolBridge } from '@hediet/linkrpc-mcp/hub';
import { HubConfigSchema } from '@hediet/linkrpc-hub/config';
import { runHub } from '@hediet/linkrpc-hub/engine/runHub';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpExportCommand } from './mcp';

it('serves the hub MCP tools to several HTTP clients from one mcp-export process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'linkrpc-mcp-export-'));
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\linkrpc-mcp-export-${randomUUID()}` : join(directory, 'hub.sock');
    const endpoint = process.platform === 'win32'
        ? `npipe://./pipe/${socket.split('\\').at(-1)}?token=test`
        : `unix:${socket}?token=test`;
    const hub = await runHub({
        config: HubConfigSchema.parse({
            forwardChecking: false,
            listeners: [{ type: 'socket', path: socket, handlers: [
                { token: 'static', value: 'test', grantedServiceId: 'test' },
            ] }],
        }),
        identityStoreDir: join(directory, 'identity'),
        log: () => {},
    });
    const cli = fileURLToPath(new URL('../linkrpc.ts', import.meta.url));
    const cwd = fileURLToPath(new URL('../../', import.meta.url));
    const args = ['--import', 'tsx', cli, 'hub', '--endpoint', endpoint, '--no-sign'];
    const serverScript = fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url));
    const port = await freePort();
    const token = randomUUID();
    const url = new URL(`http://127.0.0.1:${port}/mcp`);

    const producer = spawn(process.execPath, [...args, 'mcp-publish', '--service', '--serviceId', './explorer',
        '--', process.execPath, serverScript], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const exporter = spawn(process.execPath, [...args, 'mcp-export', '--port', String(port), '--no-scripts'],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LINKRPC_MCP_EXPORT_TOKEN: token } });
    let log = '';
    producer.stderr!.on('data', chunk => { log += String(chunk); });
    exporter.stderr!.on('data', chunk => { log += String(chunk); });
    const connect = async (authorization: string) => {
        const client = new Client({ name: 'agent', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { Authorization: `Bearer ${authorization}` } },
        }));
        return client;
    };
    const clients: Client[] = [];
    try {
        await vi.waitFor(() => {
            expect(log).toContain("mcp-publish: claimed 'test/explorer'");
            expect(log).toContain(`mcp-export: listening at ${url.href}`);
        }, { timeout: 15_000 });

        await expect(connect('wrong')).rejects.toThrow();

        // Two agents share the process; each has its own MCP session.
        for (const message of ['first', 'second']) {
            const client = await connect(token);
            clients.push(client);
            let tools = await client.listTools();
            await vi.waitFor(async () => {
                tools = await client.listTools();
                expect(tools.tools.map(tool => tool.description)).toEqual(['[test/explorer] echo']);
            }, { timeout: 30_000, interval: 500 });
            expect(await client.callTool({ name: tools.tools[0].name, arguments: { message } }))
                .toEqual({ content: [{ type: 'text', text: JSON.stringify({ message }) }] });
        }

        // A request for an unknown session must start a new one (MCP Streamable HTTP).
        const stale = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': randomUUID(),
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        expect(stale.status).toBe(404);
    } finally {
        for (const client of clients) await client.close();
        const exited = [once(producer, 'exit'), once(exporter, 'exit')];
        producer.kill();
        exporter.kill();
        await Promise.all(exited);
        hub.dispose();
        await rm(directory, { recursive: true, force: true });
    }
}, 60_000);

it('shares one hub aggregator between all MCP sessions and ignores forwarded servers', async () => {
    const pair = new TransportPair();
    const hub = LinkRpcConnection.fromTransport(pair.a);
    hub.enableReflection();
    const bridge = await registerMcpToolBridge({
        connection: hub, serviceId: 'explorer', interfaceId: 'mcp.tools.explorer',
        factory: {
            open: async () => ({
                listTools: async () => [{ name: 'echo', inputSchema: { type: 'object' } }],
                callTool: async (_name, args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }) as JsonValue,
                close: async () => {},
            }),
        },
    });
    let forwardConnects = 0;
    hub.register(mcpForwardInterface, {
        connect: async () => { forwardConnects++; return {}; },
    }, { serviceId: 'forward-only' });
    const local = connectViaTransport(pair.b);
    const requests: string[] = [];
    const channel: CliChannel = {
        sendRequest: (method, params, options) => {
            requests.push(method);
            return local.channel.sendRequest(method, params, options);
        },
        sendRequestWithStream: (method, params, options) => {
            requests.push(method);
            return local.channel.sendRequestWithStream(method, params, options);
        },
        sendNotification: (method, params, options) => local.channel.sendNotification(method, params, options),
        close: () => local.channel.close(),
    };
    const port = await freePort();
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    let stop!: () => void;
    const exported = mcpExportCommand(channel, {
        port, authorizationToken: 'token', scripts: false, log: () => {},
        stop: new Promise<void>(resolve => { stop = resolve; }),
    });
    const connect = async () => {
        const client = new Client({ name: 'agent', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { Authorization: 'Bearer token' } },
        }));
        return client;
    };
    const clients: Client[] = [];
    try {
        clients.push(await vi.waitFor(connect));
        clients.push(await connect(), await connect());
        for (const client of clients) {
            expect((await client.listTools()).tools.map(tool => tool.description)).toEqual(['[explorer] echo']);
        }
        const counts = (method: string) => requests.filter(request => request === method).length;
        expect({
            rootDirectoryWatches: counts('hubrpc.directory::watch'),
            explorerListTools: counts('explorer::mcp.tools::listTools'),
            forwardConnects,
        }).toEqual({ rootDirectoryWatches: 1, explorerListTools: 1, forwardConnects: 0 });
    } finally {
        for (const client of clients) await client.close();
        stop();
        await exported;
        await bridge.dispose();
        local.close();
        hub.close();
    }
});

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')));
        });
    });
}
