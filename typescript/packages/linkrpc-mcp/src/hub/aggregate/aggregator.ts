import { createHash } from "node:crypto";
import type { IRequestSender, SigningCallCtx } from "@hediet/linkrpc";
import { HubDirectoryExplorer, type ServiceListing } from "@hediet/linkrpc/hub/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
    CallToolResultSchema,
    type CallToolResult,
    type Tool,
    ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listAllTools, type McpClientInfo } from "../clientSession";
import {
    generatedMcpToolsInterfacePrefix,
    legacyMcpForwardInterface,
    type McpToolCatalog,
    mcpForwardInterface,
    mcpToolCatalogSchema,
    mcpToolsInterface,
} from "../contracts";
import { McpForwardClientTransport } from "../forward/clientTransport";
import type { HostedTool, McpToolSource, ToolCallExtra } from "../toolHost";

export interface HubMcpAggregatorOptions {
    /** Unlock a gated directory, e.g. by requesting reflection access. */
    readonly requestDirectoryAccess?: (serviceId: string) => Promise<boolean>;
    readonly log?: (message: string) => void;
    readonly clientInfo?: McpClientInfo;
    /** Interval for retrying services that are advertised but failed. Defaults to 5 s. */
    readonly retryIntervalMs?: number;
}

/**
 * Discovers every MCP server published on a hub and presents their tools as
 * one {@link McpToolSource}:
 *
 * - MCP services (`mcp.tools`): tools are called through their generated
 *   methods, so the hub checks capabilities per tool;
 * - forwarded servers (`mcp.forward`, or the legacy `vscode.mcp-forward`): one
 *   MCP client session per server over a forwarded leg.
 *
 * A service offering both is used as an MCP service. All calls go through `sender`, so its
 * signing and capability negotiation apply. Tool names combine a readable
 * prefix with a stable hash of service id and tool name; descriptions start
 * with `[<serviceId>]`.
 */
export class HubMcpAggregator implements McpToolSource {
    public readonly ready: Promise<void>;
    private readonly _entries = new Map<string, Entry>();
    private readonly _listeners = new Set<() => void>();
    private readonly _explorer: HubDirectoryExplorer;
    private readonly _log: (message: string) => void;
    private readonly _unsubscribe: () => void;
    private readonly _retry: ReturnType<typeof setInterval>;
    private _reconciling: Promise<void> = Promise.resolve();
    private _queued = false;
    private _closed = false;

    constructor(
        private readonly _sender: IRequestSender<SigningCallCtx>,
        private readonly _options: HubMcpAggregatorOptions = {},
    ) {
        this._log = _options.log ?? ((message) => console.error(`hub mcp: ${message}`));
        this._explorer = new HubDirectoryExplorer(_sender, {
            unlockGatedDirectory: _options.requestDirectoryAccess,
            log: this._log,
        });
        this._unsubscribe = this._explorer.subscribe((event) => {
            if (event.type === "settled") this._scheduleReconcile();
        });
        this._retry = setInterval(() => this._scheduleReconcile(), _options.retryIntervalMs ?? 5_000);
        this._retry.unref?.();
        this.ready = this._watch();
        this.ready.catch(() => { /* surfaced to whoever awaits `ready` */ });
    }

    private async _watch(): Promise<void> {
        await this._explorer.watch(() => {});
        const root = this._explorer.graphSnapshot.root;
        if (root.inaccessibleReason) throw new Error(`Hub directory inaccessible: ${root.inaccessibleReason}`);
        this._scheduleReconcile();
        await this._reconciling;
    }

    public tools(): readonly HostedTool[] {
        return [...this._entries.values()].flatMap((entry) => entry.tools.map((tool) => this._hosted(entry, tool)));
    }

