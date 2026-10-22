import { defineInterface, defineInterfaceTemplate, requestType, type Schema } from '@hediet/linkrpc';
import { discriminatedUnion, int, literal, maximum, maxLength, minimum, number, object, string } from 'zod/mini';
import type { output } from 'zod/v4/core';
import { desktopAttachResultSchema, desktopInfoSchema, desktopViewportSchema } from './desktopInterface';

export const DESKTOP_RELAY_WINDOW = 256 * 1024;
export const DESKTOP_RELAY_CHUNK = 16 * 1024;
const data = object({ t: literal('data'), data: string().check(maxLength(21848)) });
const credit = object({ t: literal('credit'), bytes: number().check(int(), minimum(1), maximum(DESKTOP_RELAY_WINDOW)) });
const viewport = object({ t: literal('viewport'), viewport: desktopViewportSchema });
export const desktopHubClientMessageSchema = discriminatedUnion('t', [data, credit, viewport]);
export const desktopHubServerMessageSchema = discriminatedUnion('t', [data, credit, viewport, object({ t: literal('ready') })]);
export type DesktopHubClientMessage = output<typeof desktopHubClientMessageSchema>;
export type DesktopHubServerMessage = output<typeof desktopHubServerMessageSchema>;
export type DesktopRelayFrame = Extract<DesktopHubClientMessage, { t: 'data' | 'credit' }>;

/** Desktop-specific fallback: no client-selected port, URL, or arbitrary TCP target. */
export const DesktopHubTemplate = defineInterfaceTemplate(
    { id: 'linkrpc.desktop.hub.v1', parameters: ['params'], tags: ['linkrpc.desktop.hub'] },
    <P>({ params }: { params: Schema<P> }) => ({
        info: requestType(object({ params }), desktopInfoSchema),
        attach: requestType(object({ params, viewport: desktopViewportSchema }), desktopAttachResultSchema, {
            description: 'Exclusive RFB desktop carried through this hub stream. Server sends ready before data. '
                + 'Data frames contain canonical base64, at most 16384 decoded bytes. Each direction starts with '
                + '262144 bytes of credit; sending data consumes credit and the receiver returns credit only after '
                + 'consumption. Credit must not exceed the initial window. Viewport and lease messages consume no credit. '
                + 'Cancellation, control loss, or 60 seconds without a successful pong closes the source. Probe every 20 seconds.',
        }).withStream({ client: desktopHubClientMessageSchema, server: desktopHubServerMessageSchema }),
    }),
);

export const desktopHubInterface = defineInterface({
    id: 'linkrpc.desktop.hub',
    description: 'A desktop-specific hub-stream fallback implementing linkrpc.desktop.hub.v1.',
}, {
    desktop: DesktopHubTemplate({ params: object({}) }).mapMembers({ info: 'info', attach: 'attach' }),
});

/** Bounded bidirectional byte framing shared by browser and Node adapters. */
export class DesktopRelay {
    private _credit = DESKTOP_RELAY_WINDOW;
    private _receiving = 0;
    private _pending = 0;
    private _queue: Uint8Array[] = [];
    private _flushing = false;
    private _disposed = false;
    private _input = Promise.resolve();
    private _started: boolean;
    private _drains: { resolve(): void; reject(error: Error): void }[] = [];

    constructor(
        private readonly _send: (frame: DesktopRelayFrame) => Promise<void>,
        private readonly _consume: (data: Uint8Array) => void | Promise<void>,
        private readonly _fail: (error: Error) => void,
        startPaused = false,
    ) { this._started = !startPaused; }

    start(): void { this._started = true; void this.flush(); }

    write(data: Uint8Array): void {
        if (this._disposed) { throw new Error('Desktop relay closed'); }
        if (this._pending + data.byteLength > DESKTOP_RELAY_WINDOW) { throw new Error('Desktop relay send buffer exceeded'); }
        for (let offset = 0; offset < data.length; offset += DESKTOP_RELAY_CHUNK) {
            this._queue.push(data.slice(offset, offset + DESKTOP_RELAY_CHUNK));
        }
        this._pending += data.length;
        void this.flush();
    }

    get bufferedAmount(): number { return this._pending + DESKTOP_RELAY_WINDOW - this._credit; }

    async drain(): Promise<void> {
        if (this._disposed) { throw new Error('Desktop relay closed'); }
        if (this.bufferedAmount < DESKTOP_RELAY_WINDOW / 2) { return; }
        await new Promise<void>((resolve, reject) => this._drains.push({ resolve, reject }));
    }

    receive(frame: DesktopRelayFrame): void {
        if (this._disposed) { return; }
        if (frame.t === 'credit') {
            if (!Number.isInteger(frame.bytes) || frame.bytes <= 0 || this._credit + frame.bytes > DESKTOP_RELAY_WINDOW) {
                throw new Error('Invalid desktop relay credit');
            }
            this._credit += frame.bytes;
            void this.flush();
            this.notifyDrain();
            return;
        }
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
            || frame.data.length > 21848) { throw new Error('Invalid desktop relay base64'); }
        const raw = atob(frame.data);
        const bytes = Uint8Array.from(raw, value => value.charCodeAt(0));
        if (!bytes.length || bytes.length > DESKTOP_RELAY_CHUNK || btoa(raw) !== frame.data
            || this._receiving + bytes.length > DESKTOP_RELAY_WINDOW) { throw new Error('Desktop relay receive window exceeded'); }
        this._receiving += bytes.length;
        this._input = this._input.then(async () => {
            if (this._disposed) { return; }
            await this._consume(bytes);
            if (this._disposed) { return; }
            this._receiving -= bytes.length;
            await this._send({ t: 'credit', bytes: bytes.length });
        });
        void this._input.catch(error => this.fail(error));
    }

    dispose(): void {
        this._disposed = true;
        this._queue = [];
        this._pending = 0;
        this._credit = DESKTOP_RELAY_WINDOW;
        for (const drain of this._drains.splice(0)) { drain.reject(new Error('Desktop relay closed')); }
    }

    private async flush(): Promise<void> {
        if (this._flushing || this._disposed || !this._started) { return; }
        this._flushing = true;
        try {
            while (!this._disposed && this._queue.length && this._credit >= this._queue[0].length) {
                const bytes = this._queue.shift()!;
                this._credit -= bytes.length;
                await this._send({ t: 'data', data: btoa(String.fromCharCode(...bytes)) });
                if (this._disposed) { return; }
                this._pending -= bytes.length;
                this.notifyDrain();
            }
        } catch (error) { this.fail(error); }
        finally { this._flushing = false; }
    }

    private fail(error: unknown): void {
        if (this._disposed) { return; }
        this.dispose();
        this._fail(error instanceof Error ? error : new Error(String(error)));
    }

    private notifyDrain(): void {
        if (this.bufferedAmount < DESKTOP_RELAY_WINDOW / 2) {
            for (const drain of this._drains.splice(0)) { drain.resolve(); }
        }
    }
}
