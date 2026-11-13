import { createHash } from "node:crypto";
import type { IRequestSender, SigningCallCtx } from "@hediet/linkrpc";
import { HubDirectoryExplorer, type ServiceListing } from "@hediet/linkrpc/hub/common";
import { CallToolResultSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
    generatedMcpToolsInterfacePrefix,
    type McpToolCatalog,
    mcpToolCatalogSchema,
    mcpToolsInterface,
} from "../contracts";
import type { HostedTool, McpToolSource, ToolCallExtra } from "../toolHost";

export interface HubMcpAggregatorOptions {
    /** Unlock a gated directory, e.g. by requesting reflection access. */
    readonly requestDirectoryAccess?: (serviceId: string) => Promise<boolean>;
    readonly log?: (message: string) => void;
    /**
     * MCP identity (account) to use per service id; services without one use
     * their default identity. Only that identity's tools are listed.
     */
    readonly mcpIdentityFor?: (serviceId: string) => string | undefined;
    /** Interval for retrying services that are advertised but failed. Defaults to 5 s. */
    readonly retryIntervalMs?: number;
}

/**
 * Discovers every MCP service (`mcp.tools`) published on a hub and presents
 * their tools as one {@link McpToolSource}. Tools are called through their
 * generated methods, so the hub checks capabilities per tool. Forwarded MCP
 * servers (`mcp.forward`, legacy `vscode.mcp-forward`) are not consumed.
 *
 * The aggregator keeps no per-caller state, so one instance can serve many MCP
 * sessions. All calls go through `sender`, so its signing and capability
 * negotiation apply. Tool names combine a readable prefix with a stable hash of
 * service id and tool name; descriptions start with `[<serviceId>]`.
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

    /** Stop watching the hub; the services and other clients are unaffected. */
    public async dispose(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        clearInterval(this._retry);
        this._unsubscribe();
        this._explorer.dispose();
        this._entries.clear();
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
            const wanted = wantedServices(this._explorer.result.listings);
            for (const entry of this._entries.values()) {
                if (!wanted.has(entry.serviceId)) this._detach(entry);
            }
            await Promise.all([...wanted].map(async ([serviceId, interfaces]) => {
                const entry = this._entries.get(serviceId);
                if (entry === undefined) await this._attach(serviceId);
                else if (interfaces !== (entry.catalog && interfacesKey(entry.catalog.interfaces))) {
                    await this._refresh(entry);
                }
            }));
        }).catch((error: unknown) => this._log(`Discovery reconciliation failed: ${errorMessage(error)}`));
    }

    private async _attach(serviceId: string): Promise<void> {
        if (this._closed) return;
        const entry: Entry = { serviceId, catalog: undefined, tools: [], refresh: Promise.resolve() };
        this._entries.set(serviceId, entry);
        await this._refresh(entry);
        if (this._entries.get(serviceId) === entry) this._log(`Connected to ${serviceId}`);
    }

    private _refresh(entry: Entry): Promise<void> {
        entry.refresh = entry.refresh.then(async () => {
            if (this._entries.get(entry.serviceId) !== entry) return;
            const catalog = mcpToolCatalogSchema.parse(await this._sender.sendRequest(
                `${entry.serviceId}::${mcpToolsInterface.info.id}::listTools`,
                {},
            ));
            if (this._entries.get(entry.serviceId) !== entry) return;
            entry.catalog = catalog;
            const mcpIdentity = this._options.mcpIdentityFor?.(entry.serviceId);
            const listedIdentity = mcpIdentity ?? catalog.defaultIdentity;
            entry.tools = catalog.tools
                .filter((tool) => listedIdentity === undefined || tool.identities === undefined
                    || tool.identities.includes(listedIdentity))
                .map((tool) => this._serviceTool(entry.serviceId, catalog, tool, mcpIdentity));
            this._notifyChanged();
        }).catch((error: unknown) => {
            this._log(`Cannot list tools from ${entry.serviceId}: ${errorMessage(error)}`);
            this._detach(entry);
        });
        return entry.refresh;
    }

    private _serviceTool(
        serviceId: string,
        catalog: McpToolCatalog,
        tool: McpToolCatalog["tools"][number],
        mcpIdentity: string | undefined,
    ): AggregatedTool {
        const { method, interfaceId, identities: _identities, ...definition } = tool;
        const interfaceHash = catalog.interfaces.find((candidate) => candidate.interfaceId === interfaceId)?.interfaceHash;
        return {
            definition: definition as Tool,
            call: async (args, extra) => {
                const call = this._sender.sendRequestWithStream(
                    `${serviceId}::${interfaceId}::${method}`,
                    { ...(args ?? {}), ...(mcpIdentity !== undefined ? { mcpIdentity } : {}) } as never,
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

    private _detach(entry: Entry): void {
        if (this._entries.get(entry.serviceId) !== entry) return;
        this._entries.delete(entry.serviceId);
        this._notifyChanged();
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

interface Entry {
    readonly serviceId: string;
    catalog: McpToolCatalog | undefined;
    tools: readonly AggregatedTool[];
    refresh: Promise<void>;
}

/**
 * The MCP services among `listings`, each with a key of its generated
 * interfaces and their hashes. Other services, including forwarded MCP
 * servers, are ignored.
 */
function wantedServices(listings: readonly ServiceListing[]): Map<string, string> {
    const byService = new Map<string, ServiceListing[]>();
    for (const listing of listings) {
        if (listing.serviceId.length === 0) continue;
        const items = byService.get(listing.serviceId) ?? [];
        items.push(listing);
        byService.set(listing.serviceId, items);
    }
    const result = new Map<string, string>();
    for (const [serviceId, items] of byService) {
        if (!items.some((item) => item.interfaceId === mcpToolsInterface.info.id)) continue;
        const generated = items.filter((item) => item.interfaceId.startsWith(generatedMcpToolsInterfacePrefix));
        result.set(serviceId, interfacesKey(generated.map((item) => ({ interfaceId: item.interfaceId, interfaceHash: item.hash }))));
    }
    return result;
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
