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
}
interface RetainedOffer<TRef> extends RootOffer<TRef> {
    readonly lease: GraphLease;
}

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
        const watcher = new RootWatcher(
            key, stream, this._options.retention, this._options.sameRef,
            () => this._nextVersion++, () => this._watchers.delete(watcher),
        );
        this._watchers.add(watcher);
        watcher.start();
        if (this._roots.has(key)) watcher.offer(this._roots.get(key)!);
        return watcher.result;
    }
}

class RootWatcher<TRef> {
    private _accepted: RetainedOffer<TRef> | undefined;
    private _offered: RetainedOffer<TRef> | undefined;
    private _pending: { ref: TRef } | undefined;
    private _queue = Promise.resolve();
    private _settled = false;
    private readonly _resolve: (value: Record<string, never>) => void;
    private readonly _reject: (error: unknown) => void;
    private readonly _abort = () => { void this._finish([]); };
    public readonly result: Promise<Record<string, never>>;

    public constructor(
        public readonly paramsKey: string,
        private readonly _stream: StreamApi<RootAccept, RootOffer<TRef>>,
        private readonly _retention: RootRetention<TRef>,
        private readonly _sameRef: (left: TRef, right: TRef) => boolean,
        private readonly _nextVersion: () => number,
        private readonly _onDispose: () => void,
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
        this._enqueue(() => this._offer(ref));
    }

    private _enqueue(operation: () => Promise<void>): void {
        if (this._settled) return;
        this._queue = this._queue.then(operation).catch((error: unknown) => this._finish([error]));
    }

    private async _offer(ref: TRef): Promise<void> {
        if (this._settled) return;
        if (this._offered !== undefined) {
            this._pending = this._sameRef(this._offered.ref, ref) ? undefined : { ref };
            return;
        }
        if (this._accepted !== undefined && this._sameRef(this._accepted.ref, ref)) {
            this._pending = undefined;
            return;
        }
        const lease = await this._retention.retainClosure(ref);
        if (this._settled) {
            await lease.dispose();
            return;
        }
        const offer = { version: this._nextVersion(), ref, lease };
        this._offered = offer;
        await this._stream.send({ version: offer.version, ref: offer.ref });
    }

    private async _accept(version: number): Promise<void> {
        if (this._settled || this._offered?.version !== version) return;
        const previous = this._accepted;
        this._accepted = this._offered;
        this._offered = undefined;
        if (previous !== undefined) await previous.lease.dispose();
        const pending = this._pending;
        this._pending = undefined;
        if (pending !== undefined) await this._offer(pending.ref);
    }

    private async _finish(errors: unknown[]): Promise<void> {
        if (this._settled) return;
        this._settled = true;
        this._stream.signal.removeEventListener('abort', this._abort);
        this._onDispose();
        const leases = [this._accepted?.lease, this._offered?.lease];
        this._accepted = undefined;
        this._offered = undefined;
        this._pending = undefined;
        const outcomes = await Promise.allSettled(leases.map(lease =>
            Promise.resolve().then(() => lease?.dispose())));
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') errors.push(outcome.reason);
        }
        if (errors.length === 0) this._resolve({});
        else this._reject(errors.length === 1 ? errors[0] : new AggregateError(errors, 'Root watch failed'));
    }
}
