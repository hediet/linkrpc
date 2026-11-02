import { ErrorCode, type InterfaceRegistration, type LinkRpcConnection, RpcError } from "@hediet/linkrpc";
import { z } from "zod";
import { type McpAuthenticationState, mcpIdentitiesInterface, mcpIdentityIdPattern } from "./contracts";
import {
    mcpConfigValueSchema,
    type McpUpstream,
    type McpUpstreamConfig,
    upstreamFromConfig,
    type UpstreamFromConfigOptions,
} from "./upstream";

/** An account a published MCP server can be used with. */
export interface McpIdentityInfo {
    readonly id: string;
    readonly label?: string;
    /** Calls without `mcpIdentity` use the default identity (else the first one). */
    readonly default?: boolean;
}

/**
 * The MCP identities of a published MCP server. Each identity is one transport
 * + authentication combination: e.g. a token per HTTP account, or environment
 * variables per stdio process.
 */
export interface McpIdentities {
    list(): readonly McpIdentityInfo[];
    /** Fires when the list or an authentication state changes. */
    onDidChange(listener: () => void): { dispose(): void };
    /** A fresh upstream for `identityId`; throws for unknown ids. */
    upstream(identityId: string): McpUpstream;
    authentication(identityId: string): McpAuthenticationState;
    /** Start signing in a new identity, if supported. */
    authorize?(): Promise<{ readonly authorizationUri: string; readonly expiresAt?: string }>;
    dispose?(): void;
}

/** The identity used when a call omits `mcpIdentity`. */
export function defaultMcpIdentity(identities: readonly McpIdentityInfo[]): McpIdentityInfo | undefined {
    return identities.find((identity) => identity.default === true) ?? identities[0];
}

export function assertMcpIdentities(identities: readonly McpIdentityInfo[]): void {
    const ids = new Set<string>();
    for (const identity of identities) {
        if (!mcpIdentityIdPattern.test(identity.id)) throw new Error(`Invalid MCP identity id: ${identity.id}`);
        if (ids.has(identity.id)) throw new Error(`Duplicate MCP identity: ${identity.id}`);
        ids.add(identity.id);
    }
    if (identities.filter((identity) => identity.default === true).length > 1) {
        throw new Error("At most one MCP identity can be the default");
    }
}

/** One fixed identity, e.g. a server without accounts or with one static token. */
export function singleMcpIdentity(
    upstream: McpUpstream,
    options: { readonly id?: string; readonly label?: string } = {},
): McpIdentities {
    const identity: McpIdentityInfo = {
        id: options.id ?? "default",
        ...(options.label !== undefined ? { label: options.label } : {}),
        default: true,
    };
    assertMcpIdentities([identity]);
    return {
        list: () => [identity],
        onDidChange: () => ({ dispose: () => {} }),
        upstream: (identityId) => {
            if (identityId !== identity.id) throw new Error(`Unknown MCP identity: ${identityId}`);
            return upstream;
        },
        authentication: () => ({ status: "not-required" }),
    };
}

export const mcpIdentityConfigSchema = z.object({
    id: z.string().regex(mcpIdentityIdPattern),
    label: z.string().optional(),
    default: z.boolean().optional(),
    /** Added to a stdio transport's environment. */
    env: z.record(z.string(), mcpConfigValueSchema).optional(),
    /** Added to a streamable-http transport's headers. */
    headers: z.record(z.string(), mcpConfigValueSchema).optional(),
});

export type McpIdentityConfig = z.infer<typeof mcpIdentityConfigSchema>;

/**
 * Identities from configuration: each adds environment variables (stdio) or
 * headers (streamable-http), typically `{ fromEnv }` secrets, to `transport`.
 */
export function staticMcpIdentities(
    transport: McpUpstreamConfig,
    identities: readonly McpIdentityConfig[],
    options: UpstreamFromConfigOptions = {},
): McpIdentities {
    assertMcpIdentities(identities);
    const upstreams = new Map(identities.map((identity) => {
        if (transport.kind === "stdio" && identity.headers !== undefined) {
            throw new Error(`MCP identity '${identity.id}' sets headers on a stdio transport`);
        }
        if (transport.kind === "streamable-http" && identity.env !== undefined) {
            throw new Error(`MCP identity '${identity.id}' sets env on a streamable-http transport`);
        }
        const config: McpUpstreamConfig = transport.kind === "stdio"
            ? { ...transport, env: { ...transport.env, ...identity.env } }
            : { ...transport, headers: { ...transport.headers, ...identity.headers } };
        return [identity.id, upstreamFromConfig(config, options)] as const;
    }));
    const infos = identities.map(({ id, label, default: isDefault }): McpIdentityInfo => ({
        id,
        ...(label !== undefined ? { label } : {}),
        ...(isDefault !== undefined ? { default: isDefault } : {}),
    }));
    return {
        list: () => infos,
        onDidChange: () => ({ dispose: () => {} }),
        upstream: (identityId) => {
            const upstream = upstreams.get(identityId);
            if (upstream === undefined) throw new Error(`Unknown MCP identity: ${identityId}`);
            return upstream;
        },
        authentication: () => ({ status: "not-required" }),
    };
}

/** Serve `mcp.identities` for `identities` under `serviceId`. */
export function serveMcpIdentities(options: {
    readonly connection: LinkRpcConnection;
    readonly serviceId: string;
    readonly identities: McpIdentities;
}): InterfaceRegistration {
    const { identities } = options;
    return options.connection.register(mcpIdentitiesInterface, {
        list: async () => {
            const list = identities.list();
            const fallback = defaultMcpIdentity(list);
            return {
                identities: list.map((identity) => ({
                    id: identity.id,
                    ...(identity.label !== undefined ? { label: identity.label } : {}),
                    default: identity === fallback,
                    authentication: identities.authentication(identity.id),
                })),
            };
        },
        authorize: async () => {
            if (identities.authorize === undefined) {
                throw new RpcError("This MCP server cannot sign in further identities", ErrorCode.invalidRequest);
            }
            return { ...(await identities.authorize()) };
        },
    }, { serviceId: options.serviceId });
}

/**
 * The identity a call selects with `mcpIdentity`, or the default one. Throws
 * an `invalidParams` error for unknown ids.
 */
export function resolveMcpIdentity(identities: McpIdentities, mcpIdentity: string | undefined): string {
    const list = identities.list();
    if (mcpIdentity !== undefined) {
        if (!list.some((identity) => identity.id === mcpIdentity)) {
            throw new RpcError(`Unknown MCP identity: ${mcpIdentity}`, ErrorCode.invalidParams);
        }
        return mcpIdentity;
    }
    const fallback = defaultMcpIdentity(list);
    if (fallback === undefined) {
        throw new RpcError(
            "No MCP identity is available; sign one in with mcp.identities::authorize",
            ErrorCode.invalidRequest,
        );
    }
    return fallback.id;
}
