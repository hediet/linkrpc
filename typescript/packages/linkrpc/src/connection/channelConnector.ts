import type { Channel } from './channel';
import type { IDisposable } from '../disposable';

/**
 * A raw channel that signals when it closes (and, when possible, can be torn
 * down). Both {@link openHubChannel}'s `HubChannel` and `openStdioChannel`'s
 * `StdioChannel` satisfy this shape.
 */
export type ConnectableChannel = Channel<undefined, unknown> & {
    /**
     * Fires once when the channel closes. Returns a disposable to unsubscribe.
     *
     * Ordering contract: when a close causes a sending method (e.g. a request
     * or notification) to reject/throw, {@link onClose} must fire *before* that
     * rejection surfaces to the caller. This lets consumers reliably tell a
     * close-induced failure (the channel is already observably closed) apart
     * from a genuine error (the channel is still open). See
     * {@link ChannelConnector.keepConnected}.
     */
    onClose(listener: () => void): IDisposable;
    /** Tear the channel down. Optional — stdio channels have no explicit close. */
    close?(): void;
};

/** Handle returned by {@link ChannelConnector.keepConnected}. */
export interface KeepConnectedHandle {
    /**
     * Resolves when the loop exits: the channel closed and the connector does
     * not redial, or {@link stop} (or the supplied signal) fired.
     */
    readonly done: Promise<void>;
    /** Stop redialing and close the current channel (if any). */
    stop(): void;
}

/** Callback run on every (re)connect. The channel is the raw, unsigned channel. */
export type OnChannelConnect<T extends ConnectableChannel> = (
    ctx: { channel: T; },
) => void | Promise<void>;

export interface ExpBackoffOptions {
    readonly initialBackoffMs?: number;
    readonly maxBackoffMs?: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

/**
 * Drives a connect / (re)connect loop over a raw {@link ConnectableChannel}.
 *
 * Unlike connection-level helpers, this works at the channel layer: the
 * caller composes identity / signing on top of the channel handed to
 * {@link keepConnected} (e.g. `SigningSender.wrapChannel(channel, { principal })`).
 *
 * Construct via {@link ChannelConnector.once} (a single, already-open channel
 * that never redials) or {@link ChannelConnector.expBackoff} (re-open via a
 * factory with exponential backoff after each close).
 */
export class ChannelConnector<T extends ConnectableChannel> {
    private constructor(
        private readonly _open: () => Promise<T>,
        private readonly _redial: boolean,
        private readonly _initialBackoffMs: number,
        private readonly _maxBackoffMs: number,
    ) { }

    /**
     * A connector over a single channel (or a promise of one). Never redials;
     * the loop ends when the channel closes or {@link KeepConnectedHandle.stop}
     * fires.
     */
    public static once<T extends ConnectableChannel>(channel: T | Promise<T>): ChannelConnector<T> {
        return new ChannelConnector<T>(
            async () => channel,
            false,
            DEFAULT_INITIAL_BACKOFF_MS,
            DEFAULT_MAX_BACKOFF_MS,
        );
    }

    /**
     * A redialing connector: `open` is called once per attempt, and the loop
     * reconnects with exponential backoff after each close (or failed open).
     */
    public static expBackoff<T extends ConnectableChannel>(
        open: () => Promise<T>,
        opts: ExpBackoffOptions = {},
    ): ChannelConnector<T> {
        return new ChannelConnector<T>(
            open,
            true,
            opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
            opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
        );
    }

    /**
     * Run `onConnect` on every (re)connect with the freshly opened channel.
     * The callback typically wraps the channel with signing and registers
     * handlers. Returns once the loop exits (see {@link KeepConnectedHandle}).
     */
    public keepConnected(
        onConnect: OnChannelConnect<T>,
        opts: { signal?: AbortSignal; } = {},
    ): KeepConnectedHandle {
        let stopped = false;
        let current: T | undefined;

        const stop = (): void => {
            if (stopped) {
                return;
            }
            stopped = true;
            const c = current;
            current = undefined;
            c?.close?.();
        };

        if (opts.signal) {
            if (opts.signal.aborted) {
                stopped = true;
            } else {
                opts.signal.addEventListener('abort', stop, { once: true });
            }
        }

        const done = (async () => {
            let backoff = this._initialBackoffMs;
            while (!stopped) {
                let channel: T;
                try {
                    channel = await this._open();
                } catch (e) {
                    if (stopped || !this._redial) {
                        throw e;
                    }
                    await _delay(backoff, opts.signal);
                    backoff = Math.min(backoff * 2, this._maxBackoffMs);
                    continue;
                }

                if (stopped) {
                    channel.close?.();
                    return;
                }

                current = channel;
                let isClosed = false;
                const closed = new Promise<void>((resolve) => {
                    channel.onClose(() => {
                        isClosed = true;
                        resolve();
                    });
                });

                try {
                    await onConnect({ channel });
                    backoff = this._initialBackoffMs;
                } catch (e) {
                    // Per the onClose ordering contract, a close-induced failure
                    // fires onClose before the sending method throws, so the
                    // channel is already observably closed here. In that case the
                    // error is just the close surfacing, and we fall through to
                    // redial. Otherwise it's a genuine error: tear down and
                    // rethrow rather than swallow it.
                    if (!isClosed) {
                        channel.close?.();
                        throw e;
                    }
                    if (current === channel) {
                        current = undefined;
                    }
                    if (stopped || !this._redial) {
                        return;
                    }
                    await _delay(backoff, opts.signal);
                    backoff = Math.min(backoff * 2, this._maxBackoffMs);
                    continue;
                }

                await closed;
                if (current === channel) {
                    current = undefined;
                }
                if (stopped || !this._redial) {
                    return;
                }
            }
        })();

        return { done, stop };
    }
}

function _delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
