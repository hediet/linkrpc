import { RTCPeerConnection, type PeerConfig, type RTCDataChannel } from 'werift';
import WebSocket from 'ws';
import {
    DESKTOP_DATA_CHANNEL, type DesktopAttachOptions, type DesktopBackend,
    type DesktopSession, type DesktopViewport,
} from '@hediet/linkrpc-infra/desktop';

const HIGH_WATER = 256 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;

export interface VncSource {
    readonly title: string;
    /** Trusted administrator configuration, never supplied by an attaching client. */
    readonly websocketUrl: string;
    readonly dpiUrl?: string;
    readonly peerConfig?: Partial<PeerConfig>;
}

/** A WebSocket RFB source (e.g. websockify) transported unchanged over WebRTC. */
export class VncBackend implements DesktopBackend {
    readonly title: string;

    constructor(private readonly _source: VncSource) {
        this.title = _source.title;
        const url = new URL(_source.websocketUrl);
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('VNC source must be ws: or wss:');
    }

    async open(options: DesktopAttachOptions, signal: AbortSignal): Promise<DesktopSession> {
        signal.throwIfAborted();
        const peer = new RTCPeerConnection({ iceServers: [], ...this._source.peerConfig });
        let source: WebSocket | undefined;
        let channel: RTCDataChannel | undefined;
        let closed = false;
        let resolveDone!: () => void;
        let rejectDone!: (error: Error) => void;
        const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
        // Setup may fail before a caller has received the session handle.
        void done.catch(() => {});
        const dispose = () => {
            if (closed) return;
            closed = true;
            signal.removeEventListener('abort', abort);
            source?.terminate();
            channel?.close();
            void peer.close().catch(error => process.emitWarning(new Error('Desktop peer cleanup failed', { cause: error })));
            resolveDone();
        };
        const fail = (error: Error) => {
            if (closed) return;
            rejectDone(error);
            dispose();
        };
        const abort = () => dispose();
        signal.addEventListener('abort', abort, { once: true });
        const setViewport = async (viewport: DesktopViewport) => {
            signal.throwIfAborted();
            if (closed) throw new Error('Desktop data plane closed');
            if (Math.round(viewport.width * viewport.devicePixelRatio)
                * Math.round(viewport.height * viewport.devicePixelRatio) > 33_554_432) {
                throw new Error('Desktop framebuffer exceeds 32 megapixels');
            }
            if (!this._source.dpiUrl) return;
            const response = await fetch(this._source.dpiUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ devicePixelRatio: viewport.devicePixelRatio }),
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            });
            if (!response.ok) throw new Error(`VNC DPI update failed: HTTP ${response.status}`);
        };
        peer.connectionStateChange.subscribe(state => {
            if (state === 'failed' || state === 'disconnected') fail(new Error(`WebRTC ${state}`));
            if (state === 'closed') dispose();
        });
        peer.onDataChannel.subscribe(incoming => {
            if (closed || channel || incoming.label !== DESKTOP_DATA_CHANNEL || !incoming.ordered
                || incoming.maxRetransmits !== undefined || incoming.maxPacketLifeTime !== undefined) {
                incoming.close();
                fail(new Error('Expected one reliable ordered RFB data channel'));
                return;
            }
            channel = incoming;
            incoming.error.subscribe(error => fail(error));
            incoming.stateChange.subscribe(state => {
                if (state === 'closed' || state === 'closing') dispose();
            });
            incoming.onMessage.subscribe(data => {
                if (closed) return;
                if (typeof data === 'string' || !source || source.readyState !== WebSocket.OPEN) {
                    fail(new Error('Invalid RFB data or source not ready'));
                    return;
                }
                if (data.length > MAX_BUFFER || source.bufferedAmount + data.length > MAX_BUFFER) {
                    fail(new Error('VNC input buffer limit exceeded'));
                    return;
                }
                source.send(data, { binary: true }, error => { if (error) fail(error); });
            });
            const connectSource = () => {
                if (closed || source) return;
                source = new WebSocket(this._source.websocketUrl, ['binary'], { maxPayload: MAX_BUFFER });
                source.on('error', fail);
                source.on('close', () => dispose());
                source.on('message', (data, binary) => {
                    if (closed) return;
                    if (!binary) { fail(new Error('VNC source sent non-binary data')); return; }
                    const buffer = Array.isArray(data) ? Buffer.concat(data)
                        : data instanceof ArrayBuffer ? Buffer.from(data) : data;
                    if (incoming.bufferedAmount + buffer.length > MAX_BUFFER) {
                        fail(new Error('VNC output buffer limit exceeded'));
                        return;
                    }
                    try {
                        for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
                            incoming.send(buffer.subarray(offset, offset + CHUNK_SIZE));
                        }
                        if (incoming.bufferedAmount >= HIGH_WATER) source?.pause();
                    } catch (error) {
                        fail(error instanceof Error ? error : new Error(String(error)));
                    }
                });
                incoming.bufferedAmountLowThreshold = HIGH_WATER / 2;
                incoming.bufferedAmountLow.subscribe(() => { if (!closed) source?.resume(); });
            };
            incoming.stateChange.subscribe(state => { if (state === 'open') connectSource(); });
            if (incoming.readyState === 'open') connectSource();
        });
        try {
            await setViewport(options.viewport);
            await peer.setRemoteDescription({ type: 'offer', sdp: options.offer });
            signal.throwIfAborted();
            await peer.setLocalDescription(await peer.createAnswer());
            signal.throwIfAborted();
            if (closed) throw new Error('WebRTC closed during negotiation');
            const answer = peer.localDescription?.sdp;
            if (!answer) throw new Error('WebRTC did not produce an answer');
            return { answer, done, setViewport, dispose };
        } catch (error) {
            dispose();
            throw error;
        }
    }
}
