import { type IMessageTransport, LinkRpcConnection } from '@hediet/linkrpc';
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
    /** Resolves to stop publishing. Defaults to the first SIGINT/SIGTERM. */
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
            await Promise.race([instance.closed, opts.stop ?? _untilSignalled()]);
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
        await (opts.stop ?? _untilSignalled());
        log('mcp-publish: stopping');
    } finally {
        await hosted.dispose();
    }
}

export interface McpServeOptions {
    /** Transport to the client, e.g. NDJSON on this process's stdin/stdout. */
    readonly transport: IMessageTransport;
    readonly name: string;
    readonly upstream: McpUpstreamConfig;
    readonly expose: McpServerConfig['expose'];
    readonly identities?: McpServerConfig['identities'];
    readonly description?: string;
    /** Resolves to stop serving. */
    readonly stop: Promise<void>;
    readonly log?: (line: string) => void;
}

/**
 * Serve one MCP server as the root service of a LinkRPC connection, without a
 * hub: e.g. `linkrpc ui --endpoint-cmd-stdio "linkrpc mcp-serve --service -- <mcp server>"`.
 */
export async function mcpServeCommand(opts: McpServeOptions): Promise<void> {
    const log = opts.log ?? ((line) => process.stderr.write(line + '\n'));
    // Requests wait until the tools are listed, so one-shot clients see every interface.
    const held = holdIncoming(opts.transport);
    const hosted = await hostMcpServer({
        connection: LinkRpcConnection.fromTransport(held.transport),
        serviceId: '',
        server: mcpServerConfigSchema.parse({
            id: opts.name,
            ...(opts.description !== undefined ? { description: opts.description } : {}),
            transport: opts.upstream,
            ...(opts.identities !== undefined ? { identities: opts.identities } : {}),
            expose: opts.expose,
        }),
        log,
        onRefreshError: (error) => log(`mcp-serve: tool refresh failed: ${error instanceof Error ? error.message : String(error)}`),
    });
    held.release();
    try {
        await opts.stop;
    } finally {
        await hosted.dispose();
    }
}

/** Defers delivering incoming messages until `release`; the transport buffers them meanwhile. */
function holdIncoming(inner: IMessageTransport): { readonly transport: IMessageTransport; release(): void } {
    let released = false;
    let listener: Parameters<IMessageTransport['setListener']>[0];
    return {
        transport: {
            send: (message) => inner.send(message),
            setListener: (value) => {
                listener = value;
                if (released) inner.setListener(value);
            },
            dispose: () => inner.dispose(),
        },
        release: () => {
            released = true;
            inner.setListener(listener);
        },
    };
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
