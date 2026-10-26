import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import { RTCPeerConnection, type PeerConfig, type RTCDataChannel } from 'werift';
import WebSocket, { createWebSocketStream } from 'ws';
import {
    DESKTOP_DATA_CHANNEL, type DesktopAttachOptions, type DesktopBackend,
    type DesktopSession, type DesktopViewport, type DesktopRelay, DESKTOP_RELAY_CHUNK,
} from '@hediet/linkrpc-infra/desktop';

const HIGH_WATER = 256 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;

export interface VncSource {
    readonly title: string;
    /**
     * Trusted administrator configuration, never supplied by an attaching client:
     * a WebSocket RFB endpoint (`ws:`/`wss:`, e.g. websockify) or a plain RFB
     * server (`tcp://host:port`, e.g. a VNC server listening on loopback).
     */
    readonly sourceUrl: string;
    readonly dpiUrl?: string;
    readonly peerConfig?: Partial<PeerConfig>;
}

/** An RFB source (a WebSocket endpoint such as websockify, or a TCP VNC server) transported unchanged. */
export class VncBackend implements DesktopBackend {
    readonly title: string;
    private readonly _url: URL;

    constructor(private readonly _source: VncSource) {
        this.title = _source.title;
        this._url = new URL(_source.sourceUrl);
        if (this._url.protocol === 'tcp:') {
            if (!this._url.hostname || !this._url.port) throw new Error('A tcp: VNC source needs a host and port');
        } else if (this._url.protocol !== 'ws:' && this._url.protocol !== 'wss:') {
            throw new Error('VNC source must be ws:, wss:, or tcp:');
        }
    }

    /** One RFB byte stream to the source; it emits `error` and `close` like any socket. */
    private _openSource(): Duplex {
        if (this._url.protocol === 'tcp:') {
            const socket = net.connect({ host: this._url.hostname.replace(/^\[|\]$/g, ''), port: Number(this._url.port) });
            socket.setNoDelay(true);
            return socket;
        }
        const socket = new WebSocket(this._source.sourceUrl, ['binary'], { maxPayload: MAX_BUFFER });
        const stream = createWebSocketStream(socket);
        socket.on('message', (_data, binary) => {
            if (!binary) stream.destroy(new Error('VNC source sent non-binary data'));
        });
        stream.once('close', () => socket.terminate());
        return stream;
    }

    async openHub(viewport: DesktopViewport, signal: AbortSignal, relay: DesktopRelay): Promise<DesktopSession & {
        send(data: Uint8Array): Promise<void>;
    }> {
        signal.throwIfAborted();
        await this.setViewport(viewport, signal);
        signal.throwIfAborted();
        const source = this._openSource();
        const dispose = () => { source.destroy(); };
        signal.addEventListener('abort', dispose, { once: true });
        const done = (async () => {
            try {
                for await (const chunk of source) {
                    const bytes: Buffer = chunk;
                    for (let offset = 0; offset < bytes.length; offset += DESKTOP_RELAY_CHUNK) {
                        await relay.drain();
                        signal.throwIfAborted();
                        relay.write(bytes.subarray(offset, offset + DESKTOP_RELAY_CHUNK));
                    }
                }
            } finally {
                signal.removeEventListener('abort', dispose);
                dispose();
            }
        })();
        void done.catch(() => {});
        return {
            answer: '', done, dispose,
            setViewport: value => this.setViewport(value, signal),
            send: data => new Promise<void>((resolve, reject) => {
                if (signal.aborted || source.destroyed) { reject(new Error('Desktop hub source closed')); return; }
                source.write(data, error => error ? reject(error) : resolve());
            }),
        };
    }

    private async setViewport(viewport: DesktopViewport, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
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
    }

    async open(options: DesktopAttachOptions, signal: AbortSignal): Promise<DesktopSession> {
        signal.throwIfAborted();
        const peer = new RTCPeerConnection({ iceServers: [], ...this._source.peerConfig });
        let source: Duplex | undefined;
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
            source?.destroy();
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
            await this.setViewport(viewport, signal);
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
                if (typeof data === 'string' || !source || source.destroyed) {
                    fail(new Error('Invalid RFB data or source not ready'));
                    return;
                }
                if (data.length > MAX_BUFFER || source.writableLength + data.length > MAX_BUFFER) {
                    fail(new Error('VNC input buffer limit exceeded'));
                    return;
                }
                source.write(data, error => { if (error) fail(error); });
            });
            const connectSource = () => {
                if (closed || source) return;
                const opened = source = this._openSource();
                opened.on('error', fail);
                opened.on('close', () => dispose());
                opened.on('data', (buffer: Buffer) => {
                    if (closed) return;
                    if (incoming.bufferedAmount + buffer.length > MAX_BUFFER) {
                        fail(new Error('VNC output buffer limit exceeded'));
                        return;
                    }
                    try {
                        for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
                            incoming.send(buffer.subarray(offset, offset + CHUNK_SIZE));
                        }
                        if (incoming.bufferedAmount >= HIGH_WATER) opened.pause();
                    } catch (error) {
                        fail(error instanceof Error ? error : new Error(String(error)));
                    }
                });
                incoming.bufferedAmountLowThreshold = HIGH_WATER / 2;
                incoming.bufferedAmountLow.subscribe(() => { if (!closed) opened.resume(); });
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
