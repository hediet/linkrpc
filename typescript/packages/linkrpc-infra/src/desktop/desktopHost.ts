import type { StreamApi } from '@hediet/linkrpc';
import {
    type DesktopAttachOptions, type DesktopAttachResult, type DesktopClientMessage,
    type DesktopInfo, type DesktopServerMessage, type DesktopViewport,
} from './desktopInterface';
import { maintainDesktopLease } from './desktopLease';

export interface DesktopSession {
    readonly answer: string;
    /** Settles when the data channel or source closes; rejects on source/peer failure. */
    readonly done: Promise<void>;
    setViewport(viewport: DesktopViewport): Promise<void>;
    /** Synchronously blocks input/output and closes the peer and source. Idempotent. */
    dispose(): void;
}

export interface DesktopBackend {
    readonly title: string;
    /** Must observe signal during setup and release partially created resources on failure. */
    open(options: DesktopAttachOptions, signal: AbortSignal): Promise<DesktopSession>;
}

export type DesktopStream = StreamApi<DesktopClientMessage, DesktopServerMessage>;

/** Shared exclusive-controller and control-plane lifetime policy for desktop sources. */
export class DesktopHost {
    private _active: AbortController | undefined;
    private _disposed = false;

    constructor(private readonly _backend: DesktopBackend) {}

    info(): DesktopInfo {
        return { title: this._backend.title, available: !this._disposed && !this._active, protocol: 'rfb' };
    }

    dispose(): void {
        this._disposed = true;
        this._active?.abort(new Error('Desktop service closed'));
    }

    async attach(options: DesktopAttachOptions, stream: DesktopStream): Promise<DesktopAttachResult> {
        stream.signal.throwIfAborted();
        if (this._disposed) throw new Error('Desktop service closed');
        if (this._active) throw new Error('Desktop already has a controller');
        const control = new AbortController();
        this._active = control;
        let session: DesktopSession | undefined;
        let abort!: () => void;
        const ended = new Promise<void>(resolve => {
            abort = () => {
                session?.dispose();
                resolve();
            };
            control.signal.addEventListener('abort', abort, { once: true });
        });
        const cancel = () => control.abort(stream.signal.reason);
        stream.signal.addEventListener('abort', cancel, { once: true });
        const lease = maintainDesktopLease(() => stream.ping(), error => control.abort(error));
        let updates = Promise.resolve();
        let pendingUpdates = 0;
        try {
            const opening = this._backend.open(options, control.signal).then(value => {
                if (control.signal.aborted) value.dispose();
                else session = value;
            });
            await Promise.race([opening, ended]);
            control.signal.throwIfAborted();
            if (!session) throw new Error('Desktop source did not open');
            await Promise.race([stream.send({ t: 'answer', sdp: session.answer }), ended]);
            control.signal.throwIfAborted();
            const live = session;
            stream.onMessage(message => {
                if (control.signal.aborted) return;
                if (pendingUpdates >= 8) {
                    control.abort(new Error('Too many pending viewport updates'));
                    return;
                }
                pendingUpdates++;
                updates = updates.then(async () => {
                    control.signal.throwIfAborted();
                    await live.setViewport(message.viewport);
                    await stream.send({ t: 'viewport', viewport: message.viewport });
                }).finally(() => pendingUpdates--);
                void updates.catch(error => control.abort(error));
            });
            await Promise.race([live.done, ended]);
            control.signal.throwIfAborted();
            return { reason: 'closed' };
        } finally {
            lease.dispose();
            stream.signal.removeEventListener('abort', cancel);
            control.abort(new Error('Desktop attachment ended'));
            control.signal.removeEventListener('abort', abort);
            if (this._active === control) this._active = undefined;
        }
    }
}

export function desktopHandlers<P>(resolve: (params: P) => DesktopHost) {
    return {
        info: ({ params }: { readonly params: P }) => resolve(params).info(),
        attach: ({ params, ...options }: DesktopAttachOptions & { readonly params: P }, _context: unknown, stream: DesktopStream) =>
            resolve(params).attach(options, stream),
    };
}
