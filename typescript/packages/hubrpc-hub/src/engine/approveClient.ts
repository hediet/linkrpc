import type {
    HubAccessManifestDecision,
    HubAccessManifestRequest,
    IHubAccessManifest,
} from '@vscode/hubrpc/hub/common';
import {
    observableValue,
    type IObservable,
    type ISettableObservable,
} from '@vscode/observables';

export interface CapRequest {
    readonly id: string;
    readonly request: HubAccessManifestRequest;
    readonly revision: number;
}

export type ApproveClientState = 'connecting' | 'live' | 'stale';

export interface ApproveClientOptions {
    readonly manifest: IHubAccessManifest;
    /** Only expose requests this root can satisfy. Omit to expose every request. */
    readonly ownPrincipalId?: string;
    readonly log?: (line: string) => void;
    readonly reconnectDelayMs?: number;
}

/**
 * Authoritative, typed frontend for a `hubAccessManifest`.
 *
 * Consumers render {@link requests}; coarse watch ticks are reconciled through
 * one serialized full-snapshot loop, so older reads cannot overwrite newer
 * state. A completed watch is re-opened and a failed read keeps the last known
 * snapshot while {@link state} reports `stale`.
 */
export class ApproveClient {
    private readonly _requests: ISettableObservable<readonly CapRequest[]>;
    public readonly requests: IObservable<readonly CapRequest[]>;
    private readonly _state: ISettableObservable<ApproveClientState>;
    public readonly state: IObservable<ApproveClientState>;

    private readonly _manifest: IHubAccessManifest;
    private readonly _ownPrincipalId: string | undefined;
    private readonly _log: (line: string) => void;
    private readonly _reconnectDelayMs: number;
    private _watch: ReturnType<IHubAccessManifest['watchDesired']> | undefined;
    private _watchGeneration = 0;
    private _retryTimer: ReturnType<typeof setTimeout> | undefined;
    private _refreshPending = false;
    private _refreshPromise: Promise<void> | undefined;
    private _disposed = false;

    constructor(options: ApproveClientOptions) {
        this._manifest = options.manifest;
        this._ownPrincipalId = options.ownPrincipalId;
        this._log = options.log ?? (() => { /* no-op */ });
        this._reconnectDelayMs = options.reconnectDelayMs ?? 250;
        this._requests = observableValue(this, []);
        this.requests = this._requests;
        this._state = observableValue(this, 'connecting');
        this.state = this._state;

        // Subscribe before the first snapshot so a change during getDesired
        // schedules another pass instead of being lost.
        this._openWatch();
        void this.refresh();
    }

    /** Reconcile the observable with the latest complete desired snapshot. */
    public refresh(): Promise<void> {
        if (this._disposed) return Promise.resolve();
        this._refreshPending = true;
        if (!this._refreshPromise) {
            this._refreshPromise = this._drainRefreshes().finally(() => {
                this._refreshPromise = undefined;
            });
        }
        const active = this._refreshPromise;
        return active.then(() => {
            if (this._refreshPending && !this._disposed) return this.refresh();
        });
    }

    /**
     * Write a decision only for a request in the current snapshot, then reconcile
     * with the next authoritative snapshot. A successful write can still leave a
     * matching id pending when a federated snapshot lags or the consumer retries;
     * callers receive `still-pending` so they can report that state honestly.
     */
    public async decide(
        id: string,
        decision: HubAccessManifestDecision,
    ): Promise<'applied' | 'gone' | 'still-pending'> {
        if (!this._requests.get().some((request) => request.id === id)) return 'gone';
        await this._manifest.setCurrent({
            patches: [{
                op: 'set',
                path: `/current/${escapePointer(id)}`,
                value: decision,
            }],
        });
        await this.refresh();
        if (this._requests.get().some((request) => request.id === id)) {
            this._log(
                `hubAccess approver: decision accepted for '${safeId(id)}', `
                + 'but a matching request is still pending',
            );
            return 'still-pending';
        }
        return 'applied';
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._watchGeneration++;
        if (this._retryTimer !== undefined) {
            clearTimeout(this._retryTimer);
            this._retryTimer = undefined;
        }
        const watch = this._watch;
        this._watch = undefined;
        if (watch) void watch.cancel('approve client disposed').catch(() => { /* closing */ });
    }

    private async _drainRefreshes(): Promise<void> {
        while (this._refreshPending && !this._disposed) {
            this._refreshPending = false;
            try {
                const snapshot = await this._manifest.getDesired({});
                if (this._disposed) return;
                const requests = Object.entries(snapshot.requested)
                    .filter(([, request]) => rootAccepted(request.acceptableRootIds, this._ownPrincipalId))
                    .map(([id, request]) => ({ id, request, revision: snapshot.revision }));
                this._requests.set(requests, undefined);
                this._state.set('live', undefined);
            } catch (error) {
                if (this._disposed) return;
                this._state.set('stale', undefined);
                this._log(`hubAccess approver: getDesired failed: ${errorMessage(error)}`);
                this._scheduleReconnect();
            }
        }
    }

    private _openWatch(): void {
        if (this._disposed || this._watch !== undefined) return;
        const generation = ++this._watchGeneration;
        try {
            const watch = this._manifest.watchDesired({}, {
                onMessage: () => { void this.refresh(); },
            });
            this._watch = watch;
            watch.then(
                () => this._watchEnded(generation, undefined),
                (error: unknown) => this._watchEnded(generation, error),
            );
        } catch (error) {
            this._log(`hubAccess approver: watchDesired failed: ${errorMessage(error)}`);
            this._scheduleReconnect();
        }
    }

    private _watchEnded(generation: number, error: unknown): void {
        if (this._disposed || generation !== this._watchGeneration) return;
        this._watch = undefined;
        this._state.set('stale', undefined);
        if (error !== undefined) {
            this._log(`hubAccess approver: watchDesired ended: ${errorMessage(error)}`);
        }
        this._scheduleReconnect();
    }

    private _scheduleReconnect(): void {
        if (this._disposed || this._retryTimer !== undefined) return;
        this._retryTimer = setTimeout(() => {
            this._retryTimer = undefined;
            this._openWatch();
            void this.refresh();
        }, this._reconnectDelayMs);
    }
}

function rootAccepted(
    acceptableRootIds: readonly string[] | undefined,
    ownPrincipalId: string | undefined,
): boolean {
    if (acceptableRootIds === undefined) return true;
    if (acceptableRootIds.length === 0 || ownPrincipalId === undefined) return false;
    return acceptableRootIds.includes(ownPrincipalId);
}

function escapePointer(segment: string): string {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function safeId(id: string): string {
    return id.replace(/\u0000/g, '\\0');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
