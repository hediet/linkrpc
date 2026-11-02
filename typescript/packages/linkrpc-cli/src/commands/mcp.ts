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
 * Serve the tools of every MCP server published on the hub (MCP services and
 * forwarded servers) as one stdio MCP server, optionally with the script tools.
 */
export async function mcpCommand(channel: CliChannel, options: McpOptions = {}): Promise<void> {
    const log = options.log ?? (message => { process.stderr.write(`linkrpc mcp: ${message}\n`); });
    const aggregatorOptions: HubMcpAggregatorOptions = {
        requestDirectoryAccess: options.requestDirectoryAccess,
        log,
        clientInfo,
        ...(options.mcpIdentities !== undefined
            ? { mcpIdentityFor: (serviceId: string) => options.mcpIdentities?.[serviceId] }
            : {}),
    };
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

const unsignedAccess: NonNullable<McpOptions['access']> = {
    listGrants: () => [],
    requestAccess: async () => ({ status: 'denied', reason: 'This connection does not sign calls.' }) as HubAccessResult,
};
