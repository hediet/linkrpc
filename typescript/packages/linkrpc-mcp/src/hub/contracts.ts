import { defineInterface, requestType } from "@hediet/linkrpc";
import { z } from "zod";

/*
 * LinkRPC contracts for publishing MCP servers on a hub. Specified in
 * `spec/10-mcp-interfaces.md`:
 *
 * - `mcp.forward`: transparent forwarding. One streaming `connect` request
 *   carries one complete MCP session as opaque JSON-RPC frames.
 * - `mcp.tools`: catalog of a typed bridge. Each MCP tool is also a method of
 *   the bridge's generated `mcp.tools.<name>` interface.
 * - `mcp.server`: lifecycle, authentication, and bridge-session state of a
 *   typed bridge.
 */

const forwardMembers = {
    connect: requestType(
        z.object({
            /** Informational identity of the consumer. */
            clientInfo: z.object({ name: z.string(), version: z.string() }).optional(),
        }),
        z.object({
            /** Informational identity of the upstream server, if known. */
            serverInfo: z.object({ name: z.string(), version: z.string() }).optional(),
        }),
        {
            description:
                "Open one MCP session leg. Resolves only when the session ends (the upstream "
                + "closes or the caller cancels). The MCP traffic is the stream, not the result.",
        },
    ).withStream({
        /** Caller → upstream MCP JSON-RPC message. */
        client: z.object({ frame: z.unknown() }),
        /** Upstream → caller MCP JSON-RPC message. */
        server: z.object({ frame: z.unknown() }),
    }),
};

/** Transparent MCP forwarding: one `connect` request is one MCP session leg. */
export const mcpForwardInterface = defineInterface(
    {
        id: "mcp.forward",
        description:
            "Transparent MCP tunnel: one streaming request carries a full MCP JSON-RPC "
            + "session as opaque duplex stream frames.",
    },
    forwardMembers,
);

/**
 * Previous id of {@link mcpForwardInterface}, served alongside it by producers
 * and accepted by consumers for compatibility with older peers.
 */
export const legacyMcpForwardInterface = defineInterface(
    {
        id: "vscode.mcp-forward",
        description: "Deprecated alias of mcp.forward.",
    },
    forwardMembers,
);

/** Interface ids that identify a forwarded MCP server, preferred first. */
export const mcpForwardInterfaceIds: readonly string[] = [
    mcpForwardInterface.info.id,
    legacyMcpForwardInterface.info.id,
];

const sessionParamsSchema = z.object({
    sessionId: z
        .string()
        .optional()
        .describe(
            "Exclusive bridge session returned by `mcp.server::openSession`. "
            + "Omitted means the shared session.",
        ),
});

const toolAnnotationsSchema = z
    .object({
        title: z.string().optional(),
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
        idempotentHint: z.boolean().optional(),
        openWorldHint: z.boolean().optional(),
    })
    .passthrough();

/** One MCP tool of a typed bridge and the generated method that invokes it. */
export const mcpCatalogToolSchema = z.object({
    name: z.string(),
    /** Member of the bridge's generated interface that invokes this tool. */
    method: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.unknown(),
    outputSchema: z.unknown().optional(),
    annotations: toolAnnotationsSchema.optional(),
});

export type McpCatalogTool = z.infer<typeof mcpCatalogToolSchema>;

export const mcpToolCatalogSchema = z.object({
    /** Generated interface (`mcp.tools.<name>`) whose methods invoke the tools. */
    interfaceId: z.string(),
    interfaceHash: z.string(),
    tools: z.array(mcpCatalogToolSchema),
});

export type McpToolCatalog = z.infer<typeof mcpToolCatalogSchema>;

/** Catalog of a typed bridge. Tools are invoked through the generated interface only. */
export const mcpToolsInterface = defineInterface(
    {
        id: "mcp.tools",
        description:
            "Catalog of the MCP tools of a typed bridge. Each tool is invoked through its "
            + "method on the generated `mcp.tools.<name>` interface, so capabilities apply per tool.",
    },
    {
        listTools: requestType(z.object({}), mcpToolCatalogSchema),
    },
);

/** Prefix of generated per-server tool interfaces. */
export const generatedMcpToolsInterfacePrefix = "mcp.tools.";

/** Complete MCP `CallToolResult`, as returned by every generated tool method. */
export const callToolResultSchema = z
    .object({
        content: z.array(z.unknown()),
        structuredContent: z.unknown().optional(),
        isError: z.boolean().optional(),
        _meta: z.unknown().optional(),
    })
    .passthrough();

export const mcpAuthenticationStateSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("not-required") }),
    z.object({ status: z.literal("checking") }),
    z.object({
        status: z.literal("authorization-required"),
        authorizationUri: z.string(),
        expiresAt: z.string(),
    }),
    z.object({
        status: z.literal("authorizing"),
        authorizationUri: z.string(),
        expiresAt: z.string(),
    }),
    z.object({
        status: z.literal("ready"),
        identityId: z.string().optional(),
        identityLabel: z.string().optional(),
        tokenExpiresAt: z.string().optional(),
    }),
    z.object({
        status: z.literal("error"),
        error: z.string(),
        authorizationUri: z.string().optional(),
    }),
]);

export type McpAuthenticationState = z.infer<typeof mcpAuthenticationStateSchema>;

export const mcpServerStateSchema = z.object({
    revision: z.number().int().nonnegative(),
    server: z.object({
        status: z.enum(["starting", "running", "idle", "stopping", "stopped", "error"]),
        error: z.string().optional(),
    }),
    transport: z.object({
        status: z.enum(["disconnected", "connecting", "connected", "error"]),
        error: z.string().optional(),
    }),
    authentication: mcpAuthenticationStateSchema,
    tools: z.object({
        status: z.enum(["unknown", "loading", "ready", "error"]),
        interfaceId: z.string().optional(),
        interfaceHash: z.string().optional(),
        count: z.number().int().nonnegative().optional(),
        error: z.string().optional(),
    }),
    session: z.object({
        sessionId: z.string(),
        status: z.enum(["absent", "opening", "ready", "closing", "closed", "error"]),
        error: z.string().optional(),
    }),
});

export type McpServerState = z.infer<typeof mcpServerStateSchema>;

/** Lifecycle, authentication, tool-catalog, and session state of a typed bridge. */
export const mcpServerInterface = defineInterface(
    {
        id: "mcp.server",
        description:
            "MCP server lifecycle, transport, authentication, tool-catalog, and bridge-session state.",
    },
    {
        getState: requestType(sessionParamsSchema, mcpServerStateSchema),
        watchState: requestType(sessionParamsSchema, z.object({})).withStream({
            server: mcpServerStateSchema,
        }),
        openSession: requestType(z.object({}), z.object({ sessionId: z.string() }), {
            description:
                "Open an exclusive MCP session (its own process or HTTP session) and return its "
                + "unguessable id. Pass it as `sessionId` to tool methods; holding the id is the "
                + "only way to use or close the session.",
        }),
        closeSession: requestType(sessionParamsSchema, z.object({ closed: z.boolean() })),
        restartSession: requestType(sessionParamsSchema, z.object({})),
    },
);
