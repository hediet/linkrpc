import { LinkRpcConnection } from '@hediet/linkrpc';
import { hubGrantedServiceIdInterface } from '@hediet/linkrpc/hub/common';
import type { CliConnection } from '@hediet/linkrpc-client-internal';
import {
    hostMcpServer,
    mcpServerConfigSchema,
    type McpServerConfig,
    type McpUpstreamConfig,
} from '@hediet/linkrpc-mcp/hub';

/**
 * Front door for claiming a serviceId within the connection's granted
 * namespace — interface-form `hubGrantedServiceId::register`. Same claim the
 * `tunnel` command uses.
 */
const CLAIM_METHOD = `${hubGrantedServiceIdInterface.info.id}::register`;

/** Read-only connection facts — `hubGrantedServiceId::get`. */
const INFO_METHOD = `${hubGrantedServiceIdInterface.info.id}::get`;

export interface McpPublishOptions {
    /**
     * Prefix to claim on the hub. When omitted, the connection's granted
     * serviceId namespace (`hubGrantedServiceId::get`) is claimed as-is.
     */
    readonly serviceId?: string;
    /** Live, signed connection to the hub we claim `serviceId` on and serve from. */
    readonly local: CliConnection;
    /** Name of the generated `mcp.tools.<name>` interface; derived from the service id by default. */
    readonly name?: string;
    readonly transport: McpUpstreamConfig;
    readonly expose: McpServerConfig['expose'];
    /** Resolves to stop publishing. Defaults to the first SIGINT/SIGTERM. */
    readonly stop?: Promise<void>;
    /** Sink for human-readable status lines (defaults to stderr). */
    readonly log?: (line: string) => void;
}

/**
 * Publish one MCP server on the hub until stopped: typed (one LinkRPC method
 * per tool, one shared MCP session), forwarded (verbatim MCP over
 * `mcp.forward`, one upstream session per connection), or both.
 */
export async function mcpPublishCommand(opts: McpPublishOptions): Promise<void> {
    const log = opts.log ?? ((line) => process.stderr.write(line + '\n'));
    const serviceId = opts.serviceId ?? await _resolveGrantedServiceId(opts.local);
    const connection = new LinkRpcConnection(opts.local.rpcChannel);
    // Register before claiming, so no call can arrive before its handler exists.
    const hosted = await hostMcpServer({
        connection,
        serviceId,
        server: mcpServerConfigSchema.parse({
            id: opts.name ?? interfaceNameFor(serviceId),
            transport: opts.transport,
            expose: opts.expose,
        }),
        log,
        onRefreshError: (error) => log(`mcp-publish: tool refresh failed: ${error instanceof Error ? error.message : String(error)}`),
    });
    try {
        await opts.local.channel.sendRequest(CLAIM_METHOD, { serviceId });
        const modes = [opts.expose.typed && 'typed', opts.expose.forward && 'forwarded'].filter(Boolean).join(' and ');
        log(`mcp-publish: claimed '${serviceId}' — publishing ${_describe(opts.transport)} ${modes}`);
        await (opts.stop ?? _untilSignalled());
        log('mcp-publish: stopping');
    } finally {
        await hosted.dispose();
    }
}

/** A valid `mcp.tools.<name>` suffix for `serviceId`, e.g. `my/MCP_server` → `my.mcp-server`. */
export function interfaceNameFor(serviceId: string): string {
    const name = serviceId
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '.')
        .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    return name.length > 0 ? name : 'server';
}

async function _resolveGrantedServiceId(local: CliConnection): Promise<string> {
    const info = await local.channel.sendRequest(INFO_METHOD, {}) as {
        grantedServiceIdNamespace?: string;
    } | null | undefined;
    const granted = info?.grantedServiceIdNamespace ?? '';
    if (granted.length === 0) {
        throw new Error(
            'mcp-publish: this connection has no granted serviceId namespace to claim; '
            + 'pass an explicit --serviceId.',
        );
    }
    return granted;
}

function _untilSignalled(): Promise<void> {
    return new Promise<void>((resolve) => {
        const done = (): void => {
            process.removeListener('SIGINT', done);
            process.removeListener('SIGTERM', done);
            resolve();
        };
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
    });
}

function _describe(transport: McpUpstreamConfig): string {
    return transport.kind === 'stdio' ? [transport.command, ...(transport.args ?? [])].join(' ') : transport.url;
}
