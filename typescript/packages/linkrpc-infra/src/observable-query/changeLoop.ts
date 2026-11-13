/** The server side of a streaming call, as passed to a handler. */
export interface ServerStream<T> {
    readonly signal: AbortSignal;
    send(message: T): Promise<void>;
}

/**
 * Runs `update` once, then again after each change notification, until `signal` aborts. Updates
 * never overlap; notifications during an update cause exactly one more update. Resolves when
 * aborted, and rejects with the first error of `update` unless aborted meanwhile.
 */
export async function runChangeLoop(
    signal: AbortSignal,
    subscribe: (listener: () => void) => () => void,
    update: () => Promise<void>,
    minIntervalMs: number,
): Promise<void> {
    let dirty = true;
    let wake: (() => void) | undefined;
    const notify = () => {
        dirty = true;
        wake?.();
    };
    const unsubscribe = subscribe(notify);
    signal.addEventListener('abort', notify);
    try {
        while (!signal.aborted) {
            if (!dirty) {
                await new Promise<void>(resolve => { wake = resolve; });
                wake = undefined;
                continue;
            }
            dirty = false;
            try {
                await update();
            } catch (error) {
                if (signal.aborted) return;
                throw error;
            }
            if (minIntervalMs > 0) await delay(minIntervalMs, signal);
        }
    } finally {
        unsubscribe();
        signal.removeEventListener('abort', notify);
    }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done);
    });
}
