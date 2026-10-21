import type { StreamCallOptions, StreamingCall } from '@hediet/linkrpc';
import { LinkRpcConnection, WebSocketTransport } from '@hediet/linkrpc/web';
import {
    DESKTOP_DATA_CHANNEL, desktopInterface, desktopViewportSchema, maintainDesktopLease,
    type DesktopAttachOptions, type DesktopAttachResult, type DesktopClientMessage,
    type DesktopServerMessage, type DesktopViewport,
} from '@hediet/linkrpc-infra/desktop';

/** Opens the loopback control bridge. The peer data channel remains end-to-end. */
export async function createViewerClient(url: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const socket = new WebSocket(url);
    const close = () => socket.close();
    signal.addEventListener('abort', close, { once: true });
    socket.addEventListener('close', () => signal.removeEventListener('abort', close), { once: true });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('Desktop control connection timed out')), 60_000);
            const finish = (error?: Error) => {
                clearTimeout(timer);
                socket.removeEventListener('message', ready);
                socket.removeEventListener('error', failed);
                socket.removeEventListener('close', closed);
                error ? reject(error) : resolve();
            };
            const ready = (event: MessageEvent) => {
                try {
                    const message: unknown = JSON.parse(event.data);
                    if (!message || typeof message !== 'object' || !('method' in message)
                        || message.method !== 'desktop.viewer.ready') {
                        throw new Error('Unexpected desktop control handshake');
                    }
                    finish();
                } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
            };
            const failed = () => finish(new Error('Desktop control connection failed'));
            const closed = () => finish(new Error('Desktop control connection closed'));
            socket.addEventListener('message', ready);
            socket.addEventListener('error', failed, { once: true });
            socket.addEventListener('close', closed, { once: true });
        });
    } catch (error) {
        close();
        throw error;
    }
    signal.throwIfAborted();
    const connection = LinkRpcConnection.fromTransport(new WebSocketTransport(socket, () => connection.close()));
    return connection.get(desktopInterface).desktop;
}

/** A template instance selected through reflection or a typed containing interface. */
export interface DesktopClient<P> {
    attach(
        options: DesktopAttachOptions & { params: P },
        stream: StreamCallOptions<DesktopServerMessage>,
    ): StreamingCall<DesktopAttachResult, DesktopClientMessage>;
}

export interface DesktopConnection {
    /** Feed this reliable ordered binary channel to noVNC's raw-channel constructor. */
    readonly channel: RTCDataChannel;
    readonly done: Promise<void>;
    setViewport(viewport: DesktopViewport): Promise<void>;
    close(): void;
}

/** Connects to any source implementing DesktopTemplate; knows nothing about Docker or websockify. */
export async function connectDesktop<P>(
    client: DesktopClient<P>,
    params: P,
    viewport: DesktopViewport,
    options: { signal: AbortSignal; iceServers?: RTCIceServer[] },
): Promise<DesktopConnection> {
    options.signal.throwIfAborted();
    desktopViewportSchema.parse(viewport);
    const peer = new RTCPeerConnection({ iceServers: options.iceServers ?? [] });
    const channel = peer.createDataChannel(DESKTOP_DATA_CHANNEL, { ordered: true });
    channel.binaryType = 'arraybuffer';
    const control = new AbortController();
    let call: StreamingCall<DesktopAttachResult, DesktopClientMessage> | undefined;
    let lease: { dispose(): void } | undefined;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    const close = (error?: Error) => {
        if (control.signal.aborted) return;
        control.abort(error ?? new Error('Desktop closed'));
        clearTimeout(setupTimeout);
        lease?.dispose();
        channel.close();
        peer.close();
        options.signal.removeEventListener('abort', abort);
        if (error) rejectDone(error);
        else resolveDone();
        if (call) {
            const closing = call;
            void closing.cancel('desktopClosed').finally(() => closing.dispose?.()).catch(rejectDone);
        }
    };
    const abort = () => close(options.signal.reason instanceof Error ? options.signal.reason : new Error('Desktop cancelled'));
    options.signal.addEventListener('abort', abort, { once: true });
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
        control.signal.throwIfAborted();
        let listener!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
            listener = () => reject(control.signal.reason);
            control.signal.addEventListener('abort', listener, { once: true });
        });
        try { return await Promise.race([promise, aborted]); }
        finally { control.signal.removeEventListener('abort', listener); }
    };
    const setupTimeout = setTimeout(() => close(new Error('Desktop negotiation timed out')), 60_000);
    peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
            close(new Error(`WebRTC ${peer.connectionState}`));
        }
    });
    channel.addEventListener('close', () => close());
    channel.addEventListener('closing', () => close());
    try {
        await wait(peer.setLocalDescription(await wait(peer.createOffer())));
        await wait(new Promise<void>(resolve => {
            if (peer.iceGatheringState === 'complete') { resolve(); return; }
            const listener = () => {
                if (peer.iceGatheringState === 'complete') {
                    peer.removeEventListener('icegatheringstatechange', listener);
                    resolve();
                }
            };
            peer.addEventListener('icegatheringstatechange', listener);
        }));
        const offer = peer.localDescription?.sdp;
        if (!offer) throw new Error('WebRTC did not produce an offer');
        let answerSeen = false;
        let resolveAnswer!: () => void;
        let rejectAnswer!: (error: Error) => void;
        const answered = new Promise<void>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
        call = client.attach({ params, offer, viewport }, {
            onMessage: message => {
                if (message.t !== 'answer') return;
                if (answerSeen) { close(new Error('Duplicate desktop answer')); return; }
                answerSeen = true;
                void peer.setRemoteDescription({ type: 'answer', sdp: message.sdp }).then(resolveAnswer, rejectAnswer);
            },
        });
        void call.then(() => close(), error => close(error instanceof Error ? error : new Error(String(error))));
        lease = maintainDesktopLease(() => call!.ping(), error => close(error));
        await wait(answered);
        // Install the RFB consumer before the source can send its initial greeting.
        channel.addEventListener('open', () => clearTimeout(setupTimeout), { once: true });
        if (channel.readyState === 'open') clearTimeout(setupTimeout);
        return {
            channel, done,
            setViewport: value => {
                control.signal.throwIfAborted();
                desktopViewportSchema.parse(value);
                return call!.send({ t: 'viewport', viewport: value });
            },
            close: () => close(),
        };
    } catch (error) {
        clearTimeout(setupTimeout);
        close(error instanceof Error ? error : new Error(String(error)));
        throw error;
    }
}
