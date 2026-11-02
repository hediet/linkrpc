import type { McpClientSession, McpSessionFactory } from "./clientSession";

export interface McpSessionManagerOptions {
    readonly factory: McpSessionFactory;
    readonly idleTimeoutMs?: number;
    readonly maxLifetimeMs?: number;
    readonly maxSessions?: number;
    readonly now?: () => number;
}

interface SessionEntry {
    /** Key in the session map: identity and session id. */
    readonly id: string;
    readonly sessionId: string;
    readonly identityId: string;
    readonly abort: AbortController;
    readonly opening: Promise<McpClientSession>;
    lastUsedAt: number;
    activeOperations: number;
    idleTimer?: ReturnType<typeof setTimeout>;
    lifetimeTimer?: ReturnType<typeof setTimeout>;
}

export class McpSessionManager {
    private readonly _entries = new Map<string, SessionEntry>();
    private readonly _listeners = new Set<(sessionId: string, identityId: string) => void>();
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

    /**
     * Sessions are keyed by session id and MCP identity; `identityId` defaults
     * to `""` for factories that do not distinguish identities.
     */
    has(sessionId: string | undefined, identityId = ""): boolean {
        return this._entries.has(entryKey(sessionId, identityId));
    }

    onToolsChanged(listener: (sessionId: string, identityId: string) => void): { dispose(): void } {
        this._listeners.add(listener);
        return { dispose: () => this._listeners.delete(listener) };
    }

    async get(sessionId: string | undefined, identityId = ""): Promise<McpClientSession> {
        return (await this._getEntry(sessionId, identityId)).opening;
    }

    async use<T>(
        sessionId: string | undefined,
        operation: (session: McpClientSession) => Promise<T>,
        identityId = "",
    ): Promise<T> {
        const entry = await this._getEntry(sessionId, identityId);
        this._beginOperation(entry);
        try {
            return await operation(await entry.opening);
        } finally {
            this._endOperation(entry);
        }
    }

    private async _getEntry(sessionId: string | undefined, identityId: string): Promise<SessionEntry> {
        this._throwIfDisposed();
        const id = entryKey(sessionId, identityId);
        let entry = this._entries.get(id);
        if (entry === undefined) {
            entry = await this._serializeCreation(async () => {
                const existing = this._entries.get(id);
                if (existing !== undefined) return existing;
                await this._evictForCapacity();
                this._throwIfDisposed();
                return this._create(sessionId ?? "", identityId);
            });
        }
        this._touch(entry);
        return entry;
    }

    async close(sessionId: string | undefined, identityId = ""): Promise<boolean> {
        return this._closeEntry(entryKey(sessionId, identityId));
    }

    /** Close every session of `identityId`. */
    async closeIdentity(identityId: string): Promise<void> {
        const ids = [...this._entries.values()].filter((entry) => entry.identityId === identityId).map((entry) => entry.id);
        await Promise.all(ids.map((id) => this._closeEntry(id)));
    }

    private async _closeEntry(id: string): Promise<boolean> {
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
        await Promise.all([...this._entries.keys()].map((id) => this._closeEntry(id)));
    }

    private _create(sessionId: string, identityId: string): SessionEntry {
        const id = entryKey(sessionId, identityId);
        const openedAt = this._now();
        const abort = new AbortController();
        const opening = this._options.factory.open({
            sessionId,
            identityId,
            signal: abort.signal,
            onToolsChanged: () => {
                for (const listener of this._listeners) listener(sessionId, identityId);
            },
        });
        const entry: SessionEntry = {
            id,
            sessionId,
            identityId,
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
        entry.idleTimer = setTimeout(() => void this._closeEntry(entry.id), this._options.idleTimeoutMs);
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
        entry.lifetimeTimer = setTimeout(() => void this._closeEntry(entry.id), this._options.maxLifetimeMs);
        entry.lifetimeTimer.unref?.();
    }

    private async _evictForCapacity(): Promise<void> {
        const max = this._options.maxSessions;
        if (max === undefined || this._entries.size < max) return;
        const oldest = [...this._entries.values()].reduce((a, b) => (a.lastUsedAt <= b.lastUsedAt ? a : b));
        await this._closeEntry(oldest.id);
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

function entryKey(sessionId: string | undefined, identityId: string): string {
    return `${identityId}\u0000${sessionId ?? ""}`;
}
