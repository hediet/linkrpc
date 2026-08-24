import type { HubSigningSender } from '@vscode/hubrpc/hub/client';
import type { IConnectionPool, PooledConnection, TraceListener } from './connectionPool';

/** Identifies the MCP session a connection is opened for (consumer-provided mode). */
export interface McpSessionInfo {
    readonly sessionId?: string;
    readonly authorization?: string;
}

/**
 * Resolves a {@link HubSigningSender} for an MCP session and an optional
 * `connection` endpoint argument (`undefined` → the provider's default). This is
 * the single injection seam for both identity-provision modes:
 *   - package-provisioned: the provider dials an endpoint and signs (managed).
 *   - consumer-provisioned: the embedder returns a sender bound to a per-session
 *     identity it owns (e.g. an in-process hub participant).
 */
export type HubSenderProvider = (
    session: McpSessionInfo | undefined,
    endpoint: string | undefined,
) => Promise<HubSigningSender>;

/**
 * {@link IConnectionPool} backed by a {@link HubSenderProvider}: caches one
 * {@link HubSigningSender} per distinct `connection` argument and adapts it to
 * the {@link PooledConnection} shape the MCP tools consume. Holds the
 * MCP-layer-only `lastResultVal` and trace fan-out so the sender stays pure.
 */
export class ProviderPool implements IConnectionPool {
    private readonly _entries = new Map<string, Promise<PooledConnection>>();

    public constructor(
        private readonly _provider: HubSenderProvider,
        private readonly _session?: McpSessionInfo,
    ) { }

    public resolve(endpointUri: string | undefined): Promise<PooledConnection> {
        const key = endpointUri ?? '<default>';
        const existing = this._entries.get(key);
        if (existing) return existing;
        const pending = this._open(endpointUri, key);
        this._entries.set(key, pending);
        pending.catch(() => this._entries.delete(key));
        return pending;
    }

    private async _open(endpointUri: string | undefined, key: string): Promise<PooledConnection> {
        const sender = await this._provider(this._session, endpointUri);
        const traceListeners = new Set<TraceListener>();
        const entry: PooledConnection = {
            channel: sender,
            endpoint: sender.identity.principal,
            key,
            session: sender,
            lastResultVal: undefined,
            addTraceListener: (listener) => {
                traceListeners.add(listener);
                return () => traceListeners.delete(listener);
            },
            trace: (line) => {
                for (const l of traceListeners) {
                    try {
                        l(line);
                    } catch { /* listener errors must not break the wire */ }
                }
            },
            dispose: () => {
                sender.close();
                this._entries.delete(key);
            },
        };
        return entry;
    }

    public dispose(): void {
        for (const pending of this._entries.values()) {
            pending.then(
                (e) => e.dispose(),
                () => { /* failed open, nothing to close */ },
            );
        }
        this._entries.clear();
    }
}
