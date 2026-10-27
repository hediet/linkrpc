/**
 * Carries many local TCP connections over one compute-node `tcpForward.multiplex` call,
 * as Node.js duplex streams. Ported from personal-bot's frontend-server.
 */
import { Agent, type ClientRequestArgs } from 'node:http';
import { Duplex } from 'node:stream';
import type { InterfaceClient } from '@hediet/linkrpc';
import type {
    ComputeNodeMultiplexedTcpClientFrame,
    ComputeNodeMultiplexedTcpServerFrame,
    computeNodeTcpForwardInterface,
} from '../compute-node/index';

export type TcpForwardClient = InterfaceClient<typeof computeNodeTcpForwardInterface>;

/** The address forwarded connections are opened to on the compute node. */
export const FORWARDED_HOST = '127.0.0.1';
type TcpMultiplexCall = ReturnType<TcpForwardClient['multiplex']>;

const MAX_TCP_FRAME_BYTES = 64 * 1_024;
const MAX_BUFFERED_READ_BYTES = 256 * 1_024;
const READY_TIMEOUT_MS = 30_000;

export class HubTcpMultiplexer {
    private readonly _call: TcpMultiplexCall;
    private readonly _ready: Promise<void>;
    private readonly _sockets = new Map<string, HubMultiplexedTcpSocket>();
    private readonly _slotWaiters: { resolve(): void; reject(error: Error): void }[] = [];
    private _resolveReady!: () => void;
    private _rejectReady!: (error: Error) => void;
    private _sendTail = Promise.resolve();
    private _readyTimer: ReturnType<typeof setTimeout> | undefined;
    private _closedError: Error | undefined;
    private _maxConnections = 0;
    private _receiveWindowBytes = 0;
    private _nextConnectionId = 0;
    private _activeSlots = 0;
    private _expectedClose = false;

    constructor(
        client: TcpForwardClient,
        port: number,
        private readonly _onClose?: () => void,
    ) {
        this._ready = new Promise<void>((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });
        this._ready.catch(() => { /* surfaced through openSocket */ });
        this._readyTimer = setTimeout(() => this._fail(new Error('Timed out opening the TCP multiplex session')), READY_TIMEOUT_MS);
        this._readyTimer.unref?.();
        this._call = client.multiplex(
            { host: FORWARDED_HOST, port },
            { onMessage: message => this._handleMessage(message) },
        );
        void this._call.then(
            result => {
                if (this._expectedClose && result.reason === 'cancelled') {
                    this._finish(new Error('TCP multiplex session closed'));
                    return;
                }
                this._fail(new Error(result.message ?? `TCP multiplex session ended: ${result.reason}`));
            },
            (error: unknown) => this._fail(normalizeError(error)),
        );
    }

    get closed(): boolean {
        return this._closedError !== undefined;
    }

    waitUntilReady(): Promise<void> {
        return this._ready;
    }

    async openSocket(): Promise<HubMultiplexedTcpSocket> {
        await this._ready;
        await this._acquireSlot();
        if (this._closedError) {
            this._releaseSlot();
            throw this._closedError;
        }
        const connectionId = `c${(++this._nextConnectionId).toString(36)}`;
        const socket = new HubMultiplexedTcpSocket(this, connectionId, this._receiveWindowBytes);
        this._sockets.set(connectionId, socket);
        try {
            await this.send({ type: 'open', connectionId });
            await socket.waitUntilReady();
            return socket;
        } catch (error) {
            socket.destroy();
            throw error;
        }
    }

    send(frame: ComputeNodeMultiplexedTcpClientFrame): Promise<void> {
        if (this._closedError) {
            return Promise.reject(this._closedError);
        }
        const sent = this._sendTail.then(() => this._call.send(frame));
        this._sendTail = sent.catch((error: unknown) => this._fail(normalizeError(error)));
        return sent;
    }

    detach(connectionId: string): void {
        if (this._sockets.delete(connectionId)) {
            this._releaseSlot();
        }
    }

    dispose(): Promise<void> {
        if (this._expectedClose) {
            return Promise.resolve();
        }
        this._expectedClose = true;
        this._finish(new Error('TCP multiplex session disposed'));
        return Promise.resolve(this._call.cancel('TCP multiplex session disposed')).catch(() => undefined);
    }

    private _handleMessage(message: ComputeNodeMultiplexedTcpServerFrame): void {
        if (this._closedError) {
            return;
        }
        if (message.type === 'ready') {
            if (this._maxConnections !== 0) {
                this._fail(new Error('TCP multiplex session sent duplicate readiness'));
                return;
            }
            this._maxConnections = message.maxConnections;
            this._receiveWindowBytes = message.receiveWindowBytes;
            clearTimeout(this._readyTimer);
            this._readyTimer = undefined;
            this._resolveReady();
            return;
        }
        const socket = this._sockets.get(message.connectionId);
        if (!socket) {
            return;
        }
        switch (message.type) {
            case 'opened':
                socket.handleOpened(message.receiveWindowBytes);
                return;
            case 'data':
                socket.handleData(Buffer.from(message.dataBase64, 'base64'));
                return;
            case 'credit':
                socket.handleCredit(message.bytes);
                return;
            case 'end':
                socket.handleEnd();
                return;
            case 'closed':
                socket.handleClosed(message.reason, message.message);
                return;
        }
    }

