import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
    type CallToolResult,
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    type ServerNotification,
    type ServerRequest,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type ToolCallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** A tool served by an {@link McpToolHost}. */
export interface HostedTool {
    readonly definition: Tool;
    call(args: Readonly<Record<string, unknown>> | undefined, extra: ToolCallExtra): Promise<CallToolResult>;
}

/** A changing set of tools, e.g. those aggregated from a hub. */
export interface McpToolSource {
    tools(): readonly HostedTool[];
    /** Returns an unsubscribe function. */
    onDidChange(listener: () => void): () => void;
    /** Settles once the initial tool set is known; listing waits for it. */
    readonly ready?: Promise<void>;
}

/**
 * Serves the tools of several sources on one low-level MCP {@link Server},
 * which must declare the `tools` capability with `listChanged`. Tool errors
 * become `isError` results; unknown tools are protocol errors.
 */
export class McpToolHost {
    private readonly _sources = new Set<McpToolSource>();
    private readonly _subscriptions = new Map<McpToolSource, () => void>();

    constructor(private readonly _server: Server) {
        _server.setRequestHandler(ListToolsRequestSchema, async () => {
            await this._ready();
            return { tools: this._tools().map((tool) => tool.definition) };
        });
        _server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            await this._ready();
            const tool = this._tools().find((candidate) => candidate.definition.name === request.params.name);
            if (tool === undefined) {
                throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
            }
            try {
                return await tool.call(request.params.arguments, extra);
            } catch (error) {
                return toolError(error instanceof Error ? error.message : String(error));
            }
        });
    }

    public addSource(source: McpToolSource): { dispose(): void } {
        this._sources.add(source);
        this._subscriptions.set(source, source.onDidChange(() => this._notifyChanged()));
        this._notifyChanged();
        return {
            dispose: () => {
                if (!this._sources.delete(source)) return;
                this._subscriptions.get(source)?.();
                this._subscriptions.delete(source);
                this._notifyChanged();
            },
        };
    }

    public addTools(tools: readonly HostedTool[]): { dispose(): void } {
        return this.addSource({ tools: () => tools, onDidChange: () => () => {} });
    }

    private _tools(): HostedTool[] {
        const byName = new Map<string, HostedTool>();
        for (const source of this._sources) {
            for (const tool of source.tools()) {
                if (!byName.has(tool.definition.name)) byName.set(tool.definition.name, tool);
            }
        }
        return [...byName.values()];
    }

    private async _ready(): Promise<void> {
        await Promise.all([...this._sources].map((source) => source.ready));
    }

    private _notifyChanged(): void {
        // Before `initialize` completes there is nobody to notify.
        if (this._server.transport === undefined || this._server.getClientVersion() === undefined) return;
        void this._server.sendToolListChanged().catch(() => { /* the client disconnected */ });
    }
}

export interface ZodToolDefinition<TShape extends z.ZodRawShape> {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema: TShape;
    readonly annotations?: Tool["annotations"];
}

/**
 * A tool whose arguments are described and validated by a zod object shape,
 * presented like the MCP SDK's `McpServer.registerTool`.
 */
export function zodTool<TShape extends z.ZodRawShape>(
    definition: ZodToolDefinition<TShape>,
    handler: (args: z.infer<z.ZodObject<TShape>>, extra: ToolCallExtra) => Promise<CallToolResult>,
): HostedTool {
    const schema = z.object(definition.inputSchema);
    return {
        definition: {
            name: definition.name,
            ...(definition.title !== undefined ? { title: definition.title } : {}),
            ...(definition.description !== undefined ? { description: definition.description } : {}),
            inputSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Tool["inputSchema"],
            ...(definition.annotations !== undefined ? { annotations: definition.annotations } : {}),
            // Matches the MCP SDK's `McpServer` default: no task-augmented execution.
            execution: { taskSupport: "forbidden" },
        },
        call: async (args, extra) => {
            const parsed = schema.safeParse(args ?? {});
            if (!parsed.success) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `Input validation error: Invalid arguments for tool ${definition.name}: ${parsed.error.message}`,
                );
            }
            return handler(parsed.data, extra);
        },
    };
}

export function toolError(message: string): CallToolResult {
    return { isError: true, content: [{ type: "text", text: message }] };
}
