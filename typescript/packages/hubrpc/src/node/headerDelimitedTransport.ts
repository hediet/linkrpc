import type { JsonRpcMessage } from '../protocol/jsonRpc';
import type { IMessageTransport } from '../transport/messageTransport';

const CRLF = '\r\n';
const HEADER_SEPARATOR = '\r\n\r\n';
const CONTENT_LENGTH = 'content-length';

/**
 * LSP "base protocol" framing over a Node Readable/Writable pair. Each
 * message is preceded by a `Content-Length: <bytes>\r\n\r\n` header block,
 * then exactly that many bytes of UTF-8 JSON.
 *
 * Unlike {@link NdjsonTransport}, the length prefix makes frame boundaries
 * explicit, so a malformed message is detectable rather than silently
 * resynchronised on the next newline. Use this when interoperating with
 * LSP-style tooling or when payloads may contain raw newlines.
 */
export class HeaderDelimitedTransport implements IMessageTransport {
    private _listener: ((m: JsonRpcMessage) => void) | undefined;
    private readonly _buffer: JsonRpcMessage[] = [];
    private _residual: Buffer = Buffer.alloc(0);
    private _closed = false;

    constructor(
        private readonly _input: NodeJS.ReadableStream,
        private readonly _output: NodeJS.WritableStream,
        private readonly _onClose?: () => void,
    ) {
        // Read raw bytes: Content-Length counts bytes, not UTF-8 code points.
        this._input.on('data', (chunk: Buffer | string) => this._onData(chunk));
        this._input.on('end', () => this._onEnd());
        this._input.on('close', () => this._onEnd());
    }

    public send(message: JsonRpcMessage): void {
        if (this._closed) return;
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        this._output.write(`Content-Length: ${body.length}${HEADER_SEPARATOR}`);
        this._output.write(body);
    }

    public setListener(listener: ((m: JsonRpcMessage) => void) | undefined): void {
        this._listener = listener;
        if (listener) {
            while (this._buffer.length > 0 && this._listener) {
                const m = this._buffer.shift()!;
                this._listener(m);
            }
        }
    }

    public dispose(): void {
        if (this._closed) return;
        this._closed = true;
        this._onClose?.();
    }

    private _onData(chunk: Buffer | string): void {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        this._residual = this._residual.length === 0 ? buf : Buffer.concat([this._residual, buf]);

        while (true) {
            const headerEnd = this._residual.indexOf(HEADER_SEPARATOR);
            if (headerEnd < 0) return;

            const headerText = this._residual.toString('utf8', 0, headerEnd);
            const contentLength = _parseContentLength(headerText);
            if (contentLength === undefined) {
                // Unrecoverable: we cannot know where this frame ends. Close
                // rather than silently misframing every subsequent message.
                this._onEnd();
                return;
            }

            const bodyStart = headerEnd + HEADER_SEPARATOR.length;
            const bodyEnd = bodyStart + contentLength;
            if (this._residual.length < bodyEnd) return; // wait for more bytes

            const body = this._residual.toString('utf8', bodyStart, bodyEnd);
            this._residual = this._residual.subarray(bodyEnd);

            let parsed: JsonRpcMessage;
            try {
                parsed = JSON.parse(body) as JsonRpcMessage;
            } catch {
                continue;
            }
            this._deliver(parsed);
        }
    }

    private _onEnd(): void {
        if (!this._closed) {
            this._closed = true;
            this._onClose?.();
        }
    }

    private _deliver(m: JsonRpcMessage): void {
        if (this._listener) this._listener(m);
        else this._buffer.push(m);
    }
}

function _parseContentLength(headerBlock: string): number | undefined {
    for (const line of headerBlock.split(CRLF)) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        if (line.slice(0, idx).trim().toLowerCase() !== CONTENT_LENGTH) continue;
        const value = Number.parseInt(line.slice(idx + 1).trim(), 10);
        if (Number.isInteger(value) && value >= 0) return value;
    }
    return undefined;
}
