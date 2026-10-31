import type { InterfaceRegistration, LinkRpcConnection } from "@hediet/linkrpc";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { type McpClientInfo, upstreamSessionFactory } from "./clientSession";
import type { McpAuthenticationState } from "./contracts";
import { serveMcpForward } from "./forward/producer";
import { type McpToolBridgeRegistration, registerMcpToolBridge } from "./typed/bridge";
import { mcpUpstreamConfigSchema, upstreamFromConfig } from "./upstream";

/** How a hosted MCP server is published. At least one mode must be enabled. */
export const mcpExposeConfigSchema = z.object({
    /** One shared MCP session for all callers; one LinkRPC method per tool. */
    typed: z.object({
        /** Generated interface id; defaults to `mcp.tools.<server id>`. */
        interfaceId: z.string().regex(/^mcp\.tools\.[a-z0-9][a-z0-9.-]*$/).optional(),
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
}).refine((expose) => expose.typed !== undefined || expose.forward !== undefined, {
    message: "Expose the MCP server typed, forwarded, or both",
});

export const mcpServerConfigSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, "must contain only lowercase letters, digits, dots, and hyphens"),
    description: z.string().optional(),
    transport: mcpUpstreamConfigSchema,
    expose: mcpExposeConfigSchema.default({ typed: {} }),
});

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export interface HostMcpServerOptions {
    readonly connection: LinkRpcConnection;
    /** Service id to publish under, e.g. `<namespace>/<server id>`. */
    readonly serviceId: string;
    readonly server: McpServerConfig;
    /** Replaces `fetch` for a streamable-http transport, e.g. to attach access tokens. */
    readonly fetch?: FetchLike;
    readonly clientInfo?: McpClientInfo;
    readonly initialAuthenticationState?: McpAuthenticationState;
    readonly onRefreshError?: (error: unknown) => void;
    readonly log?: (line: string) => void;
}

export interface HostedMcpServer {
    /** The typed bridge, if the server is exposed typed. */
    readonly typed: McpToolBridgeRegistration | undefined;
    dispose(): Promise<void>;
}

/** Publish one configured MCP server on the hub in its configured modes. */
export async function hostMcpServer(options: HostMcpServerOptions): Promise<HostedMcpServer> {
    const { server } = options;
    const upstream = upstreamFromConfig(server.transport, { fetch: options.fetch });
    const reflection = options.connection.enableReflection({ serviceId: options.serviceId });
    let forward: InterfaceRegistration | undefined;
    let typed: McpToolBridgeRegistration | undefined;
    try {
        if (server.expose.forward !== undefined) {
            forward = serveMcpForward({
                connection: options.connection,
                serviceId: options.serviceId,
                upstream,
                enableReflection: false,
                log: options.log,
            });
        }
        if (server.expose.typed !== undefined) {
            typed = await registerMcpToolBridge({
                connection: options.connection,
                serviceId: options.serviceId,
                interfaceId: server.expose.typed.interfaceId ?? `mcp.tools.${server.id}`,
                serviceDescription: server.description,
                factory: upstreamSessionFactory(upstream, { clientInfo: options.clientInfo }),
                enableReflection: false,
                ...server.expose.typed.session,
                initialAuthenticationState: options.initialAuthenticationState,
                onRefreshError: options.onRefreshError,
            });
        }
    } catch (error) {
        forward?.dispose();
        reflection.dispose();
        throw error;
    }
    return {
        typed,
        dispose: async () => {
            await typed?.dispose();
            forward?.dispose();
            reflection.dispose();
        },
    };
}
