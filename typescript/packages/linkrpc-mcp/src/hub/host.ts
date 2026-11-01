import type { InterfaceRegistration, LinkRpcConnection } from "@hediet/linkrpc";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { identitySessionFactory, type McpClientInfo } from "./clientSession";
import { serveMcpForward } from "./forward/producer";
import {
    type McpIdentities,
    mcpIdentityConfigSchema,
    serveMcpIdentities,
    singleMcpIdentity,
    staticMcpIdentities,
} from "./mcpIdentities";
import { type McpToolBridgeRegistration, registerMcpToolBridge } from "./service/bridge";
import { mcpUpstreamConfigSchema, upstreamFromConfig } from "./upstream";

/** How a hosted MCP server is published. At least one mode must be enabled. */
export const mcpToolGroupConfigSchema = z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    tools: z.array(z.string().min(1)).optional(),
    prefixes: z.array(z.string().min(1)).optional(),
    keywords: z.array(z.string().min(1)).optional(),
});

export const mcpExposeConfigSchema = z.object({
    /**
     * Publish the MCP server as a LinkRPC service: one method per tool, generic
     * `mcp.tools::listTools`/`callTool`, and `mcp.server`. One shared MCP session
     * for all callers, plus exclusive sessions on request.
     */
    service: z.object({
        /** Base generated interface id; defaults to `mcp.tools.<server id>`. */
        interfaceId: z.string().regex(/^mcp\.tools\.[a-z0-9][a-z0-9.-]*$/).optional(),
        /** Tools matching a group go to `<interfaceId>.<group name>` (first match wins). */
        groups: z.array(mcpToolGroupConfigSchema).optional(),
        session: z.object({
            idleTimeoutMs: z.number().int().positive().optional(),
            maxLifetimeMs: z.number().int().positive().optional(),
            maxSessions: z.number().int().positive().optional(),
        }).optional(),
    }).optional(),
    /** Verbatim MCP over `mcp.forward`; each connection gets its own upstream session. */
    forward: z.object({
        sharing: z.literal("exclusive").default("exclusive"),
    }).optional(),
}).refine((expose) => expose.service !== undefined || expose.forward !== undefined, {
    message: "Expose the MCP server as a service, forwarded, or both",
});

export const mcpServerConfigSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, "must contain only lowercase letters, digits, dots, and hyphens"),
    description: z.string().optional(),
    transport: mcpUpstreamConfigSchema,
    /**
     * Accounts, each adding env (stdio) or headers (streamable-http) to the
     * transport. Without it, the server has one identity, `default`.
     */
    identities: z.array(mcpIdentityConfigSchema).min(1).optional(),
    expose: mcpExposeConfigSchema.default({ service: {} }),
});

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export interface HostMcpServerOptions {
    readonly connection: LinkRpcConnection;
    /** Service id to publish under, e.g. `<namespace>/<server id>`. */
    readonly serviceId: string;
    readonly server: McpServerConfig;
    /**
     * The accounts to use, e.g. `oauthMcpIdentities(...)`. Replaces
     * `server.identities` and `server.transport`.
     */
    readonly identities?: McpIdentities;
    /** Replaces `fetch` for a configured streamable-http transport. */
    readonly fetch?: FetchLike;
    readonly clientInfo?: McpClientInfo;
    readonly onRefreshError?: (error: unknown) => void;
    readonly log?: (line: string) => void;
}

export interface HostedMcpServer {
    /** The MCP service bridge, if the server is exposed as a service. */
    readonly service: McpToolBridgeRegistration | undefined;
    readonly identities: McpIdentities;
    dispose(): Promise<void>;
}

/** Publish one configured MCP server on the hub in its configured modes. */
export async function hostMcpServer(options: HostMcpServerOptions): Promise<HostedMcpServer> {
    const { server } = options;
    const identities = options.identities
        ?? (server.identities !== undefined
            ? staticMcpIdentities(server.transport, server.identities, { fetch: options.fetch })
            : singleMcpIdentity(upstreamFromConfig(server.transport, { fetch: options.fetch })));
    const reflection = options.connection.enableReflection({ serviceId: options.serviceId });
    const identitiesRegistration = serveMcpIdentities({
        connection: options.connection,
        serviceId: options.serviceId,
        identities,
    });
    let forward: InterfaceRegistration | undefined;
    let service: McpToolBridgeRegistration | undefined;
    try {
        if (server.expose.forward !== undefined) {
            forward = serveMcpForward({
                connection: options.connection,
                serviceId: options.serviceId,
                identities,
                enableReflection: false,
                log: options.log,
            });
        }
        if (server.expose.service !== undefined) {
            service = await registerMcpToolBridge({
                connection: options.connection,
                serviceId: options.serviceId,
                interfaceId: server.expose.service.interfaceId ?? `mcp.tools.${server.id}`,
                groups: server.expose.service.groups,
                serviceDescription: server.description,
                factory: identitySessionFactory(identities, { clientInfo: options.clientInfo }),
                identities,
                enableReflection: false,
                ...server.expose.service.session,
                onRefreshError: options.onRefreshError,
                log: options.log,
            });
        }
    } catch (error) {
        forward?.dispose();
        identitiesRegistration.dispose();
        reflection.dispose();
        throw error;
    }
    return {
        service,
        identities,
        dispose: async () => {
            await service?.dispose();
            forward?.dispose();
            identitiesRegistration.dispose();
            reflection.dispose();
        },
    };
}
