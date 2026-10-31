import type { JsonValue } from "@hediet/linkrpc";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpUpstream } from "./upstream";

export type McpToolDefinition = Pick<
    Tool,
    "name" | "title" | "description" | "inputSchema" | "outputSchema" | "annotations"
>;

/** One live MCP client session, as used by the typed bridge. */
export interface McpClientSession {
    listTools(signal?: AbortSignal): Promise<readonly McpToolDefinition[]>;
    callTool(
        name: string,
        args: Readonly<Record<string, unknown>> | undefined,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    close(): Promise<void>;
}

export interface OpenMcpSessionContext {
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly onToolsChanged: () => void;
}

export interface McpSessionFactory {
    open(context: OpenMcpSessionContext): Promise<McpClientSession>;
}

export interface McpClientInfo {
    readonly name: string;
    readonly version: string;
}

const defaultClientInfo: McpClientInfo = { name: "linkrpc-mcp", version: "1.0.0" };

/** Opens one SDK MCP client session per bridge session on `upstream`. */
export function upstreamSessionFactory(
    upstream: McpUpstream,
    options: { readonly clientInfo?: McpClientInfo } = {},
): McpSessionFactory {
    return {
        open: async (context) => {
            const client = new Client({ ...(options.clientInfo ?? defaultClientInfo) }, {
                capabilities: {},
                listChanged: {
                    tools: {
                        autoRefresh: false,
                        onChanged: (error) => {
                            if (error === null || error === undefined) context.onToolsChanged();
                        },
                    },
                },
            });
            context.signal.throwIfAborted();
            const transport = await upstream.createTransport();
            let closing: Promise<void> | undefined;
            const close = (): Promise<void> => (closing ??= client.close());
            const closeOnAbort = (): void => void close().catch(() => { /* already closed */ });
            context.signal.addEventListener("abort", closeOnAbort, { once: true });
            try {
                await client.connect(transport);
            } catch (error) {
                context.signal.removeEventListener("abort", closeOnAbort);
                await transport.close().catch(() => { /* never started */ });
                throw error;
            }
            return {
                listTools: (signal) => listAllTools(client, signal),
                callTool: async (name, args, signal) => {
                    const result = await client.callTool(
                        { name, ...(args === undefined ? {} : { arguments: { ...args } }) },
                        undefined,
                        { signal },
                    );
                    return result as unknown as JsonValue;
                },
                close: async () => {
                    context.signal.removeEventListener("abort", closeOnAbort);
                    await close();
                },
            };
        },
    };
}

/**
 * Read the complete tool list, following `nextCursor`. Rejects a repeated
 * cursor instead of looping forever.
 */
export async function listAllTools(
    client: Pick<Client, "listTools" | "getServerCapabilities">,
    signal?: AbortSignal,
): Promise<Tool[]> {
    if (!client.getServerCapabilities()?.tools) return [];
    const tools: Tool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor }, { signal });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor !== undefined) {
            if (seen.has(cursor)) throw new Error("Repeated tools/list pagination cursor");
            seen.add(cursor);
        }
    } while (cursor !== undefined);
    return tools;
}
