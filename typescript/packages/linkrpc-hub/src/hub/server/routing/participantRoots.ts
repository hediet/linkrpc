import type { IMessageTransport } from '@hediet/linkrpc';
import type { JsonValue } from '@hediet/linkrpc';
import type { ServiceId } from '@hediet/linkrpc/hub/common';

interface Disposable {
    dispose(): void;
}

export interface ParticipantRootsOptions {
    readonly forwardingEntries: () => Iterable<readonly [ServiceId, IMessageTransport]>;
    readonly prefixOwner: (prefix: ServiceId) => IMessageTransport | undefined;
    readonly uplink: () => IMessageTransport | undefined;
    readonly requestOnLink: (
        link: IMessageTransport,
        method: string,
        params: JsonValue,
    ) => Promise<JsonValue | undefined>;
    readonly watchOnLink: (
        link: IMessageTransport,
        method: string,
        params: JsonValue,
        onTick: () => void,
        onSettled: () => void,
        onEstablished: () => void,
    ) => Disposable;
    readonly onDidChangeRouting: (listener: () => void) => () => void;
}

/** Reconciles participant-root queries and watches over the Hub's routing links. */
export class ParticipantRoots {
    constructor(private readonly _options: ParticipantRootsOptions) {}

    public async query(
        method: string,
        params: JsonValue,
        excludePrefix?: ServiceId,
    ): Promise<JsonValue[]> {
        const settled = await Promise.all(
            [...this._participantLinks(excludePrefix)].map((link) =>
                this._options.requestOnLink(link, method, params).then(
                    (result) => result,
                    () => undefined,
                )),
        );
        return settled.filter((result): result is JsonValue => result !== undefined);
    }

    public watch(
        method: string,
        params: JsonValue,
        onTick: () => void,
        excludePrefix?: ServiceId,
    ): Disposable {
        interface ParticipantWatchState {
            watch?: Disposable;
            retry?: ReturnType<typeof setTimeout>;
            retryDelayMs: number;
        }
        const watches = new Map<IMessageTransport, ParticipantWatchState>();
        let disposed = false;
        const stopState = (state: ParticipantWatchState): void => {
            if (state.retry !== undefined) clearTimeout(state.retry);
            state.retry = undefined;
            state.watch?.dispose();
            state.watch = undefined;
        };
        const start = (link: IMessageTransport, state: ParticipantWatchState): void => {
            if (disposed || !this._participantLinks(excludePrefix).has(link)) return;
            state.watch = this._options.watchOnLink(
                link,
                method,
                params,
                onTick,
                () => {
                    queueMicrotask(() => {
                        if (disposed || watches.get(link) !== state) return;
                        state.watch = undefined;
                        state.retry = setTimeout(() => {
                            state.retry = undefined;
                            start(link, state);
                        }, state.retryDelayMs);
                        state.retryDelayMs = Math.min(5_000, state.retryDelayMs * 2);
                    });
                },
                () => {
                    state.retryDelayMs = 200;
                    onTick();
                },
            );
        };
        const reconcile = (): void => {
            const current = this._participantLinks(excludePrefix);
            for (const [link, state] of watches) {
                if (current.has(link)) continue;
                stopState(state);
                watches.delete(link);
            }
            for (const link of current) {
                if (watches.has(link)) continue;
                const state: ParticipantWatchState = { retryDelayMs: 200 };
                watches.set(link, state);
                start(link, state);
            }
        };
        reconcile();
        const unsubscribe = this._options.onDidChangeRouting(reconcile);
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                unsubscribe();
                for (const state of watches.values()) stopState(state);
                watches.clear();
            },
        };
    }

    private _participantLinks(excludePrefix?: ServiceId): Set<IMessageTransport> {
        const exclude = excludePrefix !== undefined
            ? this._options.prefixOwner(excludePrefix)
            : undefined;
        const uplink = this._options.uplink();
        const links = new Set<IMessageTransport>();
        for (const [, link] of this._options.forwardingEntries()) {
            if (link === exclude || link === uplink) continue;
            links.add(link);
        }
        return links;
    }
}
