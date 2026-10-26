import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { CliChannel } from '@hediet/linkrpc-client-internal';
import { HubDirectoryExplorer } from '@hediet/linkrpc/hub/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema,
    ToolListChangedNotificationSchema, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpForwardInterface } from '../mcpForward.interface';
import { McpHubTransport } from './mcpTransport';

export interface McpOptions {
    readonly input?: Readable;
    readonly output?: Writable;
    readonly requestDirectoryAccess?: (serviceId: string) => Promise<boolean>;
    readonly log?: (message: string) => void;
    readonly stop?: Promise<void>;
}

/** Expose tools from discoverable Hub MCP forwarders on local MCP stdio. */
export async function mcpCommand(channel: CliChannel, options: McpOptions = {}): Promise<void> {
    await new HubMcpServer(channel, options).run();
}

class HubMcpServer {
    private readonly _server = new Server(
        { name: 'linkrpc-hub-mcp', version: '1.0.0' },
        { capabilities: { tools: { listChanged: true } } },
    );
    private readonly _entries = new Map<string, ForwardedServer>();
    private readonly _explorer: HubDirectoryExplorer;
    private readonly _log: (message: string) => void;
    private _closed = false;
    private _initialized = false;
    private _initial: Promise<void> = Promise.resolve();
    private _reconciling: Promise<void> = Promise.resolve();
    private _queued = false;

