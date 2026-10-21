import {
    decodeConsoleData,
    encodeConsoleData,
    type ConsoleClientMessage,
    type ConsoleExit,
    type ConsoleMode,
    type ConsoleServerMessage,
    type ConsoleSignal,
    type ConsoleSize,
} from '@hediet/linkrpc-infra/console';
import { ServiceConsoleInput } from './serviceConsoleInput';

/** An in-flight console attach call: typed streaming calls and adapted raw calls both satisfy it. */
export interface ConsoleCall extends PromiseLike<{ readonly exit: ConsoleExit | null }> {
    send(message: ConsoleClientMessage): unknown;
    cancel(): unknown;
}

export interface ConsoleSessionOptions {
    /** Forward local input, resizes, and interrupts. */
    readonly interactive: boolean;
    /** Closing the session stops the process (foreground ownership). */
    readonly owner: boolean;
    /** Close after replay, for one-shot log output. */
    readonly untilLive?: boolean;
    readonly reattachCommand?: string;
    /** Detaches a TTY attachment; defaults to {@link DEFAULT_DETACH_KEYS}. */
    readonly detachKeys?: DetachKeys;
    /** Aborting closes the session locally. */
    readonly signal?: AbortSignal;
}

export interface ConsoleSessionResult {
    readonly exit: ConsoleExit | null;
    /** The session was closed by this side (detach, ownership release, or abort) rather than by the console. */
    readonly closedLocally: boolean;
}

/**
 * Drive a `linkrpc.console` attachment (or a stream embedding its protocol):
 * render output, and configure local input from the console's mode. TTY
 * consoles get raw keystrokes, so detaching uses a key sequence (see
 * {@link DetachKeys}); pipe consoles get local line editing, and Ctrl+D on an
 * empty line detaches.
 */
export async function runConsoleSession<TExtra extends { readonly t: string }>(
    start: (onMessage: (message: ConsoleServerMessage | TExtra) => void) => ConsoleCall,
    options: ConsoleSessionOptions,
    onExtra?: (message: TExtra) => void,
): Promise<ConsoleSessionResult> {
    const session = new ConsoleSession(options, onExtra);
    return session.run(start);
}

/** Local terminal size, sent so that TTY consoles match this terminal. */
export function localTerminalSize(): ConsoleSize | undefined {
    const { columns, rows } = process.stdout;
    return process.stdout.isTTY && columns > 0 && rows > 0 ? { cols: columns, rows } : undefined;
}

/**
 * A detach key sequence in Docker's `--detach-keys` syntax: comma-separated
 * keys, each a single character or `ctrl-<key>` with `<key>` in `a`-`z`, `@`,
 * `[`, `\`, `]`, `^`, or `_`. For example `ctrl-b,d` or `ctrl-p,ctrl-q`.
 */
export class DetachKeys {
    private constructor(readonly spec: string, readonly bytes: Uint8Array) {}

    static parse(spec: string): DetachKeys {
        const bytes = spec.split(',').map(part => {
            const key = part.trim();
            const ctrl = /^ctrl-(.)$/i.exec(key);
            if (ctrl) {
                const index = '@abcdefghijklmnopqrstuvwxyz[\\]^_'.indexOf(ctrl[1]!.toLowerCase());
                if (index >= 0) return index;
            } else if (key.length === 1 && key.charCodeAt(0) >= 0x20 && key.charCodeAt(0) < 0x7f) {
                return key.charCodeAt(0);
            }
            throw new Error(`Invalid detach key "${key}" in "${spec}": use a character or ctrl-<a-z, @, [, \\, ], ^, _>, separated by commas`);
        });
        if (bytes.length === 0) throw new Error('The detach key sequence is empty');
        return new DetachKeys(spec, Uint8Array.from(bytes));
    }

    /** Human-readable form, e.g. `Ctrl+B, then d`. */
    get label(): string {
        return [...this.bytes].map(byte => byte < 0x20 ? `Ctrl+${String.fromCharCode(byte + 0x40)}` : String.fromCharCode(byte)).join(', then ');
    }
}

