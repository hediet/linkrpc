import type { LinkRpcConnection, StreamApi } from '@hediet/linkrpc';
import {
    consoleInterface,
    decodeConsoleData,
    encodeConsoleData,
    type ConsoleAttachParams,
    type ConsoleClientMessage,
    type ConsoleExit,
    type ConsoleInfo,
    type ConsoleMode,
    type ConsoleServerMessage,
    type ConsoleSignal,
    type ConsoleSize,
} from './consoleInterface';

/**
 * Handlers for a {@link ConsoleTemplate} instance: `resolve` maps the
 * instance's `params` to the selected console, and may throw if none matches.
 */
export function consoleHandlers<P>(resolve: (params: P) => ConsoleHost) {
    return {
        info: ({ params }: { readonly params: P }) => resolve(params).info(),
        attach: ({ params, ...options }: ConsoleAttachParams & { readonly params: P }, _context: unknown, stream: ConsoleStream) =>
            resolve(params).attach(options, stream),
    };
}

/**
 * Serves one `linkrpc.console` console. The owner reports process
 * events (`started`, `output`, `exited`, `finish`); attachments drive input
 * through the {@link ConsoleBackend}. The console may host successive processes
 * (restarts) until it is closed.
 */
export class ConsoleHost {
    private readonly _attachments = new Set<Attachment>();
    private readonly _history: ConsoleHistory;
    private _size: ConsoleSize | undefined;
    private _pid: number | undefined;
    private _running = false;
    private _exit: ConsoleExit | undefined;
    private _finished = false;
    private _closed = false;

    constructor(private readonly _options: ConsoleHostOptions) {
        this._history = _options.history ?? new OutputHistory();
        this._size = _options.mode === 'tty' ? _options.size ?? { cols: 80, rows: 24 } : undefined;
    }

    get mode(): ConsoleMode { return this._options.mode; }
    get size(): ConsoleSize | undefined { return this._size; }

    /** Serve this console as the standalone {@link consoleInterface}. */
    register(connection: LinkRpcConnection, serviceId: string): { dispose(): void } {
        return connection.register(consoleInterface, { console: consoleHandlers(() => this) }, { serviceId });
    }

    info(): ConsoleInfo {
        return {
            mode: this._options.mode,
            ...(this._size ? { size: this._size } : {}),
            signals: [...this._options.signals],
            running: this._running,
            ...(this._pid === undefined ? {} : { pid: this._pid }),
            ...(this._exit ? { exit: this._exit } : {}),
        };
    }

    started(pid?: number): void {
        this._running = true;
        this._pid = pid;
        this._finished = false;
        this._broadcast({ t: 'started', ...(pid === undefined ? {} : { pid }) });
    }

    output(stream: 'stdout' | 'stderr' | 'tty', data: Uint8Array): void {
        this._history.append({ type: 'output', stream, data });
        this._broadcast({ t: 'output', stream, data: encodeConsoleData(data) });
    }

    notice(text: string): void {
        this._history.append({ type: 'notice', text });
        this._broadcast({ t: 'notice', text });
    }

    exited(exit: ConsoleExit): void {
        this._running = false;
        this._pid = undefined;
        this._exit = exit;
        this._broadcast({ t: 'exit', ...exit });
    }

    /** No process runs and none is pending: current attachments complete. */
    finish(): void {
        this._finished = true;
        for (const attachment of this._attachments) attachment.end();
    }

    close(): void {
        if (this._closed) return;
        this._closed = true;
        this.finish();
        this._history.dispose?.();
    }

    resize(size: ConsoleSize): void {
        if (this._options.mode !== 'tty' || (this._size?.cols === size.cols && this._size.rows === size.rows)) return;
        this._size = { cols: size.cols, rows: size.rows };
        this._history.resize?.(this._size);
        try { this._options.backend.resize(this._size); } catch { /* applied at the next start */ }
        this._broadcast({ t: 'resized', ...this._size });
    }

    async attach(params: ConsoleAttachParams, stream: ConsoleStream): Promise<{ exit: ConsoleExit | null }> {
        if (this._closed) throw new Error('The console is closed');
        const interactive = params.interactive !== false;
        if (interactive && params.size) this.resize(params.size);
        const attachment = new Attachment(stream);
        this._attachments.add(attachment);
        try {
            // Registration and the snapshot call happen in one turn: later events are queued, earlier ones replayed.
            const header = this._header();
            const replay = await (params.replay === 'none' ? [] : this._history.snapshot());
            attachment.goLive([header, ...replay, { t: 'live' }]);
            if (!this._finished) {
                stream.onMessage(message => this._onClientMessage(attachment, interactive, message));
                await Promise.race([attachment.ended, aborted(stream.signal)]);
            }
            if (!stream.signal.aborted) await attachment.flush();
            return { exit: this._exit ?? null };
        } finally {
            this._attachments.delete(attachment);
        }
    }

