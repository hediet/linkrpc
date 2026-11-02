import { LinkRpcConnection } from '@hediet/linkrpc';
import type { CliConnection } from '@hediet/linkrpc-client-internal';
import { readFile } from 'node:fs/promises';
import {
    hostMcpServer,
    mcpExposeConfigSchema,
    mcpServerConfigSchema,
    type McpServerConfig,
    type McpUpstreamConfig,
    serveMcpForwardInstance,
    streamInstanceTransport,
} from '@hediet/linkrpc-mcp/hub';

import { claimServiceId, resolveServiceIdToClaim } from './serviceIdClaim';

export interface McpPublishOptions {
    /**
     * Prefix to claim on the hub. `./<name>` is relative to the connection's
     * granted namespace (or a namespace made up for this user and host). When
     * omitted, the granted namespace itself is claimed.
     */
    readonly serviceId?: string;
    /** Live, signed connection to the hub we claim `serviceId` on and serve from. */
    readonly local: CliConnection;
    /** Name of the generated `mcp.tools.<name>` interface; derived from the service id by default. */
    readonly name?: string;
    /**
     * The MCP server: a command (a fresh process per MCP session), a Streamable
     * HTTP URL, or `own-stdio`: one running server attached to this process's
     * stdin/stdout, forwarded to one connection at a time.
     */
    readonly transport: McpUpstreamConfig | { readonly kind: 'own-stdio' };
    readonly expose: McpServerConfig['expose'];
    /** Accounts (MCP identities), each adding env vars or headers to `transport`. */
    readonly identities?: McpServerConfig['identities'];
    readonly description?: string;
    /**
     * Resolves to stop publishing. Defaults to the first SIGINT/SIGTERM. The
     * command also stops, with a non-zero exit code, when the hub connection closes.
     */
    readonly stop?: Promise<void>;
    /** Sink for human-readable status lines (defaults to stderr). */
    readonly log?: (line: string) => void;
}

/**
 * Publish one MCP server on the hub until stopped: as a service (one LinkRPC
 * method per tool plus generic `mcp.tools`, one shared MCP session), forwarded
 * (verbatim MCP over `mcp.forward`), or both.
 */
export async function mcpPublishCommand(opts: McpPublishOptions): Promise<void> {
    const log = opts.log ?? ((line) => process.stderr.write(line + '\n'));
    // Without the hub, the published server is unreachable: stop so a supervisor can restart it.
    const stop = Promise.race([
        opts.stop ?? _untilSignalled(),
        opts.local.closed.then(() => {
            log('mcp-publish: the hub connection closed');
            process.exitCode = 1;
        }),
    ]);
    const resolved = await resolveServiceIdToClaim(opts.local, opts.serviceId);
    const serviceId = resolved.serviceId;
    const connection = new LinkRpcConnection(opts.local.rpcChannel);
    if (opts.transport.kind === 'own-stdio') {
        if (opts.expose.service !== undefined || opts.expose.forward === undefined) {
            throw new Error('mcp-publish: an MCP server on this process\'s stdio can only be forwarded.');
        }
        const instance = serveMcpForwardInstance({
            connection,
            serviceId,
            transport: streamInstanceTransport(process.stdin, process.stdout),
            log,
        });
        try {
            await claimServiceId(opts.local, serviceId);
            log(`mcp-publish: claimed '${serviceId}' — forwarding the MCP server on stdio to one connection at a time`);
            await Promise.race([instance.closed, stop]);
            log('mcp-publish: stopping');
        } finally {
            instance.dispose();
        }
        return;
    }
    const transport = opts.transport;
    // Register before claiming, so no call can arrive before its handler exists.
    const hosted = await hostMcpServer({
        connection,
        serviceId,
        server: mcpServerConfigSchema.parse({
            id: opts.name ?? interfaceNameFor(resolved.relative ?? serviceId),
            ...(opts.description !== undefined ? { description: opts.description } : {}),
            transport,
            ...(opts.identities !== undefined ? { identities: opts.identities } : {}),
            expose: opts.expose,
        }),
        log,
        onRefreshError: (error) => log(`mcp-publish: tool refresh failed: ${error instanceof Error ? error.message : String(error)}`),
    });
    try {
        await claimServiceId(opts.local, serviceId);
        const modes = [opts.expose.service && 'as a service', opts.expose.forward && 'forwarded'].filter(Boolean).join(' and ');
        log(`mcp-publish: claimed '${serviceId}' — publishing ${_describe(transport)} ${modes}`);
        await stop;
        log('mcp-publish: stopping');
    } finally {
        await hosted.dispose();
    }
}

/** `mcp-publish --mcp-config` file: a server config whose `id` and `expose` may come from flags. */
export const mcpPublishConfigSchema = mcpServerConfigSchema.extend({
    id: mcpServerConfigSchema.shape.id.optional(),
    expose: mcpExposeConfigSchema.optional(),
});

export async function readMcpPublishConfig(path: string) {
    let json: unknown;
    try {
        json = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        throw new Error(`mcp-publish: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = mcpPublishConfigSchema.safeParse(json);
    if (!parsed.success) throw new Error(`mcp-publish: invalid ${path}: ${parsed.error.message}`);
    return parsed.data;
}

/** A valid `mcp.tools.<name>` suffix for `serviceId`, e.g. `my/MCP_server` → `my.mcp-server`. */
export function interfaceNameFor(serviceId: string): string {
    const name = serviceId
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '.')
        .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    return name.length > 0 ? name : 'server';
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