    private async _acquireSlot(): Promise<void> {
        if (this._closedError) {
            throw this._closedError;
        }
        if (this._activeSlots < this._maxConnections) {
            this._activeSlots++;
            return;
        }
        await new Promise<void>((resolve, reject) => this._slotWaiters.push({ resolve, reject }));
    }

    private _releaseSlot(): void {
        this._activeSlots--;
        const waiter = this._slotWaiters.shift();
        if (waiter) {
            this._activeSlots++;
            waiter.resolve();
        }
    }

    private _fail(error: Error): void {
        this._finish(error);
        if (!this._expectedClose) {
            this._expectedClose = true;
            void Promise.resolve(this._call.cancel(error.message)).catch(() => undefined);
        }
    }

    private _finish(error: Error): void {
        if (this._closedError) {
            return;
        }
        this._closedError = error;
        clearTimeout(this._readyTimer);
        this._readyTimer = undefined;
        this._rejectReady(error);
        for (const waiter of this._slotWaiters.splice(0)) {
            waiter.reject(error);
        }
        for (const socket of [...this._sockets.values()]) {
            socket.handleSessionClosed(error);
        }
        this._onClose?.();
    }
}

export class HubMultiplexedTcpSocket extends Duplex {
    private readonly _ready: Promise<void>;
    private readonly _sendCredit = new ByteCredit();
    private _resolveReady!: () => void;
    private _rejectReady!: (error: Error) => void;
    private _timeout: ReturnType<typeof setTimeout> | undefined;
    private _closeAckTimer: ReturnType<typeof setTimeout> | undefined;
    private _connected = false;
    private _remoteClosed = false;
    private _remoteEnded = false;
    private _readBackpressured = false;
    private readonly _pendingData: Buffer[] = [];
    private _pendingDataBytes = 0;
    private _withheldCreditBytes = 0;
    private _receiveCreditBytes: number;

    constructor(
        private readonly _multiplexer: HubTcpMultiplexer,
        private readonly _connectionId: string,
        receiveWindowBytes: number,
    ) {
        super({ allowHalfOpen: false });
        this._receiveCreditBytes = receiveWindowBytes;
        this._ready = new Promise<void>((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });
        this._ready.catch(() => { /* surfaced through openSocket */ });
    }

    waitUntilReady(): Promise<void> {
        return this._ready;
    }

    handleOpened(receiveWindowBytes: number): void {
        if (this._connected || this.destroyed) {
            this.destroy(new Error('Logical TCP connection sent duplicate readiness'));
            return;
        }
        this._connected = true;
        if (!this._sendCredit.open(receiveWindowBytes)) {
            this.destroy(new Error('Logical TCP connection advertised an invalid receive window'));
            return;
        }
        this._resolveReady();
        this.emit('connect');
    }

    handleData(data: Buffer): void {
        if (this.destroyed || this._remoteEnded) {
            return;
        }
        if (data.byteLength > MAX_TCP_FRAME_BYTES || data.byteLength > this._receiveCreditBytes) {
            this.destroy(new Error('Logical TCP peer exceeded its receive credit'));
            return;
        }
        this._receiveCreditBytes -= data.byteLength;
        this._receive(data);
    }

    handleCredit(bytes: number): void {
        if (!this._sendCredit.add(bytes)) {
            this.destroy(new Error('Logical TCP peer exceeded the negotiated send window'));
        }
    }

    handleEnd(): void {
        if (this.destroyed || this._remoteEnded) {
            return;
        }
        this._remoteEnded = true;
        if (this._pendingData.length === 0) {
            this.push(null);
        }
    }

    handleClosed(reason: string, message?: string): void {
        this._remoteClosed = true;
        clearTimeout(this._closeAckTimer);
        this._multiplexer.detach(this._connectionId);
        if (this.destroyed) {
            return;
        }
        const error = reason === 'error' || reason === 'protocolError' || reason === 'limit'
            ? new Error(message ?? `Logical TCP connection closed: ${reason}`)
            : undefined;
        if (!this._connected) {
            this._rejectReady(error ?? new Error(message ?? `Logical TCP connection closed before readiness: ${reason}`));
            this.destroy();
            return;
        }
        this.destroy(error);
    }

    handleSessionClosed(error: Error): void {
        this._remoteClosed = true;
        clearTimeout(this._closeAckTimer);
        this._multiplexer.detach(this._connectionId);
        if (this.destroyed) {
            return;
        }
        this._sendCredit.close(error);
        if (!this._connected) {
            this._rejectReady(error);
            this.destroy();
            return;
        }
        this.destroy(error);
    }

