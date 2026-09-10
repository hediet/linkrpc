export const DEFAULT_RPC_TIMEOUT_MS = 5_000;

export interface CancellableRequest<T> extends Promise<T> {
    cancel(reason?: string): void | Promise<void>;
    dispose?(reason?: string): void;
}

export async function withRpcTimeout<T>(
    request: CancellableRequest<T>,
    target: string,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<T> {
    if (timeoutMs <= 0) return request;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            const reason = `${target} timed out after ${timeoutMs}ms`;
            try {
                Promise.resolve(request.cancel(reason)).catch(() => {
                    // The timeout remains authoritative even if remote cancellation fails.
                });
            } finally {
                try {
                    request.dispose?.(reason);
                } catch {
                    // Local disposal must not replace the timeout result.
                }
            }
            reject(new Error(reason));
        }, timeoutMs);
    });

    try {
        return await Promise.race([request, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
