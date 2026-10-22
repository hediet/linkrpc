import type { StreamCallOptions, StreamingCall } from '@hediet/linkrpc';
import { LinkRpcConnection, WebSocketTransport } from '@hediet/linkrpc/web';
import {
    DESKTOP_DATA_CHANNEL, desktopInterface, desktopViewportSchema, maintainDesktopLease,
    type DesktopAttachOptions, type DesktopAttachResult, type DesktopClientMessage,
    type DesktopServerMessage, type DesktopViewport,
    desktopHubInterface, DesktopRelay,
} from '@hediet/linkrpc-infra/desktop';

/** Opens the loopback control bridge. The peer data channel remains end-to-end. */
export async function createViewerClient(url: string, signal: AbortSignal) {
    return (await openViewerControl(url, signal)).get(desktopInterface).desktop;
}

export async function createHubViewerClient(url: string, signal: AbortSignal) {
    return (await openViewerControl(url, signal)).get(desktopHubInterface).desktop;
}

async function openViewerControl(url: string, signal: AbortSignal) {
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
    return connection;
}

/** WebSocket-compatible byte adapter; noVNC remains independent of hub framing. */
export class HubDesktopChannel extends EventTarget implements WebSocket {
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly extensions = '';
    readonly protocol = '';
    readonly url = '';
    binaryType: BinaryType = 'arraybuffer';
    readyState: WebSocket['readyState'] = 0;
    onopen: WebSocket['onopen'] = null;
    onmessage: WebSocket['onmessage'] = null;
    onclose: WebSocket['onclose'] = null;
    onerror: WebSocket['onerror'] = null;
    constructor(private readonly _relay: DesktopRelay, private readonly _close: () => void) { super(); }
    get bufferedAmount(): number { return this._relay.bufferedAmount; }
    send(data: Parameters<WebSocket['send']>[0]): void {
        if (this.readyState !== this.OPEN) { throw new Error('Desktop hub channel not open'); }
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
            : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined;
        if (!bytes) { throw new Error('Desktop hub channel requires binary input'); }
        try { this._relay.write(bytes); }
        catch (error) { this._close(); throw error; }
    }
    close(): void { this._close(); }
    open(): void {
        if (this.readyState !== this.CONNECTING) { throw new Error('Duplicate desktop hub ready'); }
        this.readyState = this.OPEN;
        const event = new Event('open');
        this.onopen?.call(this, event); this.dispatchEvent(event);
    }
    receive(data: Uint8Array): void {
        if (this.readyState !== this.OPEN) { throw new Error('Desktop hub data before ready'); }
        const event = new MessageEvent('message', { data: data.slice().buffer });
        this.onmessage?.call(this, event); this.dispatchEvent(event);
    }
    end(): void {
        if (this.readyState === this.CLOSED) { return; }
        this.readyState = this.CLOSED;
        const event = new CloseEvent('close', { wasClean: true, code: 1000 });
        this.onclose?.call(this, event); this.dispatchEvent(event);
    }
}

/** Explicit hub fallback. Data and authorization share one cancellable attach request. */
export function connectHubDesktop(
    client: Awaited<ReturnType<typeof createHubViewerClient>>,
    viewport: DesktopViewport,
    options: { signal: AbortSignal },
) {
    options.signal.throwIfAborted();
    desktopViewportSchema.parse(viewport);
    let ended = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    let call: ReturnType<typeof client.attach> | undefined;
    let lease: ReturnType<typeof maintainDesktopLease> | undefined;
    const close = (error?: Error) => {
        if (ended) { return; }
        ended = true;
        clearTimeout(timeout); lease?.dispose(); relay.dispose();
        options.signal.removeEventListener('abort', abort);
        channel.end();
        if (error) { rejectDone(error); } else { resolveDone(); }
        if (call) {
            void call.cancel('desktopHubClosed').finally(() => call?.dispose?.())
                .catch(error => console.error('Desktop hub cancellation failed:', error));
        }
    };
    const relay: DesktopRelay = new DesktopRelay(
        frame => {
            if (!call) { return Promise.reject(new Error('Desktop hub not attached')); }
            return call.send(frame);
        },
        data => channel.receive(data),
        error => close(error),
    );
    const channel: HubDesktopChannel = new HubDesktopChannel(relay, () => close());
    const abort = () => close(new Error('Desktop hub cancelled'));
    const timeout = setTimeout(() => close(new Error('Desktop hub setup timed out')), 60_000);
    options.signal.addEventListener('abort', abort, { once: true });
    try {
        call = client.attach({ params: {}, viewport }, {
            onMessage: message => {
                try {
                    if (message.t === 'ready') { channel.open(); clearTimeout(timeout); }
                    else if (message.t !== 'viewport') { relay.receive(message); }
                } catch (error) { close(error instanceof Error ? error : new Error(String(error))); }
            },
        });
        void call.then(() => close(), error => close(error instanceof Error ? error : new Error(String(error))));
        lease = maintainDesktopLease(() => call!.ping(), error => close(error));
    } catch (error) {
        close(error instanceof Error ? error : new Error(String(error)));
        throw error;
    }
    return {
        channel, done, close: () => close(),
        setViewport: (viewport: DesktopViewport) => {
            desktopViewportSchema.parse(viewport);
            if (ended || !call) { return Promise.reject(new Error('Desktop hub closed')); }
            return call.send({ t: 'viewport', viewport });
        },
    };
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
