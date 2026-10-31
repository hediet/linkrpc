import type { McpClientSession, McpSessionFactory } from "./clientSession";

export interface McpSessionManagerOptions {
    readonly factory: McpSessionFactory;
    readonly idleTimeoutMs?: number;
    readonly maxLifetimeMs?: number;
    readonly maxSessions?: number;
    readonly now?: () => number;
}

interface SessionEntry {
    readonly id: string;
    readonly abort: AbortController;
    readonly opening: Promise<McpClientSession>;
    lastUsedAt: number;
    activeOperations: number;
    idleTimer?: ReturnType<typeof setTimeout>;
    lifetimeTimer?: ReturnType<typeof setTimeout>;
}

export class McpSessionManager {
    private readonly _entries = new Map<string, SessionEntry>();
    private readonly _listeners = new Set<(sessionId: string) => void>();
    private readonly _now: () => number;
    private _creationChain = Promise.resolve();
    private _disposed = false;

    constructor(private readonly _options: McpSessionManagerOptions) {
        validateDuration("idleTimeoutMs", _options.idleTimeoutMs);
        validateDuration("maxLifetimeMs", _options.maxLifetimeMs);
        if (
            _options.maxSessions !== undefined &&
            (!Number.isInteger(_options.maxSessions) || _options.maxSessions < 1)
        ) {
            throw new Error("maxSessions must be a positive integer");
        }
        this._now = _options.now ?? Date.now;
    }

    get activeSessionCount(): number {
        return this._entries.size;
    }

    has(sessionId: string | undefined): boolean {
        return this._entries.has(sessionId ?? "");
    }

    onToolsChanged(listener: (sessionId: string) => void): { dispose(): void } {
        this._listeners.add(listener);
        return { dispose: () => this._listeners.delete(listener) };
    }

    async get(sessionId: string | undefined): Promise<McpClientSession> {
        return (await this._getEntry(sessionId)).opening;
    }

    async use<T>(sessionId: string | undefined, operation: (session: McpClientSession) => Promise<T>): Promise<T> {
        const entry = await this._getEntry(sessionId);
        this._beginOperation(entry);
        try {
            return await operation(await entry.opening);
        } finally {
            this._endOperation(entry);
        }
    }

    private async _getEntry(sessionId: string | undefined): Promise<SessionEntry> {
        this._throwIfDisposed();
        const id = sessionId ?? "";
        let entry = this._entries.get(id);
        if (entry === undefined) {
            entry = await this._serializeCreation(async () => {
                const existing = this._entries.get(id);
                if (existing !== undefined) return existing;
                await this._evictForCapacity();
                this._throwIfDisposed();
                return this._create(id);
            });
        }
        this._touch(entry);
        return entry;
    }

    async close(sessionId: string | undefined): Promise<boolean> {
        const id = sessionId ?? "";
        const entry = this._entries.get(id);
        if (entry === undefined) return false;
        this._entries.delete(id);
        clearEntryTimers(entry);
        entry.abort.abort();
        try {
            await (await entry.opening).close();
        } catch {
            // A failed open has no live session to close.
        }
        return true;
    }

    async dispose(): Promise<void> {
        if (this._disposed) return;
        this._disposed = true;
        this._listeners.clear();
        await Promise.all([...this._entries.keys()].map((id) => this.close(id)));
    }

    private _create(id: string): SessionEntry {
        const openedAt = this._now();
        const abort = new AbortController();
        const opening = this._options.factory.open({
            sessionId: id,
            signal: abort.signal,
            onToolsChanged: () => {
                for (const listener of this._listeners) listener(id);
            },
        });
        const entry: SessionEntry = {
            id,
            abort,
            lastUsedAt: openedAt,
            activeOperations: 0,
            opening,
        };
        this._entries.set(id, entry);
        opening.catch(() => {
            if (this._entries.get(id) !== entry) return;
            this._entries.delete(id);
            clearEntryTimers(entry);
        });
        this._resetTimers(entry);
        return entry;
    }

    private _touch(entry: SessionEntry): void {
        entry.lastUsedAt = this._now();
        if (this._options.idleTimeoutMs === undefined || entry.activeOperations > 0) return;
        if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => void this.close(entry.id), this._options.idleTimeoutMs);
        entry.idleTimer.unref?.();
    }

    private _beginOperation(entry: SessionEntry): void {
        entry.activeOperations++;
        if (entry.idleTimer !== undefined) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = undefined;
        }
    }

    private _endOperation(entry: SessionEntry): void {
        entry.activeOperations--;
        if (this._entries.get(entry.id) === entry) this._touch(entry);
    }

    private _resetTimers(entry: SessionEntry): void {
        this._touch(entry);
        if (this._options.maxLifetimeMs === undefined) return;
        entry.lifetimeTimer = setTimeout(() => void this.close(entry.id), this._options.maxLifetimeMs);
        entry.lifetimeTimer.unref?.();
    }

    private async _evictForCapacity(): Promise<void> {
        const max = this._options.maxSessions;
        if (max === undefined || this._entries.size < max) return;
        const oldest = [...this._entries.values()].reduce((a, b) => (a.lastUsedAt <= b.lastUsedAt ? a : b));
        await this.close(oldest.id);
    }

    private _serializeCreation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this._creationChain.then(operation, operation);
        this._creationChain = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private _throwIfDisposed(): void {
        if (this._disposed) throw new Error("MCP session manager is disposed");
    }
}

function validateDuration(name: string, value: number | undefined): void {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new Error(`${name} must be a positive finite number`);
    }
}

function clearEntryTimers(entry: SessionEntry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    if (entry.lifetimeTimer !== undefined) clearTimeout(entry.lifetimeTimer);
}
