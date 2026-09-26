import type { StreamApi } from '@hediet/linkrpc';
import type { GraphLease } from './immutableGraph';

export interface RootOffer<TRef> {
    readonly version: number;
    readonly ref: TRef;
}
export interface RootAccept {
    readonly accept: number;
}
export interface RootRetention<TRef> {
    retainClosure(ref: TRef): GraphLease | Promise<GraphLease>;
}
export interface RootWatchCoordinatorOptions<TParams, TRef> {
    readonly paramsKey: (params: TParams) => string;
    readonly sameRef: (left: TRef, right: TRef) => boolean;
    readonly retention: RootRetention<TRef>;
    /** How long a superseded root stays queryable without an acknowledgement. */
    readonly supersededGraceMs?: number;
    /** Upper bound on superseded roots retained per watcher; the oldest is released first. */
    readonly maxSuperseded?: number;
}
interface RetainedOffer<TRef> extends RootOffer<TRef> {
    readonly lease: GraphLease;
    timer?: ReturnType<typeof setTimeout>;
}

export const defaultSupersededRootGraceMs = 10_000;
export const defaultMaxSupersededRoots = 8;

/**
 * Streams the newest root per watcher without waiting for acknowledgements.
 * A superseded root is released only after its successor was sent, so a client
 * always observes the newer root before objects of the older one expire.
 */
export class RootWatchCoordinator<TParams, TRef> {
    private readonly _roots = new Map<string, TRef>();
    private readonly _watchers = new Set<RootWatcher<TRef>>();
    private _nextVersion = 1;

    public constructor(private readonly _options: RootWatchCoordinatorOptions<TParams, TRef>) { }

    public publish(params: TParams, ref: TRef): void {
        const key = this._options.paramsKey(params);
        this._roots.set(key, ref);
        for (const watcher of this._watchers) {
            if (watcher.paramsKey === key) watcher.offer(ref);
        }
    }

    public watch(params: TParams, stream: StreamApi<RootAccept, RootOffer<TRef>>): Promise<Record<string, never>> {
        const key = this._options.paramsKey(params);
        const watcher = new RootWatcher(key, stream, {
            retention: this._options.retention,
            sameRef: this._options.sameRef,
            graceMs: this._options.supersededGraceMs ?? defaultSupersededRootGraceMs,
            maxSuperseded: this._options.maxSuperseded ?? defaultMaxSupersededRoots,
            nextVersion: () => this._nextVersion++,
            onDispose: () => this._watchers.delete(watcher),
        });
        this._watchers.add(watcher);
        watcher.start();
        if (this._roots.has(key)) watcher.offer(this._roots.get(key)!);
        return watcher.result;
    }
}

interface RootWatcherOptions<TRef> {
    readonly retention: RootRetention<TRef>;
    readonly sameRef: (left: TRef, right: TRef) => boolean;
    readonly graceMs: number;
    readonly maxSuperseded: number;
    readonly nextVersion: () => number;
    readonly onDispose: () => void;
}

class RootWatcher<TRef> {
    /** Retained offers in version order; the last one is the newest sent (or sending) root. */
    private readonly _retained: RetainedOffer<TRef>[] = [];
    private _wanted: { ref: TRef } | undefined;
    private _queue = Promise.resolve();
    private _settled = false;
    private readonly _resolve: (value: Record<string, never>) => void;
    private readonly _reject: (error: unknown) => void;
    private readonly _abort = () => { void this._finish([]); };
    public readonly result: Promise<Record<string, never>>;

    public constructor(
        public readonly paramsKey: string,
        private readonly _stream: StreamApi<RootAccept, RootOffer<TRef>>,
        private readonly _options: RootWatcherOptions<TRef>,
    ) {
        let resolve!: (value: Record<string, never>) => void;
        let reject!: (error: unknown) => void;
        this.result = new Promise((res, rej) => { resolve = res; reject = rej; });
        this._resolve = resolve;
        this._reject = reject;
    }

    public start(): void {
        this._stream.onMessage(({ accept }) => this._enqueue(() => this._accept(accept)));
        if (this._stream.signal.aborted) this._abort();
        else this._stream.signal.addEventListener('abort', this._abort, { once: true });
    }

    public offer(ref: TRef): void {
        if (this._settled) return;
        this._wanted = { ref };
        this._enqueue(() => this._sendWanted());
    }

    private _enqueue(operation: () => Promise<void>): void {
        if (this._settled) return;
        this._queue = this._queue.then(operation).catch((error: unknown) => this._finish([error]));
    }

    private async _sendWanted(): Promise<void> {
        const wanted = this._wanted;
        this._wanted = undefined;
        if (this._settled || wanted === undefined) return;
        const previous = this._retained.at(-1);
        if (previous !== undefined && this._options.sameRef(previous.ref, wanted.ref)) return;
        const lease = await this._options.retention.retainClosure(wanted.ref);
        if (this._settled) {
            await lease.dispose();
            return;
        }
        const offer: RetainedOffer<TRef> = { version: this._options.nextVersion(), ref: wanted.ref, lease };
        this._retained.push(offer);
        await this._stream.send({ version: offer.version, ref: offer.ref });
        if (this._settled || previous === undefined) return;
        previous.timer = setTimeout(() => this._enqueue(() => this._release(previous)), this._options.graceMs);
        (previous.timer as { unref?: () => void }).unref?.();
        const superseded = this._retained.slice(0, -1);
        for (const expired of superseded.slice(0, Math.max(0, superseded.length - this._options.maxSuperseded))) {
            await this._release(expired);
        }
    }

    /** An acknowledgement is an optional hint: the client no longer needs roots older than it. */
    private async _accept(version: number): Promise<void> {
        const index = this._retained.findIndex(offer => offer.version === version);
        if (this._settled || index <= 0) return;
        for (const older of this._retained.slice(0, index)) await this._release(older);
    }

    private async _release(offer: RetainedOffer<TRef>): Promise<void> {
        const index = this._retained.indexOf(offer);
        if (this._settled || index < 0 || index === this._retained.length - 1) return;
        clearTimeout(offer.timer);
        this._retained.splice(index, 1);
        await offer.lease.dispose();
    }

    private async _finish(errors: unknown[]): Promise<void> {
        if (this._settled) return;
        this._settled = true;
        this._stream.signal.removeEventListener('abort', this._abort);
        this._options.onDispose();
        const leases = this._retained.splice(0).map(offer => {
            clearTimeout(offer.timer);
            return offer.lease;
        });
        this._wanted = undefined;
        const outcomes = await Promise.allSettled(leases.map(lease =>
            Promise.resolve().then(() => lease.dispose())));
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') errors.push(outcome.reason);
        }
        if (errors.length === 0) this._resolve({});
        else this._reject(errors.length === 1 ? errors[0] : new AggregateError(errors, 'Root watch failed'));
    }
}
