import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HubConfigSchema } from '@hediet/linkrpc-hub/config';
import { runHub } from '@hediet/linkrpc-hub/engine/runHub';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it.each([
    { command: ['mcp-forward'], consumer: ['mcp'], scriptTools: [] },
    { command: ['mcp-publish', '--typed'], consumer: ['mcp'], scriptTools: [] },
    {
        command: ['mcp-publish', '--typed', '--forward'],
        consumer: ['mcp', '--scripts'],
        scriptTools: ['runLinkRpcScript', 'awaitLinkRpcTask', 'cancelLinkRpcTask'],
    },
])('runs $command -> isolated Hub -> linkrpc hub $consumer -> stdio MCP client', async ({ command, consumer, scriptTools }) => {
    const directory = await mkdtemp(join(tmpdir(), 'linkrpc-mcp-'));
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\linkrpc-mcp-${randomUUID()}` : join(directory, 'hub.sock');
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
    const producer = spawn(process.execPath, [...args, ...command, '--serviceId', 'test/explorer', '--',
        process.execPath, fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url))],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let producerLog = '';
    producer.stderr.on('data', chunk => { producerLog += String(chunk); });
    const exited = once(producer, 'exit');
    const transport = new StdioClientTransport({
        command: process.execPath, args: [...args, ...consumer], cwd, stderr: 'pipe',
    });
    const client = new Client({ name: 'actual-agent', version: '1' });
    try {
        await vi.waitFor(() => {
            if (producer.exitCode !== null) throw new Error(`Producer exited: ${producerLog}`);
            expect(producerLog).toContain("mcp-publish: claimed");
        }, { timeout: 15_000 });
        let diagnostics = '';
        transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
        await client.connect(transport);
        // A cold first producer can miss the aggregator's connect timeout; it retries while advertised.
        let tools = await client.listTools();
        await vi.waitFor(async () => {
            tools = await client.listTools();
            expect(tools.tools).toHaveLength(scriptTools.length + 1);
        }, { timeout: 30_000, interval: 500 });
        expect(tools.tools.slice(0, scriptTools.length).map(tool => tool.name)).toEqual(scriptTools);
        const hubTools = tools.tools.slice(scriptTools.length);
        expect(hubTools.map(tool => tool.description)).toEqual(['[test/explorer] echo']);
        expect(await client.callTool({ name: hubTools[0].name, arguments: { message: 'from the agent' } }))
            .toEqual({ content: [{ type: 'text', text: '{"message":"from the agent"}' }] });
        await client.close();
        expect(producer.exitCode).toBeNull();
        expect(diagnostics).toContain('Connected to test/explorer');
    } finally {
        await client.close();
        producer.kill();
        await exited;
        hub.dispose();
        await rm(directory, { recursive: true, force: true });
    }
}, 60_000);