    public onDidChange(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /** Close every forwarded session; producers and other clients are unaffected. */
    public async dispose(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        clearInterval(this._retry);
        this._unsubscribe();
        this._explorer.dispose();
        await Promise.all([...this._entries.values()].map((entry) => this._detach(entry)));
        await this._reconciling;
        this._listeners.clear();
    }

    private _hosted(entry: Entry, tool: AggregatedTool): HostedTool {
        return {
            definition: {
                ...tool.definition,
                name: aggregatedToolName(entry.serviceId, tool.definition.name),
                description: `[${entry.serviceId}] ${tool.definition.description ?? tool.definition.name}`,
            },
            call: async (args, extra) => {
                try {
                    return await tool.call(args, extra);
                } catch (error) {
                    this._log(`Tool ${tool.definition.name} of ${entry.serviceId} failed: ${errorMessage(error)}`);
                    throw error;
                }
            },
        };
    }

    private _scheduleReconcile(): void {
        if (this._closed || this._queued) return;
        this._queued = true;
        this._reconciling = this._reconciling.then(async () => {
            this._queued = false;
            if (this._closed) return;
            const wanted = wantedEndpoints(this._explorer.result.listings);
            await Promise.all([...this._entries.values()]
                .filter((entry) => !sameEndpoint(entry, wanted.get(entry.serviceId)))
                .map((entry) => this._detach(entry)));
            await Promise.all([...wanted].map(async ([serviceId, endpoint]) => {
                const entry = this._entries.get(serviceId);
                if (entry === undefined) await this._attach(serviceId, endpoint);
                else if (entry.kind === "service" && endpoint.kind === "service"
                    && endpoint.interfaces !== (entry.catalog && interfacesKey(entry.catalog.interfaces))) {
                    await this._refresh(entry);
                }
            }));
        }).catch((error: unknown) => this._log(`Discovery reconciliation failed: ${errorMessage(error)}`));
    }

    private async _attach(serviceId: string, endpoint: Endpoint): Promise<void> {
        if (this._closed) return;
        if (endpoint.kind === "service") {
            const entry: ServiceEntry = { kind: "service", serviceId, catalog: undefined, tools: [], refresh: Promise.resolve() };
            this._entries.set(serviceId, entry);
            await this._refresh(entry);
            if (this._entries.get(serviceId) === entry) this._log(`Connected to ${serviceId} (service)`);
            return;
        }
        const client = new Client({ ...(this._options.clientInfo ?? defaultClientInfo) }, { capabilities: {} });
        const entry: ForwardEntry = {
            kind: "forward", serviceId, interfaceId: endpoint.interfaceId, client, tools: [], refresh: Promise.resolve(),
        };
        this._entries.set(serviceId, entry);
        client.onerror = (error) => this._log(`${serviceId}: ${error.message}`);
        client.onclose = () => {
            if (this._entries.get(serviceId) !== entry) return;
            this._log(`Disconnected from ${serviceId}; will retry while advertised`);
            this._entries.delete(serviceId);
            this._notifyChanged();
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => this._refresh(entry));
        try {
            await client.connect(new McpForwardClientTransport(this._sender, serviceId, {
                interfaceId: endpoint.interfaceId,
                clientInfo: this._options.clientInfo ?? defaultClientInfo,
            }), { timeout: 10_000 });
            await this._refresh(entry);
            this._log(`Connected to ${serviceId}`);
        } catch (error) {
            this._log(`Cannot connect to ${serviceId}: ${errorMessage(error)}`);
            await this._detach(entry);
        }
    }

    private _refresh(entry: Entry): Promise<void> {
        entry.refresh = entry.refresh.then(async () => {
            if (this._entries.get(entry.serviceId) !== entry) return;
            if (entry.kind === "service") {
                const catalog = mcpToolCatalogSchema.parse(await this._sender.sendRequest(
                    `${entry.serviceId}::${mcpToolsInterface.info.id}::listTools`,
                    {},
                ));
                if (this._entries.get(entry.serviceId) !== entry) return;
                entry.catalog = catalog;
                entry.tools = catalog.tools.map((tool) => this._serviceTool(entry.serviceId, catalog, tool));
            } else {
                const tools = await listAllTools(entry.client, AbortSignal.timeout(10_000));
                if (this._entries.get(entry.serviceId) !== entry) return;
                entry.tools = tools.map((definition) => ({
                    definition,
                    call: (args, extra) => entry.client.callTool(
                        { name: definition.name, ...(args === undefined ? {} : { arguments: { ...args } }) },
                        CallToolResultSchema,
                        { signal: extra.signal },
                    ) as Promise<CallToolResult>,
                }));
            }
            this._notifyChanged();
        }).catch(async (error: unknown) => {
            this._log(`Cannot list tools from ${entry.serviceId}: ${errorMessage(error)}`);
            await this._detach(entry);
        });
        return entry.refresh;
    }

    private _serviceTool(serviceId: string, catalog: McpToolCatalog, tool: McpToolCatalog["tools"][number]): AggregatedTool {
        const { method, interfaceId, ...definition } = tool;
        const interfaceHash = catalog.interfaces.find((candidate) => candidate.interfaceId === interfaceId)?.interfaceHash;
        return {
            definition: definition as Tool,
            call: async (args, extra) => {
                const call = this._sender.sendRequestWithStream(
                    `${serviceId}::${interfaceId}::${method}`,
                    { ...(args ?? {}) } as never,
                    interfaceHash === undefined ? {} : { interfaceHash },
                );
                const cancel = () => void call.cancel("MCP request cancelled");
                extra.signal.addEventListener("abort", cancel, { once: true });
                try {
                    return CallToolResultSchema.parse(await call.result);
                } finally {
                    extra.signal.removeEventListener("abort", cancel);
                }
            },
        };
    }

    private async _detach(entry: Entry): Promise<void> {
        if (this._entries.get(entry.serviceId) === entry) {
            this._entries.delete(entry.serviceId);
            this._notifyChanged();
        }
        if (entry.kind === "forward") await entry.client.close();
    }

    private _notifyChanged(): void {
        if (this._closed) return;
        for (const listener of this._listeners) listener();
    }
}

interface AggregatedTool {
    readonly definition: Tool;
    call(args: Readonly<Record<string, unknown>> | undefined, extra: ToolCallExtra): Promise<CallToolResult>;
}

interface ServiceEntry {
    readonly kind: "service";
    readonly serviceId: string;
    catalog: McpToolCatalog | undefined;
    tools: readonly AggregatedTool[];
    refresh: Promise<void>;
}

interface ForwardEntry {
    readonly kind: "forward";
    readonly serviceId: string;
    readonly interfaceId: string;
    readonly client: Client;
    tools: readonly AggregatedTool[];
    refresh: Promise<void>;
}

type Entry = ServiceEntry | ForwardEntry;

type Endpoint =
    /** `interfaces` identifies the generated interfaces and their hashes. */
    | { readonly kind: "service"; readonly interfaces: string }
    | { readonly kind: "forward"; readonly interfaceId: string };

const defaultClientInfo: McpClientInfo = { name: "linkrpc-hub-mcp", version: "1.0.0" };

/** One endpoint per service: the MCP service if offered, else the preferred forward id. */
function wantedEndpoints(listings: readonly ServiceListing[]): Map<string, Endpoint> {
    const byService = new Map<string, ServiceListing[]>();
    for (const listing of listings) {
        if (listing.serviceId.length === 0) continue;
        const items = byService.get(listing.serviceId) ?? [];
        items.push(listing);
        byService.set(listing.serviceId, items);
    }
    const result = new Map<string, Endpoint>();
    for (const [serviceId, items] of byService) {
        const ids = new Set(items.map((item) => item.interfaceId));
        if (ids.has(mcpToolsInterface.info.id)) {
            const generated = items.filter((item) => item.interfaceId.startsWith(generatedMcpToolsInterfacePrefix));
            result.set(serviceId, {
                kind: "service",
                interfaces: interfacesKey(generated.map((item) => ({ interfaceId: item.interfaceId, interfaceHash: item.hash }))),
            });
        } else if (ids.has(mcpForwardInterface.info.id)) {
            result.set(serviceId, { kind: "forward", interfaceId: mcpForwardInterface.info.id });
        } else if (ids.has(legacyMcpForwardInterface.info.id)) {
            result.set(serviceId, { kind: "forward", interfaceId: legacyMcpForwardInterface.info.id });
        }
    }
    return result;
}

function sameEndpoint(entry: Entry, endpoint: Endpoint | undefined): boolean {
    if (endpoint === undefined || endpoint.kind !== entry.kind) return false;
    return entry.kind === "service" || (endpoint.kind === "forward" && endpoint.interfaceId === entry.interfaceId);
}

function interfacesKey(interfaces: readonly { readonly interfaceId: string; readonly interfaceHash: string }[]): string {
    return interfaces.map((item) => `${item.interfaceId}:${item.interfaceHash}`).sort().join(",");
}

/** Stable, MCP-safe (≤ 64 characters) and unique even for long service ids. */
export function aggregatedToolName(serviceId: string, name: string): string {
    const hash = createHash("sha256").update(JSON.stringify([serviceId, name])).digest("base64url");
    return `${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 18)}__${hash}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
