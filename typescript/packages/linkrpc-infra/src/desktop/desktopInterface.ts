import { defineInterface, defineInterfaceTemplate, requestType, type Schema } from '@hediet/linkrpc';
import {
    boolean, discriminatedUnion, int, literal, maximum, maxLength, minimum, number,
    object, string,
} from 'zod/mini';
import type { output } from 'zod/v4/core';

export const DESKTOP_INTERFACE_TAG = 'linkrpc.desktop';
export const DESKTOP_TEMPLATE_ID = 'linkrpc.desktop.v1';
export const DESKTOP_PROBE_INTERVAL_MS = 20_000;
export const DESKTOP_LEASE_TIMEOUT_MS = 60_000;
export const DESKTOP_DATA_CHANNEL = 'linkrpc.desktop.rfb.v1';

/** CSS viewport dimensions, not framebuffer dimensions; implementations apply DPR. */
export const desktopViewportSchema = object({
    width: number().check(int(), minimum(32), maximum(16384)),
    height: number().check(int(), minimum(32), maximum(16384)),
    devicePixelRatio: number().check(minimum(0.5), maximum(4)),
});
export type DesktopViewport = output<typeof desktopViewportSchema>;

export const desktopInfoSchema = object({
    title: string(),
    available: boolean(),
    protocol: literal('rfb'),
});
export type DesktopInfo = output<typeof desktopInfoSchema>;

export const desktopAttachOptionsSchema = object({
    /** Complete SDP including ICE candidates. v1 does not use trickle ICE. */
    offer: string().check(maxLength(262144)),
    viewport: desktopViewportSchema,
});
export type DesktopAttachOptions = output<typeof desktopAttachOptionsSchema>;

export const desktopClientMessageSchema = object({ t: literal('viewport'), viewport: desktopViewportSchema });
export type DesktopClientMessage = output<typeof desktopClientMessageSchema>;
export const desktopServerMessageSchema = discriminatedUnion('t', [
    object({ t: literal('answer'), sdp: string().check(maxLength(262144)) }),
    object({ t: literal('viewport'), viewport: desktopViewportSchema }),
]);
export type DesktopServerMessage = output<typeof desktopServerMessageSchema>;
export const desktopAttachResultSchema = object({ reason: literal('closed') });
export type DesktopAttachResult = output<typeof desktopAttachResultSchema>;

/**
 * A source-independent desktop selected by `params`. One long-lived attach
 * request authorizes exactly one WebRTC peer and owns its entire lifetime.
 */
export const DesktopTemplate = defineInterfaceTemplate(
    { id: DESKTOP_TEMPLATE_ID, parameters: ['params'], tags: [DESKTOP_INTERFACE_TAG] },
    <P>({ params }: { params: Schema<P> }) => ({
        info: requestType(object({ params }), desktopInfoSchema, {
            description: 'Describe the desktop selected by params. available is advisory; attach acquires the exclusive controller.',
        }),
        attach: requestType(object({
            params, offer: desktopAttachOptionsSchema.shape.offer, viewport: desktopViewportSchema,
        }), desktopAttachResultSchema, {
            description: 'Acquire the desktop selected by params and negotiate WebRTC using complete offer/answer SDP. '
                + 'The caller creates one ordered reliable binary data channel named linkrpc.desktop.rfb.v1 carrying RFB bytes. '
                + 'No desktop bytes travel through the hub. The answer is the first server stream message. '
                + 'Viewport messages synchronize application DPI; RFB SetDesktopSize synchronizes framebuffer dimensions. '
                + 'Each side probes the other with the existing request stream ping/pong every 20 seconds, '
                + 'and closes its data plane after 60 seconds without a successful pong. Data-plane activity never renews this lease. '
                + 'Cancellation, control disconnect, request completion, or lease expiry closes the peer and source immediately. '
                + 'Reconnecting requires a new attach request and fresh ICE/DTLS credentials. Only one controller is allowed.',
        }).withStream({ client: desktopClientMessageSchema, server: desktopServerMessageSchema }),
    }),
);

export const desktopInterface = defineInterface({
    id: 'linkrpc.desktop',
    description: 'A single desktop implementing the linkrpc.desktop.v1 template.',
}, {
    desktop: DesktopTemplate({ params: object({}) }).mapMembers({ info: 'info', attach: 'attach' }),
});
