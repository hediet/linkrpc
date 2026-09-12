import type { JsonRpcMessage } from '../protocol/jsonRpc';
import type { IMessageTransport } from '../transport/messageTransport';

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_CONTENT_LENGTH = 64 * 1024 * 1024;
const DEFAULT_MAX_PENDING_MESSAGES = 1_024;

export interface HeaderDelimitedTransportOptions {
    readonly maxHeaderBytes?: number;
    readonly maxContentLength?: number;
    readonly maxPendingMessages?: number;
}

/**
 * LSP "base protocol" framing over a Node Readable/Writable pair.
 *
 * The streams remain owned by the caller: close/dispose detach listeners but
 * never end, destroy, or otherwise take ownership of either stream.
 */
export class HeaderDelimitedTransport implements IMessageTransport {
    private _listener: ((message: JsonRpcMessage) => void) | undefined;
    private readonly _pending: JsonRpcMessage[] = [];
    private _residual = Buffer.alloc(0);
    private _expectedLength: number | undefined;
    private _closed = false;
    private _closeReason: string | undefined;
    private readonly _maxHeaderBytes: number;
    private readonly _maxContentLength: number;
    private readonly _maxPendingMessages: number;

    private readonly _onDataListener = (chunk: Buffer | string): void => this._onData(chunk);
    private readonly _onEndListener = (): void => this._onEnd();
    private readonly _onInputErrorListener = (error: Error): void =>
        this.close(`Header-delimited input error: ${error.message}`);
    private readonly _onOutputErrorListener = (error: Error): void =>
        this.close(`Header-delimited output error: ${error.message}`);

    public constructor(
        private readonly _input: NodeJS.ReadableStream,
        private readonly _output: NodeJS.WritableStream,
        private readonly _onClose?: (reason?: string) => void,
        options: HeaderDelimitedTransportOptions = {},
    ) {
        this._maxHeaderBytes = positiveLimit(
            options.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES, 'maxHeaderBytes',
        );
        this._maxContentLength = positiveLimit(
            options.maxContentLength, DEFAULT_MAX_CONTENT_LENGTH, 'maxContentLength',
        );
        this._maxPendingMessages = positiveLimit(
            options.maxPendingMessages, DEFAULT_MAX_PENDING_MESSAGES, 'maxPendingMessages',
        );
        _input.on('data', this._onDataListener);
        _input.on('end', this._onEndListener);
        _input.on('close', this._onEndListener);
        _input.on('error', this._onInputErrorListener);
        _output.on('error', this._onOutputErrorListener);
    }

    public get closed(): boolean {
        return this._closed;
    }

    public get closeReason(): string | undefined {
        return this._closeReason;
    }

    public send(message: JsonRpcMessage): Promise<void> {
        if (this._closed) {
            return Promise.reject(new Error(this._closeReason ?? 'Header-delimited transport is closed'));
        }
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        if (body.length > this._maxContentLength) {
            return Promise.reject(new Error(
                `Header-delimited payload exceeds ${this._maxContentLength} bytes`,
            ));
        }
        const wire = Buffer.concat([
            Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
            body,
        ]);
        return new Promise<void>((resolve, reject) => {
            this._output.write(wire, (error?: Error | null) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    public setListener(listener: ((message: JsonRpcMessage) => void) | undefined): void {
        this._listener = listener;
        while (this._listener && this._pending.length > 0) {
            this._listener(this._pending.shift()!);
        }
    }

    public dispose(): void {
        this.close('Header-delimited transport disposed');
    }

    public close(reason = 'Header-delimited transport closed'): void {
        if (this._closed) return;
        this._closed = true;
        this._closeReason = reason;
        this._input.off('data', this._onDataListener);
        this._input.off('end', this._onEndListener);
        this._input.off('close', this._onEndListener);
        this._input.off('error', this._onInputErrorListener);
        this._output.off('error', this._onOutputErrorListener);
        this._onClose?.(reason);
    }

    private _onData(chunk: Buffer | string): void {
        if (this._closed) return;
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        this._residual = this._residual.length === 0
            ? Buffer.from(bytes)
            : Buffer.concat([this._residual, bytes]);

        while (!this._closed) {
            if (this._expectedLength === undefined) {
                const headerEnd = this._residual.indexOf(HEADER_SEPARATOR);
                if (headerEnd < 0) {
                    if (this._residual.length > this._maxHeaderBytes) {
                        this.close(`Invalid header-delimited frame: header exceeds ${this._maxHeaderBytes} bytes`);
                    }
                    return;
                }
                if (headerEnd + HEADER_SEPARATOR.length > this._maxHeaderBytes) {
                    this.close(`Invalid header-delimited frame: header exceeds ${this._maxHeaderBytes} bytes`);
                    return;
                }
                try {
                    this._expectedLength = parseHeaders(
                        this._residual.subarray(0, headerEnd),
                        this._maxContentLength,
                    );
                } catch (error) {
                    this.close(`Invalid header-delimited frame: ${
                        error instanceof Error ? error.message : String(error)
                    }`);
                    return;
                }
                this._residual = this._residual.subarray(headerEnd + HEADER_SEPARATOR.length);
            }

            if (this._residual.length < this._expectedLength) return;
            const body = this._residual.subarray(0, this._expectedLength);
            this._residual = this._residual.subarray(this._expectedLength);
            this._expectedLength = undefined;
            let parsed: JsonRpcMessage;
            try {
                parsed = JSON.parse(body.toString('utf8')) as JsonRpcMessage;
            } catch (error) {
                this.close(`Invalid header-delimited JSON payload: ${
                    error instanceof Error ? error.message : String(error)
                }`);
                return;
            }
            this._deliver(parsed);
        }
    }

    private _onEnd(): void {
        if (this._closed) return;
        this.close(this._expectedLength !== undefined || this._residual.length > 0
            ? 'Truncated header-delimited frame'
            : 'Header-delimited input closed');
    }

    private _deliver(message: JsonRpcMessage): void {
        if (this._listener) {
            this._listener(message);
            return;
        }
        if (this._pending.length >= this._maxPendingMessages) {
            this.close(`Header-delimited pending message limit ${this._maxPendingMessages} exceeded`);
            return;
        }
        this._pending.push(message);
    }
}

function parseHeaders(headerBytes: Buffer, maxContentLength: number): number {
    const values = new Map<string, string>();
    for (const line of headerBytes.toString('ascii').split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0) throw new Error(`malformed header ${JSON.stringify(line)}`);
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (values.has(name)) throw new Error(`duplicate ${name} header`);
        values.set(name, value);
    }
    const rawLength = values.get('content-length');
    if (rawLength === undefined || !/^(0|[1-9]\d*)$/.test(rawLength)) {
        throw new Error('missing or invalid Content-Length header');
    }
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > maxContentLength) {
        throw new Error(`Content-Length exceeds ${maxContentLength} bytes`);
    }
    const contentType = values.get('content-type');
    if (contentType !== undefined && !isSupportedContentType(contentType)) {
        throw new Error(`unsupported Content-Type ${JSON.stringify(contentType)}`);
    }
    return length;
}

function isSupportedContentType(value: string): boolean {
    const parts = value.split(';').map((part) => part.trim().toLowerCase());
    return parts[0] === 'application/vscode-jsonrpc'
        && parts.slice(1).every((part) => /^charset\s*=\s*"?utf-?8"?$/.test(part));
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return result;
}