/** Ctrl+B, then d (tmux's binding): unlike Docker's Ctrl+P, Ctrl+Q, it reaches programs in VS Code's terminal. */
export const DEFAULT_DETACH_KEYS = DetachKeys.parse('ctrl-b,d');

/**
 * Recognizes a detach sequence in raw keyboard input. Bytes of a partial match
 * are held back, and forwarded unchanged when the sequence does not complete.
 */
export class DetachKeyFilter {
    private _matched = 0;

    constructor(private readonly _keys: DetachKeys = DEFAULT_DETACH_KEYS) {}

    push(chunk: Uint8Array): { readonly forward: Uint8Array; readonly detach: boolean } {
        const sequence = this._keys.bytes;
        const forward: number[] = [];
        for (const byte of chunk) {
            // Keep the longest suffix of the pending keys that still starts the sequence.
            const pending = [...sequence.subarray(0, this._matched), byte];
            let start = 0;
            while (start < pending.length && !pending.slice(start).every((value, index) => value === sequence[index])) start++;
            forward.push(...pending.slice(0, start));
            this._matched = pending.length - start;
            if (this._matched === sequence.length) {
                this._matched = 0;
                return { forward: Uint8Array.from(forward), detach: true };
            }
        }
        return { forward: Uint8Array.from(forward), detach: false };
    }
}

