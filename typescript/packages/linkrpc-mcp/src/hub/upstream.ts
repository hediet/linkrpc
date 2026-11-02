import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

/**
 * An MCP server reachable through one transport + auth combination. Each
 * {@link McpUpstream.createTransport} call yields a fresh, unstarted MCP client
 * transport, i.e. one new MCP session: a new process for stdio, a new
 * `Mcp-Session-Id` for Streamable HTTP. The caller starts and closes it.
 */
export interface McpUpstream {
    /** Human-readable description for logs; never contains credentials. */
    readonly label: string;
    createTransport(): Transport | Promise<Transport>;
}

export interface StdioUpstreamOptions {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    /**
     * Added to the MCP SDK's minimal default environment (`PATH`, `HOME`, ...).
     * Pass `process.env` explicitly to inherit everything.
     */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Defaults to `inherit`. */
    readonly stderr?: "inherit" | "ignore";
}

/** A local MCP server process speaking MCP stdio. */
export function stdioUpstream(options: StdioUpstreamOptions): McpUpstream {
    const env = options.env === undefined ? undefined : definedEntries(options.env);
    return {
        label: [options.command, ...(options.args ?? [])].join(" "),
        createTransport: () => new StdioClientTransport({
            command: options.command,
            args: [...(options.args ?? [])],
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            ...(env !== undefined ? { env } : {}),
            stderr: options.stderr ?? "inherit",
        }),
    };
}

export interface HttpUpstreamOptions {
    readonly url: string | URL;
    /** Static headers sent with every request. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Replaces `fetch`, e.g. to attach and refresh access tokens. */
    readonly fetch?: FetchLike;
    /** MCP SDK OAuth client provider, for servers using the MCP authorization flow. */
    readonly authProvider?: OAuthClientProvider;
}

/** A Streamable HTTP MCP server. */
export function httpUpstream(options: HttpUpstreamOptions): McpUpstream {
    const url = new URL(options.url);
    return {
        label: `${url.origin}${url.pathname}`,
        createTransport: () => new StreamableHTTPClientTransport(url, {
            ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
            ...(options.authProvider !== undefined ? { authProvider: options.authProvider } : {}),
            ...(options.headers !== undefined ? { requestInit: { headers: { ...options.headers } } } : {}),
        }),
    };
}

/**
 * A configured string: a literal, or `{ fromEnv }` to read it from an
 * environment variable when a session opens, so secrets stay out of config files.
 */
export const mcpConfigValueSchema = z.union([
    z.string(),
    z.object({ fromEnv: z.string().min(1) }).strict(),
]);

export type McpConfigValue = z.infer<typeof mcpConfigValueSchema>;

const configValuesSchema = z.record(z.string(), mcpConfigValueSchema);

/** JSON configuration of an upstream transport. */
export const mcpUpstreamConfigSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("stdio"),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        cwd: z.string().min(1).optional(),
        env: configValuesSchema.optional(),
    }),
    z.object({
        kind: z.literal("streamable-http"),
        url: z.string().url(),
        headers: configValuesSchema.optional(),
    }),
]);

export type McpUpstreamConfig = z.infer<typeof mcpUpstreamConfigSchema>;

export interface UpstreamFromConfigOptions {
    /** Replaces `fetch` of a streamable-http transport. */
    readonly fetch?: FetchLike;
    /** Environment for `{ fromEnv }` values; defaults to `process.env`. */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

export function upstreamFromConfig(
    config: McpUpstreamConfig,
    options: UpstreamFromConfigOptions = {},
): McpUpstream {
    const env = options.env ?? process.env;
    if (config.kind === "stdio") {
        if (options.fetch !== undefined) throw new Error("A fetch override requires a streamable-http transport");
        const label = [config.command, ...(config.args ?? [])].join(" ");
        return {
            label,
            createTransport: () => stdioUpstream({
                ...config,
                env: config.env === undefined ? undefined : resolveConfigValues(config.env, env),
            }).createTransport(),
        };
    }
    const label = httpUpstream({ url: config.url }).label;
    return {
        label,
        createTransport: () => httpUpstream({
            url: config.url,
            headers: config.headers === undefined ? undefined : resolveConfigValues(config.headers, env),
            fetch: options.fetch,
        }).createTransport(),
    };
}

export function resolveConfigValues(
    values: Readonly<Record<string, McpConfigValue>>,
    env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => {
        if (typeof value === "string") return [key, value];
        const resolved = env[value.fromEnv];
        if (resolved === undefined) throw new Error(`Environment variable ${value.fromEnv} is not set (for ${key})`);
        return [key, resolved];
    }));
}

function definedEntries(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
}
