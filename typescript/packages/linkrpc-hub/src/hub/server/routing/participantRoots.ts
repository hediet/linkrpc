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
        timeoutMs: number,
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

export interface ParticipantRootsQueryOptions {
    /** Prefix whose owning link is skipped (typically the hub's own services). */
    readonly excludePrefix?: ServiceId;
    /** How long to wait for answers before returning the ones that arrived. */
    readonly budgetMs: number;
    /** Hard per-participant deadline; an unanswered request is cancelled then. */
    readonly requestTimeoutMs: number;
}

/**
 * The answers of one fan-out. A participant that does not answer within the
 * budget must not block the others, so it is reported as `truncated` instead
 * and keeps running in the background until its hard deadline.
 */
export interface ParticipantRootsAnswer {
    /** Successful answers that arrived within the budget. */
    readonly results: JsonValue[];
    /** Whether some participant had not settled when the budget elapsed. */
    readonly truncated: boolean;
    /**
     * Settles once every participant outstanding at the budget has answered,
     * failed, or hit its hard deadline: `true` if any of them answered, i.e.
     * a fresh query could return more than `results`.
     */
    readonly lateAnswers: Promise<boolean>;
}

/** Reconciles participant-root queries and watches over the Hub's routing links. */
export class ParticipantRoots {
    constructor(private readonly _options: ParticipantRootsOptions) {}

    public async query(
        method: string,
        params: JsonValue,
        options: ParticipantRootsQueryOptions,
    ): Promise<ParticipantRootsAnswer> {
        const requests = [...this._participantLinks(options.excludePrefix)].map((link) => {
            const outcome: { settled: boolean; result?: JsonValue } = { settled: false };
            const done = this._options
                .requestOnLink(link, method, params, options.requestTimeoutMs)
                .then(
                    (result) => {
                        outcome.settled = true;
                        outcome.result = result;
                    },
                    () => {
                        outcome.settled = true;
                    },
                );
            return { outcome, done };
        });

        let budgetTimer: ReturnType<typeof setTimeout> | undefined;
        const budgetElapsed = new Promise<void>((resolve) => {
            budgetTimer = setTimeout(resolve, options.budgetMs);
        });
        await Promise.race([Promise.all(requests.map((request) => request.done)), budgetElapsed]);
        clearTimeout(budgetTimer);

        const late = requests.filter((request) => !request.outcome.settled);
        return {
            results: requests.flatMap(({ outcome }) =>
                outcome.result === undefined ? [] : [outcome.result]),
            truncated: late.length > 0,
            lateAnswers: Promise.all(late.map((request) => request.done))
                .then(() => late.some((request) => request.outcome.result !== undefined)),
        };
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
