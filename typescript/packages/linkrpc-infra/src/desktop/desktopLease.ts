import { DESKTOP_LEASE_TIMEOUT_MS, DESKTOP_PROBE_INTERVAL_MS } from './desktopInterface';

/**
 * Only a completed round-trip over the owning request renews the lease.
 * Keep one probe outstanding, even if the control path silently blackholes.
 */
export function maintainDesktopLease(ping: () => Promise<void>, expire: (error: Error) => void): { dispose(): void } {
    let disposed = false;
    let probing = false;
    let deadline: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => {
        if (disposed) return;
        dispose();
        expire(error);
    };
    const renew = () => {
        clearTimeout(deadline);
        deadline = setTimeout(() => fail(new Error('Desktop control lease expired')), DESKTOP_LEASE_TIMEOUT_MS);
    };
    const interval = setInterval(() => {
        if (disposed || probing) return;
        probing = true;
        Promise.resolve().then(ping).then(() => {
            probing = false;
            if (!disposed) renew();
        }, error => fail(error instanceof Error ? error : new Error(String(error))));
    }, DESKTOP_PROBE_INTERVAL_MS);
    function dispose() {
        if (disposed) return;
        disposed = true;
        clearInterval(interval);
        clearTimeout(deadline);
    }
    renew();
    return { dispose };
}
