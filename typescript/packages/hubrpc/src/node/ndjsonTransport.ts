import type { JsonRpcMessage } from '../protocol/jsonRpc';
import type { IMessageTransport } from '../transport/messageTransport';

/**
 * Newline-delimited JSON transport over a Node Readable/Writable pair.
 * One JSON value per line, both directions.
 *
 * Not LSP-style headers — those add no value for a private link between two
 * cooperating processes and require a length-prefixed framer.
 */
export class NdjsonTransport implements IMessageTransport {
    private _listener: ((m: JsonRpcMessage) => void) | undefined;
    private readonly _buffer: JsonRpcMessage[] = [];
    private _residual = '';
    private _closed = false;

    constructor(
        private readonly _input: NodeJS.ReadableStream,
        private readonly _output: NodeJS.WritableStream,
        private readonly _onClose?: () => void,
    ) {
        this._input.setEncoding?.('utf8');
        this._input.on('data', (chunk: string) => this._onData(chunk));
        this._input.on('end', () => this._onEnd());
        this._input.on('close', () => this._onEnd());
        this._input.on('error', () => this._onEnd());
        if (!Object.is(this._output, this._input)) {
            this._output.on('error', () => this._onEnd());
        }
    }

    public send(message: JsonRpcMessage): void {
        if (this._closed) return;
        this._output.write(JSON.stringify(message) + '\n');
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

    private _onData(chunk: string): void {
        this._residual += chunk;
        let nl: number;
        while ((nl = this._residual.indexOf('\n')) >= 0) {
            const line = this._residual.slice(0, nl).trim();
            this._residual = this._residual.slice(nl + 1);
            if (!line) continue;
            let parsed: JsonRpcMessage;
            try {
                parsed = JSON.parse(line) as JsonRpcMessage;
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