    private _header(): ConsoleServerMessage {
        return {
            t: 'console',
            mode: this._options.mode,
            ...(this._size ? { size: this._size } : {}),
            signals: [...this._options.signals],
            running: this._running,
            ...(this._pid === undefined ? {} : { pid: this._pid }),
        };
    }

    private _onClientMessage(attachment: Attachment, interactive: boolean, message: ConsoleClientMessage): void {
        try {
            if (!interactive) throw new Error('This attachment is read-only');
            switch (message.t) {
                case 'input':
                    this._options.backend.write(decodeConsoleData(message.data));
                    break;
                case 'resize':
                    this.resize(message);
                    break;
                case 'signal':
                    if (!this._options.signals.includes(message.signal)) {
                        throw new Error(`${message.signal} is not supported by this console (supported: ${this._options.signals.join(', ') || 'none'})`);
                    }
                    this._options.backend.signal(message.signal);
                    break;
            }
        } catch (error) {
            attachment.deliver({ t: 'notice', text: error instanceof Error ? error.message : String(error) });
        }
    }

    private _broadcast(message: ConsoleServerMessage): void {
        for (const attachment of this._attachments) attachment.deliver(message);
    }
}

export interface ConsoleHostOptions {
    readonly mode: ConsoleMode;
    /** Signals {@link ConsoleBackend.signal} delivers with their usual meaning. */
    readonly signals: readonly ConsoleSignal[];
    readonly backend: ConsoleBackend;
    /** Initial TTY size; defaults to 80x24. */
    readonly size?: ConsoleSize;
    /** Defaults to a bounded {@link OutputHistory}. */
    readonly history?: ConsoleHistory;
}

/** Applies attachment input to the console's process. Methods may throw while none is running. */
export interface ConsoleBackend {
    write(data: Uint8Array): void;
    resize(size: ConsoleSize): void;
    signal(signal: ConsoleSignal): void;
}

export type ConsoleRecord =
    | { readonly type: 'output'; readonly stream: 'stdout' | 'stderr' | 'tty'; readonly data: Uint8Array }
    | { readonly type: 'notice'; readonly text: string };

/** Retains output so that new attachments can catch up. */
export interface ConsoleHistory {
    append(record: ConsoleRecord): void;
    resize?(size: ConsoleSize): void;
    /** Messages reproducing every record appended before this call, even if it completes later. */
    snapshot(): readonly ConsoleServerMessage[] | Promise<readonly ConsoleServerMessage[]>;
    dispose?(): void;
}

export type ConsoleStream = Pick<StreamApi<ConsoleClientMessage, ConsoleServerMessage>, 'signal' | 'send' | 'onMessage'>;

/** Replays the most recent output records up to a byte budget. */
export class OutputHistory implements ConsoleHistory {
    private readonly _messages: { readonly message: ConsoleServerMessage; readonly bytes: number }[] = [];
    private _bytes = 0;

    constructor(private readonly _maxBytes = 1024 * 1024) {}

    append(record: ConsoleRecord): void {
        const entry = record.type === 'output'
            ? { message: { t: 'output', stream: record.stream, data: encodeConsoleData(record.data) } as const, bytes: record.data.length }
            : { message: { t: 'notice', text: record.text } as const, bytes: record.text.length };
        this._messages.push(entry);
        this._bytes += entry.bytes;
        while (this._bytes > this._maxBytes && this._messages.length > 1) this._bytes -= this._messages.shift()!.bytes;
    }

    snapshot(): readonly ConsoleServerMessage[] {
        return this._messages.map(entry => entry.message);
    }
}

class Attachment {
    private _pending: ConsoleServerMessage[] | undefined = [];
    private _chain = Promise.resolve();
    private _end!: () => void;
    readonly ended = new Promise<void>(resolve => { this._end = resolve; });

    constructor(private readonly _stream: ConsoleStream) {}

    deliver(message: ConsoleServerMessage): void {
        if (this._pending) this._pending.push(message);
        else this._send(message);
    }

    goLive(prefix: readonly ConsoleServerMessage[]): void {
        const pending = this._pending ?? [];
        this._pending = undefined;
        for (const message of [...prefix, ...pending]) this._send(message);
    }

    flush(): Promise<void> { return this._chain; }
    end(): void { this._end(); }

    private _send(message: ConsoleServerMessage): void {
        // A failed send means the caller went away; its cancellation ends the attachment.
        this._chain = this._chain.then(() => this._stream.send(message)).catch(() => {});
    }
}

function aborted(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
    });
}