    constructor(
        private readonly _channel: CliChannel,
        private readonly _options: McpOptions,
    ) {
        this._log = _options.log ?? (message => { process.stderr.write(`linkrpc mcp: ${message}\n`); });
        this._explorer = new HubDirectoryExplorer(_channel, {
            interfaceId: mcpForwardInterface.info.id,
            unlockGatedDirectory: _options.requestDirectoryAccess,
            log: this._log,
        });
        this._server.oninitialized = () => { this._initialized = true; };
        this._server.onerror = error => this._log(`MCP protocol error: ${error.message}`);
        this._server.setRequestHandler(ListToolsRequestSchema, async () => {
            await this._initial;
            return { tools: [...this._entries.values()].flatMap(entry => entry.tools.map(tool => ({
                ...tool,
                name: toolName(entry.serviceId, tool.name),
                description: `[${entry.serviceId}] ${tool.description ?? tool.name}`,
            }))) };
        });
        this._server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            await this._initial;
            for (const entry of this._entries.values()) {
                const tool = entry.tools.find(tool => toolName(entry.serviceId, tool.name) === request.params.name);
                if (!tool) continue;
                try {
                    return await entry.client.callTool(
                        { ...request.params, name: tool.name },
                        CallToolResultSchema,
                        { signal: extra.signal },
                    );
                } catch (error) {
                    this._log(`Tool ${request.params.name} failed: ${errorMessage(error)}`);
                    return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
                }
            }
            throw new Error(`Unknown or disconnected Hub MCP tool: ${request.params.name}`);
        });
    }

    public async run(): Promise<void> {
        const input: Readable = this._options.input ?? process.stdin;
        const output: Writable = this._options.output ?? process.stdout;
        let stop!: () => void;
        const stopped = new Promise<void>(resolve => { stop = resolve; });
        input.once('end', stop);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        this._server.onclose = stop;
        const unsubscribe = this._explorer.subscribe(event => {
            if (event.type === 'settled') this._scheduleReconcile();
        });
        const retry = setInterval(() => this._scheduleReconcile(), 5_000);
        try {
            await this._server.connect(new StdioServerTransport(input, output));
            this._initial = (async () => {
                await this._explorer.watch(() => {});
                const root = this._explorer.graphSnapshot.root;
                if (root.inaccessibleReason) throw new Error(`Hub directory inaccessible: ${root.inaccessibleReason}`);
                await this._reconciling;
            })();
            await Promise.race([
                this._initial.then(() => this._options.stop ? Promise.race([stopped, this._options.stop]) : stopped),
                stopped,
                ...(this._options.stop ? [this._options.stop] : []),
            ]);
        } finally {
            this._closed = true;
            clearInterval(retry);
            unsubscribe();
            this._explorer.dispose();
            input.off('end', stop);
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            await Promise.all([...this._entries.values()].map(entry => this._detach(entry)));
            await this._reconciling;
            await this._server.close();
        }
    }

    private _scheduleReconcile(): void {
        if (this._closed || this._queued) return;
        this._queued = true;
        this._reconciling = this._reconciling.then(async () => {
            this._queued = false;
            if (this._closed) return;
            const wanted = new Set(this._explorer.result.listings
                .filter(item => item.interfaceId === mcpForwardInterface.info.id)
                .map(item => item.serviceId));
            await Promise.all([...this._entries.values()]
                .filter(entry => !wanted.has(entry.serviceId))
                .map(entry => this._detach(entry)));
            await Promise.all([...wanted].filter(id => !this._entries.has(id)).map(id => this._attach(id)));
        }).catch(error => { this._log(`Discovery reconciliation failed: ${errorMessage(error)}`); });
    }

    private async _attach(serviceId: string): Promise<void> {
        if (this._closed) return;
        const client = new Client({ name: 'linkrpc-hub-mcp', version: '1.0.0' }, { capabilities: {} });
        const entry: ForwardedServer = { serviceId, client, tools: [], refresh: Promise.resolve() };
        this._entries.set(serviceId, entry);
        client.onerror = error => this._log(`${serviceId}: ${error.message}`);
        client.onclose = () => {
            if (this._entries.get(serviceId) === entry) {
                this._log(`Disconnected from ${serviceId}; will retry while advertised`);
                this._entries.delete(serviceId);
                this._notifyChanged();
            }
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => this._refresh(entry));
        try {
            await client.connect(new McpHubTransport(this._channel, serviceId), { timeout: 10_000 });
            await this._refresh(entry);
            this._log(`Connected to ${serviceId}`);
        } catch (error) {
            this._log(`Cannot connect to ${serviceId}: ${errorMessage(error)}`);
            await this._detach(entry);
        }
    }

    private _refresh(entry: ForwardedServer): Promise<void> {
        entry.refresh = entry.refresh.then(async () => {
            if (this._entries.get(entry.serviceId) !== entry) return;
            const tools: Tool[] = [];
            const cursors = new Set<string>();
            let cursor: string | undefined;
            if (entry.client.getServerCapabilities()?.tools) {
                do {
                    const page = await entry.client.listTools(cursor ? { cursor } : {}, { timeout: 10_000 });
                    tools.push(...page.tools);
                    cursor = page.nextCursor;
                    if (cursor && cursors.has(cursor)) throw new Error('Repeated tools/list pagination cursor');
                    if (cursor) cursors.add(cursor);
                } while (cursor);
            }
            if (this._entries.get(entry.serviceId) !== entry) return;
            entry.tools = tools;
            this._notifyChanged();
        }).catch(async error => {
            this._log(`Cannot list tools from ${entry.serviceId}: ${errorMessage(error)}`);
            await this._detach(entry);
        });
        return entry.refresh;
    }

    private async _detach(entry: ForwardedServer): Promise<void> {
        if (this._entries.get(entry.serviceId) === entry) {
            this._entries.delete(entry.serviceId);
            this._notifyChanged();
        }
        await entry.client.close();
    }

    private _notifyChanged(): void {
        if (this._closed || !this._initialized) return;
        void this._server.sendToolListChanged().catch(error => {
            this._log(`Cannot notify MCP client: ${errorMessage(error)}`);
        });
    }
}

interface ForwardedServer {
    readonly serviceId: string;
    readonly client: Client;
    tools: readonly Tool[];
    refresh: Promise<void>;
}

function toolName(serviceId: string, name: string): string {
    // Keep names stable, MCP-safe and <=64 characters even for long Hub paths.
    const hash = createHash('sha256').update(JSON.stringify([serviceId, name])).digest('base64url');
    return `${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 18)}__${hash}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