const ALTERNATE_SCREEN = /\x1b\[\?(?:1049|1047|47)([hl])/g;
/** Undo terminal modes a program may have enabled: mouse, bracketed paste, focus, win32-input, hidden cursor. */
const TERMINAL_RESET = '\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[?9001l';

class ConsoleSession<TExtra extends { readonly t: string }> {
    private _call: ConsoleCall | undefined;
    private readonly _detachKeys: DetachKeys;
    private _mode: ConsoleMode | undefined;
    private _signals: readonly ConsoleSignal[] = [];
    private _input: { dispose(): void } | undefined;
    private _raw = false;
    private _alternateScreen = false;
    private _closedLocally = false;

    constructor(
        private readonly _options: ConsoleSessionOptions,
        private readonly _onExtra: ((message: TExtra) => void) | undefined,
    ) {
        this._detachKeys = _options.detachKeys ?? DEFAULT_DETACH_KEYS;
    }

    async run(start: (onMessage: (message: ConsoleServerMessage | TExtra) => void) => ConsoleCall): Promise<ConsoleSessionResult> {
        const onSignal = () => this._interrupt();
        const onTerminate = () => this.close();
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onTerminate);
        this._options.signal?.addEventListener('abort', onTerminate);
        try {
            this._call = start(message => this._onMessage(message));
            if (this._closedLocally || this._options.signal?.aborted) this.close();
            let exit: ConsoleExit | null = null;
            try {
                exit = (await this._call).exit;
            } catch (error) {
                if (!this._closedLocally) throw error;
            }
            return { exit, closedLocally: this._closedLocally };
        } finally {
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onTerminate);
            this._options.signal?.removeEventListener('abort', onTerminate);
            this._input?.dispose();
            if (this._raw) {
                process.stdout.write(TERMINAL_RESET + (this._alternateScreen ? '\x1b[?1049l' : '') + '\r\n');
            }
            if (this._closedLocally && this._options.interactive && !this._options.owner && this._options.reattachCommand) {
                process.stderr.write(`Detached. Reattach: ${this._options.reattachCommand}\n`);
            }
        }
    }

    close(): void {
        this._closedLocally = true;
        try { void Promise.resolve(this._call?.cancel()).catch(() => {}); } catch { /* already settled */ }
    }

    private _onMessage(message: ConsoleServerMessage | TExtra): void {
        const console = message as ConsoleServerMessage;
        switch (console.t) {
            case 'console':
                this._mode = console.mode;
                this._signals = console.signals;
                this._startInput();
                return;
            case 'screen': {
                const screen = decodeConsoleData(console.data);
                if (screen.length > 0 && process.stdout.isTTY) process.stdout.write('\x1b[H\x1b[2J');
                this._write(process.stdout, screen);
                return;
            }
            case 'output':
                this._write(console.stream === 'stderr' ? process.stderr : process.stdout, decodeConsoleData(console.data));
                return;
            case 'notice':
                process.stderr.write(this._mode === 'tty' ? `\r\n[console] ${console.text}\r\n` : `${console.text}\n`);
                return;
            case 'live':
                if (this._options.untilLive) this.close();
                return;
            case 'started':
            case 'exit':
            case 'resized':
                return;
        }
        this._onExtra?.(message as TExtra);
    }

    private _write(stream: NodeJS.WriteStream, data: Uint8Array): void {
        if (this._mode === 'tty') {
            for (const match of new TextDecoder().decode(data).matchAll(ALTERNATE_SCREEN)) this._alternateScreen = match[1] === 'h';
        }
        stream.write(data);
    }

    private _startInput(): void {
        if (!this._options.interactive || this._input) return;
        const owner = this._options.owner;
        const reattach = this._options.reattachCommand;
        if (this._mode === 'tty') {
            process.stderr.write(owner
                ? `Foreground (TTY). Keys go to the program; ${this._detachKeys.label} stops and removes the service.\n`
                : `Attached (TTY). Keys go to the program; ${this._detachKeys.label} detaches.\n`);
        } else {
            const interrupt = owner ? 'Ctrl+C or ' : this._signals.includes('SIGINT') ? 'Ctrl+C interrupts; ' : '';
            process.stderr.write(owner
                ? `Foreground (pipe console). ${interrupt}Ctrl+D on an empty line stops and removes the service.\n`
                : `Attached (pipe console). ${interrupt}Ctrl+D on an empty line detaches.\n`);
        }
        if (reattach) process.stderr.write(`${owner ? 'Attach from another terminal while running' : 'Reattach'}: ${reattach}\n`);
        this._input = this._mode === 'tty' ? this._startTerminalInput() : this._startLineInput();
    }

    private _startTerminalInput(): { dispose(): void } {
        const stdin = process.stdin;
        const filter = stdin.isTTY ? new DetachKeyFilter(this._detachKeys) : undefined;
        const wasRaw = stdin.isRaw;
        if (stdin.isTTY) {
            stdin.setRawMode(true);
            this._raw = true;
        }
        const onData = (chunk: Buffer) => {
            const { forward, detach } = filter ? filter.push(chunk) : { forward: chunk, detach: false };
            if (forward.length > 0) this._send({ t: 'input', data: encodeConsoleData(forward) });
            if (detach) this.close();
        };
        const onResize = () => {
            const size = localTerminalSize();
            if (size) this._send({ t: 'resize', ...size });
        };
        stdin.on('data', onData);
        stdin.resume();
        process.stdout.on('resize', onResize);
        return {
            dispose: () => {
                stdin.removeListener('data', onData);
                process.stdout.removeListener('resize', onResize);
                if (stdin.isTTY) stdin.setRawMode(wasRaw);
                stdin.pause();
                stdin.unref?.();
            },
        };
    }

    private _startLineInput(): { dispose(): void } {
        return new ServiceConsoleInput(
            process.stdin, process.stderr,
            data => this._send({ t: 'input', data: encodeConsoleData(new TextEncoder().encode(data)) }),
            () => this._interrupt(),
            () => this.close(),
        );
    }

    private _interrupt(): void {
        if (this._options.owner || !this._options.interactive) {
            this.close();
        } else if (this._mode === 'tty') {
            this._send({ t: 'input', data: encodeConsoleData(Uint8Array.of(0x03)) });
        } else if (this._signals.includes('SIGINT')) {
            this._send({ t: 'signal', signal: 'SIGINT' });
        } else {
            process.stderr.write('Interrupting is not supported for pipe processes on this host; run with -t for a terminal. Ctrl+D on an empty line detaches.\n');
        }
    }

    private _send(message: ConsoleClientMessage): void {
        try { void Promise.resolve(this._call?.send(message)).catch(() => {}); } catch { /* the call ended */ }
    }
}
