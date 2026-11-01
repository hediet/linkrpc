import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HubConfigSchema } from '@hediet/linkrpc-hub/config';
import { runHub } from '@hediet/linkrpc-hub/engine/runHub';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type Case = {
    command: string[];
    consumer: string[];
    scriptTools: string[];
    /** Publish with `--mcp-config <file>` instead of a command. */
    config?: (serverScript: string) => unknown;
    expectedText?: string;
};

const scriptTools = ['runLinkRpcScript', 'awaitLinkRpcTask', 'cancelLinkRpcTask'];

it.each<Case>([
    { command: ['mcp-forward'], consumer: ['mcp', '--no-scripts'], scriptTools: [] },
    // The MCP server runs on its own; the producer forwards it over its own stdin/stdout.
    { command: ['mcp-forward', '--stdio'], consumer: ['mcp', '--no-scripts'], scriptTools: [] },
    { command: ['mcp-publish', '--service'], consumer: ['mcp', '--no-scripts'], scriptTools: [] },
    // The script tools are on by default.
    { command: ['mcp-publish', '--service', '--forward'], consumer: ['mcp'], scriptTools },
    // Two accounts in a config file; the consumer selects the non-default one.
    {
        command: ['mcp-publish'],
        config: (serverScript) => ({
            transport: { kind: 'stdio', command: process.execPath, args: [serverScript] },
            identities: [
                { id: 'work', env: { MCP_TEST_ACCOUNT: 'work' } },
                { id: 'home', default: true, env: { MCP_TEST_ACCOUNT: 'home' } },
            ],
            expose: { service: {} },
        }),
        consumer: ['mcp', '--no-scripts', '--mcp-identity', 'test/explorer=work'],
        scriptTools: [],
        expectedText: '{"message":"from the agent","account":"work"}',
    },
])('runs $command -> isolated Hub -> linkrpc hub $consumer -> stdio MCP client', async ({
    command, consumer, scriptTools, config, expectedText,
}: Case) => {
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
    const serverScript = fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url));
    const ownStdio = command.includes('--stdio');
    const configFile = join(directory, 'mcp.json');
    if (config) await writeFile(configFile, JSON.stringify(config(serverScript)));
    // `./explorer` is relative to the connection's granted namespace `test`.
    const producer = spawn(process.execPath, [...args, ...command, '--serviceId', './explorer',
        ...(config ? ['--mcp-config', configFile] : ownStdio ? [] : ['--', process.execPath, serverScript])],
    { cwd, stdio: [ownStdio ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const server = ownStdio ? spawn(process.execPath, [serverScript], { stdio: ['pipe', 'pipe', 'inherit'] }) : undefined;
    if (server) {
        server.stdout!.pipe(producer.stdin!);
        producer.stdout!.pipe(server.stdin!);
    }
    let producerLog = '';
    producer.stderr!.on('data', chunk => { producerLog += String(chunk); });
    const exited = once(producer, 'exit');
    const transport = new StdioClientTransport({
        command: process.execPath, args: [...args, ...consumer], cwd, stderr: 'pipe',
    });
    const client = new Client({ name: 'actual-agent', version: '1' });
    try {
        await vi.waitFor(() => {
            if (producer.exitCode !== null) throw new Error(`Producer exited: ${producerLog}`);
            expect(producerLog).toContain("mcp-publish: claimed 'test/explorer'");
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
            .toEqual({ content: [{ type: 'text', text: expectedText ?? '{"message":"from the agent"}' }] });
        await client.close();
        expect(producer.exitCode).toBeNull();
        expect(diagnostics).toContain('Connected to test/explorer');
    } finally {
        await client.close();
        producer.kill();
        server?.kill();
        await exited;
        hub.dispose();
        await rm(directory, { recursive: true, force: true });
    }
}, 60_000);

it('publishes an MCP server to an in-process hub with hub --endpoint-cmd', async () => {
    const cwd = fileURLToPath(new URL('../../', import.meta.url));
    const cliPath = fileURLToPath(new URL('../linkrpc.ts', import.meta.url));
    const server = `"${process.execPath}" "${fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url))}"`;
    const publisher = `"${process.execPath}" --import tsx "${cliPath}" hub mcp-publish --service --name demo -- ${server}`;
    const home = await mkdtemp(join(tmpdir(), 'linkrpc-mcp-local-hub-'));
    const run = (...commandArgs: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [
            '--import', 'tsx', cliPath, 'hub', '--context', ':empty', '--no-use-env',
            '--principal', `file:${join(home, 'identity.json')}`, ...commandArgs, '--endpoint-cmd', publisher,
        ], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.once('exit', code => resolve({ code, stdout, stderr }));
    });
    try {
        // The publisher claims the local hub's granted namespace, `local`, before the client connects.
        const listing = await run('ls');
        expect(listing.stdout).toContain('mcp.tools.demo');
        const call = await run('call', 'local::mcp.tools.demo::echo', '--p:message=hello');
        expect(call.code, call.stderr).toBe(0);
        expect(JSON.parse(call.stdout)).toEqual({ content: [{ type: 'text', text: '{"message":"hello"}' }] });
        // The publisher stops with its hub.
        expect(call.stderr).toContain('mcp-publish: the hub connection closed');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}, 60_000);
