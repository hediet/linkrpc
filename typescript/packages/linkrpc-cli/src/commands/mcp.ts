import type { Readable, Writable } from 'node:stream';
import type { CliChannel } from '@hediet/linkrpc-client-internal';
import { HubMcpAggregator, McpToolHost, type HubMcpAggregatorOptions } from '@hediet/linkrpc-mcp/hub';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { HubAccessRequest, HubAccessResult } from '@hediet/linkrpc/hub/common';
import type { SignedCapability } from '@hediet/linkrpc';

export interface McpOptions {
    readonly input?: Readable;
    readonly output?: Writable;
    readonly requestDirectoryAccess?: (serviceId: string) => Promise<boolean>;
    readonly log?: (message: string) => void;
    readonly stop?: Promise<void>;
    /**
     * Also serve the LinkRPC script tools (`runLinkRpcScript`, ...) on the same
     * channel. Loads the QuickJS sandbox; `access` grows their grants.
     */
    readonly scripts?: boolean;
    /** MCP identity (account) per service id; other services use their default identity. */
    readonly mcpIdentities?: Readonly<Record<string, string>>;
    readonly access?: {
        listGrants(): readonly SignedCapability[];
        requestAccess(request: HubAccessRequest): Promise<HubAccessResult>;
    };
}

const clientInfo = { name: 'linkrpc-hub-mcp', version: '1.0.0' };

/**
 * Serve the tools of every MCP service published on the hub as one stdio MCP
 * server, optionally with the script tools.
 */
export async function mcpCommand(channel: CliChannel, options: McpOptions = {}): Promise<void> {
    const log = options.log ?? (message => { process.stderr.write(`linkrpc mcp: ${message}\n`); });
    const aggregatorOptions = hubMcpAggregatorOptions(options, log);
    const transport = new StdioServerTransport(options.input ?? process.stdin, options.output ?? process.stdout);
    const input = options.input ?? process.stdin;
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    input.once('end', stop);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const until = (ready: Promise<void>) => Promise.race([
        ready.then(() => options.stop ? Promise.race([stopped, options.stop]) : stopped),
        stopped,
        ...(options.stop ? [options.stop] : []),
    ]);
    try {
        if (options.scripts) {
            const { LinkRpcMcpServer, singleConnectionPool } = await import('@hediet/linkrpc-mcp');
            const server = new LinkRpcMcpServer({
                pool: singleConnectionPool(channel, options.access ?? unsignedAccess, 'cli'),
                hubTools: aggregatorOptions,
            });
            try {
                await server.connect(transport);
                await until(Promise.resolve());
            } finally {
                server.dispose();
            }
            return;
        }
        const aggregator = new HubMcpAggregator(channel, aggregatorOptions);
        const server = new Server(clientInfo, { capabilities: { tools: { listChanged: true } } });
        new McpToolHost(server).addSource(aggregator);
        server.onerror = error => log(`MCP protocol error: ${error.message}`);
        server.onclose = stop;
        try {
            await server.connect(transport);
            await until(aggregator.ready);
        } finally {
            await aggregator.dispose();
            await server.close();
        }
    } finally {
        input.off('end', stop);
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}

function hubMcpAggregatorOptions(
    options: Pick<McpOptions, 'requestDirectoryAccess' | 'mcpIdentities'>,
    log: (message: string) => void,
): HubMcpAggregatorOptions {
    return {
        requestDirectoryAccess: options.requestDirectoryAccess,
        log,
        ...(options.mcpIdentities !== undefined
            ? { mcpIdentityFor: (serviceId: string) => options.mcpIdentities?.[serviceId] }
            : {}),
    };
}

const unsignedAccess: NonNullable<McpOptions['access']> = {
    listGrants: () => [],
    requestAccess: async () => ({ status: 'denied', reason: 'This connection does not sign calls.' }) as HubAccessResult,
};

export interface McpExportOptions {
    /** Loopback TCP port to listen on. */
    readonly port: number;
    /** Bearer token clients must send in the `Authorization` header. */
    readonly authorizationToken: string;
    readonly scripts?: boolean;
    readonly mcpIdentities?: Readonly<Record<string, string>>;
    readonly requestDirectoryAccess?: (serviceId: string) => Promise<boolean>;
    readonly access?: McpOptions['access'];
    readonly idleSessionTimeoutMs?: number;
    readonly log?: (message: string) => void;
    /** Resolves when the export should stop. */
    readonly stop: Promise<void>;
}

/**
 * Serve what {@link mcpCommand} serves over Streamable HTTP on a loopback port,
 * so many MCP clients share one process and one hub connection. All MCP
 * sessions share one {@link HubMcpAggregator} (one directory watch, one tool
 * list); every session gets its own script state.
 */
export async function mcpExportCommand(channel: CliChannel, options: McpExportOptions): Promise<void> {
    const log = options.log ?? (message => { process.stderr.write(`linkrpc mcp-export: ${message}\n`); });
    const { singleConnectionPool } = await import('@hediet/linkrpc-mcp');
    const { McpSocketHost } = await import('@hediet/linkrpc-mcp/node');
    const access = options.access ?? unsignedAccess;
    const hubTools = new HubMcpAggregator(channel, hubMcpAggregatorOptions(options, log));
    hubTools.ready.catch(error => log(`hub MCP tools unavailable: ${error instanceof Error ? error.message : String(error)}`));
    let host: InstanceType<typeof McpSocketHost> | undefined;
    try {
        host = await McpSocketHost.start({
            transport: 'http',
            port: options.port,
            authorizationToken: options.authorizationToken,
            ...(options.idleSessionTimeoutMs !== undefined ? { idleSessionTimeoutMs: options.idleSessionTimeoutMs } : {}),
            log,
            createSession: async ({ sessionId }) => ({
                serverOptions: {
                    pool: singleConnectionPool(channel, access, `mcp-export:${sessionId}`),
                    scriptTools: options.scripts !== false,
                    sharedHubTools: hubTools,
                },
            }),
        });
        const endpoint = host.endpoint;
        if (endpoint.kind === 'tcp') log(`listening at http://${endpoint.host}:${endpoint.port}${endpoint.requestPath}`);
        await options.stop;
    } finally {
        host?.dispose();
        await hubTools.dispose();
    }
}