    override _read(): void {
        this._readBackpressured = false;
        if (this._withheldCreditBytes > 0) {
            const bytes = this._withheldCreditBytes;
            this._withheldCreditBytes = 0;
            this._grantReceiveCredit(bytes);
        }
        while (this._pendingData.length > 0) {
            const data = this._pendingData.shift()!;
            this._pendingDataBytes -= data.length;
            if (!this.push(data)) {
                this._readBackpressured = true;
                this._withheldCreditBytes += data.byteLength;
                break;
            }
            this._grantReceiveCredit(data.byteLength);
        }
        if (this._remoteEnded && this._pendingData.length === 0) {
            this.push(null);
        }
    }

    override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        void this._sendData(data).then(() => callback(), (error: unknown) => callback(normalizeError(error)));
    }

    override _final(callback: (error?: Error | null) => void): void {
        void this._multiplexer.send({ type: 'end', connectionId: this._connectionId })
            .then(() => callback(), (error: unknown) => callback(normalizeError(error)));
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        clearTimeout(this._timeout);
        this._sendCredit.close(error ?? new Error('Logical TCP socket closed'));
        if (this._remoteClosed) {
            this._multiplexer.detach(this._connectionId);
            callback(error);
            return;
        }
        void this._multiplexer.send({ type: 'close', connectionId: this._connectionId }).then(
            () => {
                if (!this._remoteClosed) {
                    this._closeAckTimer = setTimeout(() => this._multiplexer.detach(this._connectionId), 5_000);
                    this._closeAckTimer.unref?.();
                }
                callback(error);
            },
            () => {
                this._multiplexer.detach(this._connectionId);
                callback(error);
            },
        );
    }

    /** Socket-compatible members used by `http.Agent`. */
    setTimeout(timeoutMs: number, callback?: () => void): this {
        clearTimeout(this._timeout);
        if (timeoutMs > 0) {
            this._timeout = setTimeout(() => this.emit('timeout'), timeoutMs);
            this._timeout.unref?.();
        }
        if (callback) {
            this.once('timeout', callback);
        }
        return this;
    }

    setNoDelay(): this {
        return this;
    }

    setKeepAlive(): this {
        return this;
    }

    ref(): this {
        return this;
    }

    unref(): this {
        return this;
    }

    private async _sendData(data: Buffer): Promise<void> {
        let offset = 0;
        while (offset < data.byteLength) {
            const bytes = await this._sendCredit.take(Math.min(MAX_TCP_FRAME_BYTES, data.byteLength - offset));
            const frame = data.subarray(offset, offset + bytes);
            await this._multiplexer.send({ type: 'data', connectionId: this._connectionId, dataBase64: frame.toString('base64') });
            offset += frame.byteLength;
        }
    }

    private _receive(data: Buffer): void {
        if (!this._readBackpressured && this._pendingData.length === 0) {
            if (this.push(data)) {
                this._grantReceiveCredit(data.byteLength);
            } else {
                this._readBackpressured = true;
                this._withheldCreditBytes += data.byteLength;
            }
            return;
        }
        this._pendingData.push(data);
        this._pendingDataBytes += data.length;
        if (this._pendingDataBytes > MAX_BUFFERED_READ_BYTES) {
            this.destroy(new Error('Logical TCP receive buffer exceeded 256 KiB'));
        }
    }

    private _grantReceiveCredit(bytes: number): void {
        this._receiveCreditBytes += bytes;
        void this._multiplexer.send({ type: 'credit', connectionId: this._connectionId, bytes })
            .catch((error: unknown) => this.destroy(normalizeError(error)));
    }
}

/** An HTTP agent whose sockets are logical connections of one multiplexer. */
export class HubTcpHttpAgent extends Agent {
    constructor(private readonly _multiplexer: HubTcpMultiplexer, maxSockets: number) {
        super({ keepAlive: true, maxSockets, maxTotalSockets: maxSockets, maxFreeSockets: maxSockets });
    }

    override createConnection(_options: ClientRequestArgs, callback: (error: Error | null, stream?: Duplex) => void): Duplex | null | undefined {
        void this._multiplexer.openSocket().then(socket => callback(null, socket), (error: unknown) => callback(normalizeError(error)));
        return undefined;
    }
}

class ByteCredit {
    private _available = 0;
    private _limit = 0;
    private _waiter: { resolve(): void; reject(error: Error): void } | undefined;
    private _closedError: Error | undefined;

    open(bytes: number): boolean {
        if (this._limit !== 0 || bytes <= 0) {
            return false;
        }
        this._limit = bytes;
        this._available = bytes;
        this._wake();
        return true;
    }

    add(bytes: number): boolean {
        if (this._closedError || this._limit === 0 || this._available + bytes > this._limit) {
            return false;
        }
        this._available += bytes;
        this._wake();
        return true;
    }

    async take(maxBytes: number): Promise<number> {
        while (this._available === 0) {
            if (this._closedError) {
                throw this._closedError;
            }
            await new Promise<void>((resolve, reject) => { this._waiter = { resolve, reject }; });
        }
        const bytes = Math.min(maxBytes, this._available);
        this._available -= bytes;
        return bytes;
    }

    close(error: Error): void {
        if (this._closedError) {
            return;
        }
        this._closedError = error;
        this._waiter?.reject(error);
        this._waiter = undefined;
    }

    private _wake(): void {
        this._waiter?.resolve();
        this._waiter = undefined;
    }
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
